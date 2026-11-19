// offscreen.js  [off1.7]
//
// Runs in an offscreen document (an extension page): fetch() bypasses CORS for
// hosts in host_permissions, and URL.createObjectURL / WebCrypto / WebAssembly
// are available. Auth (cookies/referer) is attached by declarativeNetRequest
// session rules the service worker installs, so we fetch with credentials omitted.
//
// Jobs are queued and run one at a time (bounded memory, no ffmpeg contention).
// The service worker is NOT kept waiting on a long-lived response: we ack the
// request immediately, stream "offscreen:progress" messages, and finish with a
// separate "offscreen:done" message (which also wakes a terminated worker).
//
// Pipeline:
//   - master playlist -> pick video variant (per quality) + its audio rendition
//   - download + decrypt all segments (byte ranges supported) into Blob parts,
//     so the video never has to sit in the JS heap as one big array
//   - ffmpeg.wasm `-c copy` into a proper MP4 (inputs mounted via WORKERFS, so
//     only the output lives in the wasm heap); mux.js / raw fMP4 as fallbacks

const TAG = "[off1.7]";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only the service worker (an extension page, not a content script) may drive us.
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  switch (msg?.type) {
    case "offscreen:assemble":
      enqueue(msg.jobId, msg.item || {});
      sendResponse({ accepted: true });
      return;
    case "offscreen:cancel":
      cancelJob(msg.jobId);
      sendResponse({ ok: true });
      return;
    case "offscreen:revoke":
      try {
        URL.revokeObjectURL(msg.blobUrl);
      } catch {}
      sendResponse({ ok: true });
      return;
    case "offscreen:status":
      sendResponse({ active: active?.id || null, queued: queue.map((j) => j.id) });
      return;
  }
});

function post(msg) {
  return chrome.runtime.sendMessage(msg);
}

// Completion must reach the service worker; retry briefly if it's mid-restart.
async function postDone(msg) {
  for (let i = 0; i < 4; i++) {
    try {
      await post(msg);
      return;
    } catch {
      await sleep(500 * (i + 1));
    }
  }
}

// ------------------------------------------------------------------ job queue
const queue = []; // { id, item, ctrl }
let active = null;

function enqueue(id, item) {
  if (!id || active?.id === id || queue.some((j) => j.id === id)) return; // idempotent
  queue.push({ id, item, ctrl: new AbortController(), stage: "queued" });
  if (active) post({ type: "offscreen:progress", jobId: id, stage: "queued", done: 0, total: 0 }).catch(() => {});
  pump();
}

function cancelJob(id) {
  const i = queue.findIndex((j) => j.id === id);
  if (i >= 0) {
    queue.splice(i, 1);
    postDone({ type: "offscreen:done", jobId: id, ok: false, canceled: true, error: "Canceled" });
    return;
  }
  if (active?.id === id) {
    active.ctrl.abort();
    // ffmpeg.exec can't be interrupted; kill the worker (it's reloaded on demand).
    if (active.stage === "mux") resetFFmpeg();
  }
}

async function pump() {
  if (active || !queue.length) return;
  const job = (active = queue.shift());
  try {
    const r = await assemble(job);
    const blobUrl = URL.createObjectURL(r.blob);
    await postDone({ type: "offscreen:done", jobId: job.id, ok: true, blobUrl, ext: r.ext, mode: r.mode, size: r.blob.size });
  } catch (e) {
    const canceled = job.ctrl.signal.aborted;
    await postDone({
      type: "offscreen:done",
      jobId: job.id,
      ok: false,
      canceled,
      error: canceled ? "Canceled" : e?.message || String(e),
      httpStatus: e?.status || 0,
      network: !!e?.network,
      auth: !!e?.auth,
    });
  } finally {
    active = null;
    pump();
  }
}

// Per-job progress: only message when the percent changes (or ~1s passed), so
// hundreds of segment ticks don't each wake the service worker. These messages
// also keep the worker alive during long downloads.
function reporter(job) {
  let lastPct = -1;
  let lastAt = 0;
  return (stage, done, total) => {
    job.stage = stage;
    const pct = total ? Math.floor((done / total) * 100) : 0;
    const now = Date.now();
    if (pct === lastPct && now - lastAt < 1000) return;
    lastPct = pct;
    lastAt = now;
    post({ type: "offscreen:progress", jobId: job.id, stage, done, total }).catch(() => {});
  };
}

// -------------------------------------------------------------------- fetching
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpError(label, url, status, body) {
  let host = "?";
  try {
    host = new URL(url).hostname;
  } catch {}
  const e = new Error(`${TAG} ${label} (${status}) @ ${host}${body ? " :: " + body : ""}`);
  e.status = status;
  return e;
}

// Fetch with retries on transient failures (network errors, timeouts, 408/429/5xx)
// so a single flaky segment doesn't abort a long download. On success the
// attempt stays armed while the body streams: a cancel aborts it, and so does
// `timeoutMs` without any data (call res.kick() per chunk, res.release() at the end).
async function fetchOk(url, label, { signal, headers, attempts = 4, timeoutMs = 60000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const release = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    let res;
    try {
      res = await fetch(url, { credentials: "omit", headers, signal: ctrl.signal });
    } catch (e) {
      release();
      if (signal?.aborted) throw e;
      lastErr = new Error(`${TAG} ${label}: ${ctrl.signal.aborted ? "timed out" : e?.message || e}`);
      lastErr.network = true;
      await sleep(400 * 2 ** i);
      continue;
    }
    if (res.ok) {
      res.kick = () => {
        clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(), timeoutMs);
      };
      res.release = release;
      return res;
    }
    let body = "";
    try {
      body = (await res.text()).slice(0, 140).replace(/\s+/g, " ");
    } catch {} finally {
      release();
    }
    lastErr = httpError(label, url, res.status, body);
    if (res.status !== 408 && res.status !== 429 && res.status < 500) throw lastErr;
    const retryAfter = parseInt(res.headers.get("retry-after") || "", 10);
    await sleep(retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 400 * 2 ** i);
  }
  throw lastErr;
}

// Stream a response body, feeding each chunk to onChunk and keeping the
// inactivity timer alive. A failure that isn't a cancel is marked `network`.
async function readBody(res, onChunk, signal) {
  try {
    if (!res.body) {
      onChunk(new Uint8Array(await res.arrayBuffer()));
      return;
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      res.kick?.();
      onChunk(value);
    }
  } catch (e) {
    if (!signal?.aborted) e.network = true;
    throw e;
  } finally {
    res.release?.();
  }
}

function concatChunks(chunks, n) {
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out.buffer;
}

// Fetch a (small) resource fully. With a [start, end] range, also reports
// whether the server ignored Range and sent the whole file (`whole`).
async function fetchRange(url, label, { signal, range } = {}) {
  const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : undefined;
  for (let i = 0; ; i++) {
    const res = await fetchOk(url, label, { signal, headers });
    const chunks = [];
    let n = 0;
    try {
      await readBody(res, (c) => (chunks.push(c), (n += c.byteLength)), signal);
      const buf = concatChunks(chunks, n);
      if (range && res.status === 200) return { buf: buf.slice(range[0], range[1] + 1), whole: buf };
      return { buf };
    } catch (e) {
      // Body interrupted mid-stream: retry the whole request a couple of times.
      if (signal?.aborted || i >= 2) throw e;
      await sleep(400 * 2 ** i);
    }
  }
}
async function fetchBytes(url, label, opts) {
  return (await fetchRange(url, label, opts)).buf;
}
async function fetchText(url, label, opts) {
  return new TextDecoder().decode(await fetchBytes(url, label, opts));
}

// ------------------------------------------------------------------- assembly
async function assemble(job) {
  const { item } = job;
  const rep = reporter(job);
  if (item.kind === "file") {
    const blob = await fetchFile(item.url, rep, job.ctrl.signal);
    return { blob, ext: extFromUrl(item.url, ".mp4"), mode: "direct" };
  }
  return assembleHls(item.url, item.quality, rep, job);
}

// A sign-in / error page instead of media usually means our cookies weren't
// accepted: flag it so the service worker can retry inside the page's frame.
function authError(label, what) {
  return Object.assign(new Error(`${TAG} ${label}: got ${what} instead of video (sign-in page?)`), { auth: true });
}

// Direct file: stream the body into modest Blob chunks (the browser can page
// those to disk) while reporting byte progress.
async function fetchFile(url, rep, signal) {
  const res = await fetchOk(url, "Download failed", { signal });
  const type = res.headers.get("content-type") || "video/mp4";
  if (/^\s*text\/html/i.test(type)) {
    res.release();
    res.body?.cancel().catch(() => {});
    throw authError("Download failed", "a web page");
  }
  const total = parseInt(res.headers.get("content-length") || "0", 10) || 0;
  const parts = [];
  let chunk = [];
  let chunkBytes = 0;
  let done = 0;
  await readBody(
    res,
    (value) => {
      chunk.push(value);
      chunkBytes += value.byteLength;
      done += value.byteLength;
      if (chunkBytes >= 16 << 20) {
        parts.push(new Blob(chunk));
        chunk = [];
        chunkBytes = 0;
      }
      rep("download", done, total);
    },
    signal
  );
  if (chunk.length) parts.push(new Blob(chunk));
  return new Blob(parts, { type });
}

// --------------------------------------------------------------- HLS helpers
function resolveUrl(base, ref) {
  return new URL(ref, base).href;
}
function searchOf(u) {
  try {
    return new URL(u).search || "";
  } catch {
    return "";
  }
}
// CloudFront/Loom sign the playlist with a query string that must be carried
// onto every child request (variant, segments, key) that lacks its own.
function applySign(url, query) {
  if (!query) return url;
  try {
    return new URL(url).search ? url : url + query;
  } catch {
    return url;
  }
}
function parseAttributes(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) attrs[m[1]] = m[3] ?? m[2];
  return attrs;
}
// "<length>[@<offset>]" -> { len, off } (off undefined = continues previous range)
function parseByteRange(v) {
  const m = /^\s*(\d+)(?:@(\d+))?/.exec(v || "");
  return m ? { len: parseInt(m[1], 10), off: m[2] != null ? parseInt(m[2], 10) : undefined } : null;
}

// Choose a variant for the requested quality: "highest" (default), "lowest",
// or a target height ("1080"/"720"/"480") -> the variant closest to it.
// "Height" is the short side, so a portrait 1080x1920 recording counts as 1080p.
function chooseVariant(variants, quality) {
  // Audio-only ladder entries (CODECS without video, no RESOLUTION) aren't videos.
  const video = variants.filter((v) => v.height || !/^\s*mp4a[^,]*$/i.test(v.codecs || ""));
  if (video.length) variants = video;
  if (!variants.length) return null;
  const byBw = [...variants].sort((a, b) => a.bw - b.bw);
  if (quality === "lowest") return byBw[0];
  if (quality === "highest" || !quality) return byBw[byBw.length - 1];
  const target = parseInt(quality, 10);
  if (!target) return byBw[byBw.length - 1];
  const withH = byBw.filter((v) => v.height);
  if (!withH.length) return byBw[byBw.length - 1];
  // Prefer the largest variant at or below the target; else the smallest above.
  const atOrBelow = withH.filter((v) => v.height <= target);
  return atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : withH[0];
}

// Within a set of audio renditions prefer DEFAULT=YES, then AUTOSELECT=YES.
function pickAudio(list) {
  return list.find((x) => x.def) || list.find((x) => x.auto) || list[0] || null;
}

// From a master playlist, pick a video variant (per quality) and its audio rendition.
function parseMaster(text, baseUrl, signQuery, quality) {
  const lines = text.split(/\r?\n/);
  const audios = [];
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].trim();
    if (L.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttributes(L);
      if ((a.TYPE || "").toUpperCase() === "AUDIO" && a.URI) {
        audios.push({
          group: a["GROUP-ID"],
          def: (a.DEFAULT || "").toUpperCase() === "YES",
          auto: (a.AUTOSELECT || "").toUpperCase() === "YES",
          uri: a.URI,
        });
      }
    } else if (L.startsWith("#EXT-X-STREAM-INF")) {
      const a = parseAttributes(L);
      const bw = parseInt(a.BANDWIDTH || "0", 10);
      const uri = (lines[i + 1] || "").trim();
      const [w, h] = (a.RESOLUTION || "").split("x").map((n) => parseInt(n, 10) || 0);
      const height = w && h ? Math.min(w, h) : h;
      if (uri && !uri.startsWith("#")) variants.push({ bw, uri, audio: a.AUDIO, height, codecs: a.CODECS || "" });
    }
  }
  const best = chooseVariant(variants, quality);
  if (!best) return null;
  const videoUrl = applySign(resolveUrl(baseUrl, best.uri), signQuery);
  let audioUrl = null;
  if (audios.length) {
    const inGroup = best.audio ? audios.filter((x) => x.group === best.audio) : [];
    const m = pickAudio(inGroup) || pickAudio(audios);
    if (m) audioUrl = applySign(resolveUrl(baseUrl, m.uri), signQuery);
  }
  return { videoUrl, audioUrl };
}

// Parse a media playlist into segment descriptors (no fetching yet).
function parseMediaPlaylist(text, mediaUrl, parentSign) {
  const signQuery = searchOf(mediaUrl) || parentSign;
  const lines = text.split(/\r?\n/);
  const segments = [];
  // Keys by KEYFORMAT: a playlist may list the same segments under several key
  // systems (e.g. identity AES-128 + a DRM one); we can only use "identity".
  const keys = new Map();
  let init = null;
  let mediaSequence = 0;
  let pendingRange = null;
  const rangeEnd = new Map(); // url -> end offset of its previous byte range
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
      mediaSequence = parseInt(line.split(":")[1] || "0", 10) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = parseByteRange(line.slice(17));
      continue;
    }
    if (line.startsWith("#EXT-X-MAP")) {
      const a = parseAttributes(line);
      if (a.URI) {
        const br = parseByteRange(a.BYTERANGE);
        init = {
          url: applySign(resolveUrl(mediaUrl, a.URI), signQuery),
          range: br ? [br.off || 0, (br.off || 0) + br.len - 1] : null,
          // An AES-128 key declared before the map encrypts the init section too.
          key: keys.get("identity") || null,
        };
      }
      continue;
    }
    if (line.startsWith("#EXT-X-KEY")) {
      const a = parseAttributes(line);
      const method = (a.METHOD || "NONE").toUpperCase();
      if (method === "NONE") {
        keys.clear();
      } else {
        keys.set((a.KEYFORMAT || "identity").toLowerCase(), {
          method,
          uri: a.URI ? applySign(resolveUrl(mediaUrl, a.URI), signQuery) : null,
          iv: a.IV || null,
        });
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    const url = applySign(resolveUrl(mediaUrl, line), signQuery);
    let range = null;
    if (pendingRange) {
      const start = pendingRange.off ?? rangeEnd.get(url) ?? 0;
      range = [start, start + pendingRange.len - 1];
      rangeEnd.set(url, start + pendingRange.len);
      pendingRange = null;
    }
    const key = keys.has("identity") ? keys.get("identity") : keys.values().next().value || null;
    segments.push({ url, range, key, seq: mediaSequence + segments.length });
  }
  return { segments, init, isFmp4: !!init };
}

async function loadMediaPlaylist(url, parentSign, label, signal) {
  const text = await fetchText(url, label, { signal });
  if (!/^\s*#EXTM3U/.test(text)) throw /^\s*</.test(text) ? authError(label, "a web page") : new Error(`${TAG} ${label}: not an HLS playlist`);
  return parseMediaPlaylist(text, url, parentSign);
}

// Fetch + decrypt every segment of a parsed media playlist. Returns Blob parts
// in order (init segment first), not one giant Uint8Array.
async function fetchStream(parsed, tick, signal, concurrency) {
  // Cache the *promise* so concurrent workers share one key fetch per URI.
  const keyCache = new Map();
  function getKey(uri) {
    if (!keyCache.has(uri)) {
      keyCache.set(
        uri,
        (async () => {
          const buf = await fetchBytes(uri, "Key fetch failed", { signal });
          return crypto.subtle.importKey("raw", buf, "AES-CBC", false, ["decrypt"]);
        })()
      );
    }
    return keyCache.get(uri);
  }
  function ivFor(ki, seq) {
    const b = new Uint8Array(16);
    if (ki.iv) {
      const hex = ki.iv.replace(/^0x/i, "").padStart(32, "0").slice(-32);
      for (let i = 0; i < 16; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
      return b;
    }
    new DataView(b.buffer).setUint32(12, seq >>> 0, false);
    return b;
  }

  const segs = parsed.segments;
  for (const s of segs) {
    if (s.key && s.key.method !== "AES-128") {
      throw new Error(`This stream is DRM-protected (${s.key.method}) and can't be saved.`);
    }
    if (s.key && !s.key.uri) throw new Error("Encrypted stream without a key URI.");
  }
  const results = new Array(segs.length);

  // Byte-range segments: if the server ignores Range (sends the whole file),
  // keep that one copy and slice it for every other range of the same URL.
  const rangeMode = new Map(); // url -> Promise<Blob | null>
  async function segmentBytes(s, label) {
    if (!s.range) return fetchBytes(s.url, label, { signal });
    if (!rangeMode.has(s.url)) {
      let settle;
      rangeMode.set(s.url, new Promise((r) => (settle = r)));
      try {
        const { buf, whole } = await fetchRange(s.url, label, { signal, range: s.range });
        settle(whole ? new Blob([whole]) : null);
        return buf;
      } catch (e) {
        settle(null);
        throw e;
      }
    }
    const whole = await rangeMode.get(s.url);
    if (whole) return whole.slice(s.range[0], s.range[1] + 1).arrayBuffer();
    return fetchBytes(s.url, label, { signal, range: s.range });
  }

  let initBlob = null;
  if (parsed.init) {
    let buf = await fetchBytes(parsed.init.url, "Init segment failed", { signal, range: parsed.init.range });
    const k = parsed.init.key;
    if (k && k.method === "AES-128" && k.uri) {
      buf = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivFor(k, 0) }, await getKey(k.uri), buf);
    }
    initBlob = new Blob([buf]);
    tick();
  }

  // Download segments with bounded concurrency, storing each by index so the
  // final order is preserved. CDNs serve these over HTTP/2, so a dozen or so
  // streams multiplex over few connections without tripping limits.
  let next = 0;
  let failed = null;
  async function worker() {
    while (!failed) {
      const i = next++;
      if (i >= segs.length) return;
      const s = segs[i];
      try {
        let buf = await segmentBytes(s, `Segment ${i + 1}/${segs.length} failed`);
        if (s.key) {
          const k = await getKey(s.key.uri);
          buf = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivFor(s.key, s.seq) }, k, buf);
        }
        results[i] = new Blob([buf]);
      } catch (e) {
        failed ||= e;
        return;
      }
      tick();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, segs.length) }, worker));
  if (failed) throw failed;
  return initBlob ? [initBlob, ...results] : results;
}

async function assembleHls(playlistUrl, quality, rep, job) {
  // Aborted by a cancel (job.ctrl) or when either stream fails, so the other
  // stream's workers stop fetching instead of running on in the background.
  const inner = new AbortController();
  const signal = inner.signal;
  if (job.ctrl.signal.aborted) inner.abort();
  job.ctrl.signal.addEventListener("abort", () => inner.abort(), { once: true });
  try {
    return await assembleHlsInner(playlistUrl, quality, rep, job, signal);
  } finally {
    inner.abort();
  }
}

async function assembleHlsInner(playlistUrl, quality, rep, job, signal) {
  const masterText = await fetchText(playlistUrl, "Playlist fetch failed", { signal });
  if (!/^\s*#EXTM3U/.test(masterText)) {
    if (/^\s*</.test(masterText)) throw authError("Playlist fetch failed", "a web page");
    throw new Error(`${TAG} Not an HLS playlist (got ${masterText.slice(0, 40).replace(/\s+/g, " ")}…)`);
  }
  const signQuery = searchOf(playlistUrl);

  let videoUrl = playlistUrl;
  let audioUrl = null;
  let video;
  if (/#EXT-X-STREAM-INF/.test(masterText)) {
    const m = parseMaster(masterText, playlistUrl, signQuery, quality);
    if (!m) throw new Error("No variant streams found in master playlist.");
    videoUrl = m.videoUrl;
    audioUrl = m.audioUrl;
  } else {
    video = parseMediaPlaylist(masterText, playlistUrl, signQuery);
  }

  // Warm up ffmpeg while the network is busy: the ~32MB wasm load/compile then
  // overlaps the segment downloads instead of running after them.
  loadFFmpeg().catch(() => {});

  let audio = null;
  [video, audio] = await Promise.all([
    video || loadMediaPlaylist(videoUrl, signQuery, "Variant fetch failed", signal),
    audioUrl ? loadMediaPlaylist(audioUrl, signQuery, "Audio fetch failed", signal) : null,
  ]);
  if (!video.segments.length) throw new Error("No media segments found in playlist.");
  if (audio && !audio.segments.length) audio = null;

  const total = video.segments.length + (video.init ? 1 : 0) + (audio ? audio.segments.length + (audio.init ? 1 : 0) : 0);
  let done = 0;
  const tick = () => rep("download", ++done, total);
  rep("download", 0, total);

  const [videoParts, audioParts] = await Promise.all([
    fetchStream(video, tick, signal, audio ? 12 : 16),
    audio ? fetchStream(audio, tick, signal, 6) : null,
  ]);
  const vExt = video.isFmp4 ? "mp4" : "ts";

  // Separate audio track -> mux video + audio with ffmpeg (lossless copy).
  if (audioParts) {
    rep("mux", 0, 100);
    const out = await ffmpegRemux(
      job,
      [
        { name: "v." + vExt, blob: new Blob(videoParts) },
        { name: "a." + (audio.isFmp4 ? "mp4" : "ts"), blob: new Blob(audioParts) },
      ],
      ["-map", "0:v:0", "-map", "1:a:0"],
      rep
    );
    return { blob: out, ext: ".mp4", mode: "av-mux" };
  }

  // Single stream (video with muxed audio): remux to a regular MP4 so players
  // get a real duration/seek index. Fall back to the lighter paths if ffmpeg
  // can't (e.g. the output wouldn't fit its 2GB heap).
  const whole = new Blob(videoParts);
  rep("mux", 0, 100);
  try {
    const out = await ffmpegRemux(job, [{ name: "v." + vExt, blob: whole }], ["-map", "0:v?", "-map", "0:a?"], rep);
    return { blob: out, ext: ".mp4", mode: video.isFmp4 ? "fmp4-mp4" : "hls-mp4" };
  } catch (e) {
    if (signal.aborted) throw e;
    if (video.isFmp4) return { blob: new Blob(videoParts, { type: "video/mp4" }), ext: ".mp4", mode: "fmp4" };
    const mp4 = await transmuxTsToMp4(videoParts, signal);
    return { blob: mp4, ext: ".mp4", mode: "hls-mp4-muxjs" };
  }
}

// Repackage MPEG-TS into fragmented MP4 with mux.js (no re-encode), one
// segment at a time so memory stays bounded.
async function transmuxTsToMp4(parts, signal) {
  if (!self.muxjs) throw new Error("muxjs not loaded");
  const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
  let initSegment = null;
  const out = [];
  transmuxer.on("data", (seg) => {
    if (!initSegment && seg.initSegment?.byteLength) initSegment = seg.initSegment;
    if (seg.data?.byteLength) out.push(new Blob([seg.data]));
  });
  for (const p of parts) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    transmuxer.push(new Uint8Array(await p.arrayBuffer()));
    transmuxer.flush();
  }
  if (!initSegment || !out.length) throw new Error("transmux produced no output");
  return new Blob([initSegment, ...out], { type: "video/mp4" });
}

// ----------------------------------------------------------------- ffmpeg.wasm
// Cache the load *promise* so a pre-warm call and the mux call share one
// instance instead of racing two loads; reset on failure so a retry can work.
let _ffmpegPromise = null;
let _ffmpeg = null;
let _ffmpegLoading = null;
const _ffmpegLog = [];
let _onMuxProgress = null;
function loadFFmpeg() {
  if (_ffmpegPromise) return _ffmpegPromise;
  const p = (_ffmpegPromise = (async () => {
    if (!self.FFmpegWASM) throw new Error("ffmpeg.js not loaded");
    const ff = (_ffmpegLoading = new FFmpegWASM.FFmpeg());
    ff.on("log", ({ message }) => {
      _ffmpegLog.push(message);
      if (_ffmpegLog.length > 40) _ffmpegLog.shift();
    });
    // Progress during muxing keeps the service worker alive (no segment
    // progress fires while ffmpeg runs) and drives the popup/badge.
    ff.on("progress", ({ progress }) => _onMuxProgress?.(progress));
    // NOTE: do NOT pass classWorkerURL — that makes ffmpeg spawn a *module*
    // worker, which lacks importScripts and can't load the UMD core. Omitting it
    // uses the default *classic* worker (auto-resolved from this script's folder),
    // which importScripts the core fine.
    await ff.load({
      coreURL: chrome.runtime.getURL("vendor/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("vendor/ffmpeg-core.wasm"),
    });
    if (_ffmpegPromise !== p) {
      // resetFFmpeg() ran while we were loading: don't leave this worker behind.
      ff.terminate();
      throw new Error("ffmpeg was reset while loading");
    }
    _ffmpegLoading = null;
    _ffmpeg = ff;
    return ff;
  })());
  p.catch(() => {
    if (_ffmpegPromise === p) _ffmpegPromise = null;
  });
  return p;
}
// Drop the ffmpeg worker (after a crash/abort, or to cancel a running exec).
function resetFFmpeg() {
  for (const ff of [_ffmpeg, _ffmpegLoading]) {
    try {
      ff?.terminate();
    } catch {}
  }
  _ffmpeg = _ffmpegLoading = null;
  _ffmpegPromise = null;
}

function ffmpegTail() {
  // This core always ends exec() via abort(), so "Aborted()" is never the cause.
  const useful = _ffmpegLog.filter((l) => l && !/^\s*(built with|configuration:|lib\w+\s+\d|Aborted\()/.test(l));
  return useful.slice(-3).join(" | ") || "(no log)";
}

let _ffmpegSeq = 0;
// Remux `inputs` ([{ name, blob }], in -i order) with `-c copy` into an MP4.
// Inputs are mounted read-only via WORKERFS (read lazily from the Blobs, not
// copied into the wasm heap); if that can't mount or the run fails, retry once
// with the inputs copied into ffmpeg's memory instead.
async function ffmpegRemux(job, inputs, mapArgs, rep) {
  try {
    return await ffmpegRemuxOnce(job, inputs, mapArgs, rep, true);
  } catch (e) {
    // Not after a crash (likely out of memory: copying inputs in would make it
    // worse) and not for inputs too big to copy; the callers have lighter fallbacks.
    const size = inputs.reduce((n, i) => n + i.blob.size, 0);
    if (job.ctrl.signal.aborted || !e?.mounted || e.crashed || size > 1 << 30) throw e;
    return ffmpegRemuxOnce(job, inputs, mapArgs, rep, false);
  }
}

async function ffmpegRemuxOnce(job, inputs, mapArgs, rep, useMount) {
  const ff = await loadFFmpeg();
  const n = ++_ffmpegSeq;
  const dir = `/in${n}`;
  const outPath = `/out${n}.mp4`;
  let mounted = false;
  const written = [];
  try {
    await ff.createDir(dir);
    if (useMount) {
      try {
        mounted = !!(await ff.mount("WORKERFS", { blobs: inputs.map((i) => ({ name: i.name, data: i.blob })) }, dir));
      } catch {
        mounted = false;
      }
    }
    if (!mounted) {
      for (const i of inputs) {
        const p = `${dir}/${i.name}`;
        await ff.writeFile(p, new Uint8Array(await i.blob.arrayBuffer()));
        written.push(p);
      }
    }
    if (job.ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
    _ffmpegLog.length = 0;
    _onMuxProgress = (p) => rep("mux", Math.max(0, Math.min(100, Math.round((p || 0) * 100))), 100);
    const args = [];
    for (const i of inputs) args.push("-i", `${dir}/${i.name}`);
    args.push(...mapArgs, "-c", "copy", "-movflags", "+faststart", outPath);
    let code;
    try {
      code = await ff.exec(args);
    } catch (e) {
      // Worker crashed (e.g. out of memory) or was terminated by a cancel.
      resetFFmpeg();
      throw Object.assign(new Error(`${TAG} ffmpeg failed: ${e?.message || e}`), { mounted, crashed: true });
    }
    if (code !== 0) throw Object.assign(new Error(`${TAG} ffmpeg exit ${code}: ${ffmpegTail()}`), { mounted });
    rep("finalize", 100, 100);
    const data = await ff.readFile(outPath);
    // Free ffmpeg's copy before the Blob copies ours (the memory peak).
    await ff.deleteFile(outPath).catch(() => {});
    return new Blob([data], { type: "video/mp4" });
  } finally {
    _onMuxProgress = null;
    // Best-effort cleanup of the in-memory filesystem (skip if the worker died).
    if (_ffmpeg === ff) {
      const quiet = (p) => p.catch(() => {});
      await quiet(ff.deleteFile(outPath));
      for (const p of written) await quiet(ff.deleteFile(p));
      if (mounted) await quiet(ff.unmount(dir));
      await quiet(ff.deleteDir(dir));
    }
  }
}

function extFromUrl(url, fallback) {
  const m = /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.exec(url);
  return m ? "." + m[1].toLowerCase() : fallback;
}
