// background.js — service worker (MV3)
//
// Responsibilities:
//  1. Sniff network traffic per tab to discover media URLs (.mp4, .m3u8, etc.).
//  2. Merge detections reported by the content script (DOM <video> elements).
//  3. Run download *jobs*: Loom API first, then the offscreen assembler (HLS /
//     direct files), with an in-frame fetch as the last resort.
//
// MV3 workers are killed after ~30s idle, so everything that must survive that
// (detections, jobs, UI holds) lives in chrome.storage.session, and long work
// reports back with fresh messages ("offscreen:done") instead of a response we
// would have to stay alive for.
//
// This only ever downloads media that the current page already loaded for you.
// You are responsible for having the right to save it.

const MEDIA_FILE_EXT = /\.(mp4|webm|mov|m4v|mkv)$/i;
const HLS_EXT = /\.m3u8$/i;
const DASH_EXT = /\.mpd$/i;
const MEDIA_CONTENT_TYPES = /^\s*(video\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml))/i;
// Stream pieces we never offer as downloads: HLS/DASH segments, keys, captions.
const SEGMENT_EXT = /\.(ts|m4s|cmfv|cmfa|aac|m4a|mp3|vtt|webvtt|key)$/i;
const SEGMENT_CONTENT_TYPES = /^\s*(video\/(mp2t|iso\.segment)|audio\/|text\/vtt)/i;
const SEGMENT_NAME = /(?:^|[/_.-])(?:seg|segment|chunk|frag|fragment)[-_]?\d+[^/]*$/i;
const RANGE_QUERY = /[?&](range|bytestart|byterange)=/i;
// Subtitle / I-frame / thumbnail playlists aren't videos.
const AUX_PLAYLIST = /(?:^|[/_.-])(subtitles?|captions?|subs|webvtt|vtt|i-?frames?|trickplay|thumbnails?)(?:[/_.-]|$)/i;
const MAX_ITEMS_PER_TAB = 60;
const LOOM_ID = /\/(embed|share)\/([0-9a-f]{20,})/i;

// ------------------------------------------------------------------- state
// tabId -> Map<url, item>; jobId -> job. Mirrored to chrome.storage.session.
const tabs = new Map();
const jobs = new Map();
const meta = { seq: 0, top: {} }; // job counter (unique rule ids); tabId -> top URL

const ready = (async () => {
  try {
    const all = await chrome.storage.session.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith("det:") && Array.isArray(v)) tabs.set(Number(k.slice(4)), new Map(v.map((i) => [i.url, i])));
    }
    for (const j of all.jobs || []) jobs.set(j.id, j);
    if (all.meta) Object.assign(meta, all.meta);
  } catch {}
  try {
    await cleanupRules();
    // Older builds left the download UI off permanently.
    await syncDownloadUi();
  } catch {}
})();
// Give the event that woke this worker (e.g. "offscreen:done") the first turn.
ready.then(() => setTimeout(() => reconcileJobs().catch(() => {}), 3000));

const saveTimers = new Map();
function persistSoon(key, delay = 250) {
  if (saveTimers.has(key)) return;
  saveTimers.set(
    key,
    setTimeout(() => {
      saveTimers.delete(key);
      persistNow(key);
    }, delay)
  );
}
function persistNow(key) {
  clearTimeout(saveTimers.get(key));
  saveTimers.delete(key);
  let p;
  if (key === "jobs") p = chrome.storage.session.set({ jobs: [...jobs.values()] });
  else if (key === "meta") p = chrome.storage.session.set({ meta });
  else {
    const tabId = Number(key.slice(4));
    const map = tabs.get(tabId);
    p = map?.size ? chrome.storage.session.set({ [key]: [...map.values()] }) : chrome.storage.session.remove(key);
  }
  return p.catch(() => {});
}

// ------------------------------------------------------------- detection
function getTabMap(tabId) {
  if (!tabs.has(tabId)) tabs.set(tabId, new Map());
  return tabs.get(tabId);
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function classify(url, contentType) {
  const p = pathOf(url);
  if (HLS_EXT.test(p) || /mpegurl/i.test(contentType || "")) return "hls";
  if (DASH_EXT.test(p) || /dash\+xml/i.test(contentType || "")) return "dash";
  return "file";
}

// Is this request something worth listing? (contentType may be unknown yet;
// reqType is the webRequest resource type when known. URLs a <video> element
// plays directly (fromDom) are whole files, so segment-name guesses don't apply.)
function isMediaCandidate(url, contentType, reqType, fromDom) {
  if (!url || /^(blob|data|chrome|chrome-extension):/i.test(url)) return false;
  const p = pathOf(url);
  if (!p || SEGMENT_EXT.test(p)) return false;
  if (!fromDom && (SEGMENT_NAME.test(p) || RANGE_QUERY.test(url))) return false;
  // RFC 8216 allows audio/mpegurl for playlists, so check HLS before audio/*.
  if (HLS_EXT.test(p) || /mpegurl/i.test(contentType || "")) return !AUX_PLAYLIST.test(p);
  if (contentType && SEGMENT_CONTENT_TYPES.test(contentType)) return false;
  if (MEDIA_FILE_EXT.test(p)) return true;
  if (!contentType) return false;
  if (MEDIA_CONTENT_TYPES.test(contentType)) return true;
  // A <video src> on storage hosts that label everything octet-stream.
  return reqType === "media" && !/^\s*(audio|text|image)\//i.test(contentType);
}

// fMP4 segments are often plain ".mp4" files next to their playlist.
function isSiblingOfPlaylist(map, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  for (const it of map.values()) {
    if (it.kind !== "hls" || it.stale) continue;
    try {
      const h = new URL(it.url);
      const hdir = h.pathname.slice(0, h.pathname.lastIndexOf("/") + 1);
      // A playlist at the host root (e.g. stream.mux.com/<id>.m3u8) owns nothing.
      if (h.host === u.host && hdir.length > 1 && u.pathname.startsWith(hdir)) return true;
    } catch {}
  }
  return false;
}

function record(tabId, url, { contentType = "", source = "network", frameId, documentId, reqType, at = Date.now() } = {}) {
  if (!isMediaCandidate(url, contentType, reqType, source === "dom")) return;
  const kind = classify(url, contentType);
  // DASH isn't assembled here; skip to avoid offering a download we can't fulfill.
  if (kind === "dash") return;

  const map = getTabMap(tabId);
  const existing = map.get(url);
  if (existing) {
    // Re-requested on the current page (e.g. the same signed Loom playlist from
    // a new iframe after going back to a lesson): it belongs to that document now.
    const otherDoc = documentId && existing.documentId !== documentId && at >= existing.detectedAt;
    if ((existing.stale && at > existing.detectedAt) || otherDoc) {
      existing.stale = false;
      existing.detectedAt = at;
      if (documentId) existing.documentId = documentId;
      if (frameId != null) existing.frameId = frameId;
      persistSoon("det:" + tabId);
      updateBadge(tabId);
    }
    return;
  }
  if (kind === "file" && source !== "dom" && isSiblingOfPlaylist(map, url)) return;
  if (map.size >= MAX_ITEMS_PER_TAB) {
    // Make room: the oldest "earlier" item, else the oldest item.
    const all = [...map.values()].sort((a, b) => a.detectedAt - b.detectedAt);
    map.delete((all.find((i) => i.stale) || all[0]).url);
  }

  map.set(url, { url, kind, source, detectedAt: at, frameId, documentId });
  // A real request from a Loom frame supersedes its placeholder entry.
  // (Not while a job started from the placeholder is running: the popup tracks it by URL.)
  if (documentId && regDomain(hostOf(url)) === "loom.com") {
    for (const [u, it] of map) {
      if (it.loom && it.documentId === documentId && !hasActiveJob(tabId, u)) map.delete(u);
    }
  }
  persistSoon("det:" + tabId);
  updateBadge(tabId);
}

function forget(tabId, url) {
  const map = tabs.get(tabId);
  if (map?.get(url)?.source === "network" && map.delete(url)) {
    persistSoon("det:" + tabId);
    updateBadge(tabId);
  }
}

// Drop items whose document is gone (e.g. the previous lesson's Loom iframe).
async function liveItems(tabId) {
  if (tabId == null || tabId < 0) return [];
  const map = getTabMap(tabId);
  let frames = null;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {}
  const live = new Set((frames || []).map((f) => f.documentId).filter(Boolean));
  let changed = false;
  if (live.size) {
    for (const [u, it] of map) {
      if (it.documentId && !live.has(it.documentId)) {
        map.delete(u);
        changed = true;
      }
    }
  }
  // Every Loom embed is downloadable through Loom's API, even before it's played
  // or when its player streams DASH (which we don't list): add a placeholder for
  // Loom frames that haven't produced a playlist we know about.
  for (const f of frames || []) {
    if (!f.documentId || regDomain(hostOf(f.url)) !== "loom.com" || !LOOM_ID.test(f.url || "")) continue;
    const known = [...map.values()].some((it) => it.documentId === f.documentId && (it.loom || regDomain(hostOf(it.url)) === "loom.com"));
    if (!known && map.size < MAX_ITEMS_PER_TAB) {
      map.set(f.url, { url: f.url, kind: "hls", source: "loom-frame", loom: true, detectedAt: Date.now(), frameId: f.frameId, documentId: f.documentId });
      changed = true;
    }
  }
  // A Loom placeholder and a real playlist from the same player are one video:
  // drop the placeholder, unless a job started from it is running (then hide the
  // playlist instead, so the popup keeps showing that job's card).
  const hidden = new Set();
  for (const [u, it] of map) {
    if (!it.loom) continue;
    const real = [...map.values()].filter((r) => !r.loom && r.documentId === it.documentId && regDomain(hostOf(r.url)) === "loom.com");
    if (!real.length) continue;
    if (hasActiveJob(tabId, u)) real.forEach((r) => hidden.add(r.url));
    else {
      map.delete(u);
      changed = true;
    }
  }
  if (changed) persistSoon("det:" + tabId);
  return [...map.values()].filter((it) => !hidden.has(it.url));
}

// --- Grouping (shared by the popup list and the badge count)
// Pull a readable quality hint out of a variant URL path, e.g. "bitrate3200" -> "3200k".
function qualityLabel(url) {
  const p = pathOf(url);
  let m = /bitrate[-_]?(\d+)/i.exec(p);
  if (m) return m[1] + "k";
  m = /(\d{3,4})p\b/i.exec(p);
  if (m) return m[1] + "p";
  m = /(\d{3,4})x(\d{3,4})/.exec(p);
  if (m) return m[2] + "p";
  return null;
}
function qualityNum(url) {
  const m = /bitrate[-_]?(\d+)|(\d{3,4})p\b/i.exec(pathOf(url));
  return m ? parseInt(m[1] || m[2], 10) : 0;
}
function isAudioOnly(url) {
  const p = pathOf(url);
  return /-audio-|\baudio\b/i.test(p) && !/-video-/i.test(p);
}
// Master playlists (the whole video) vs. single-rendition variant playlists.
function isMaster(url) {
  const p = pathOf(url);
  const h = hostOf(url);
  if (/(^|\.)stream\.mux\.com$/i.test(h) && /^\/[^/]+\.m3u8$/i.test(p)) return true;
  if (/wistia\.(com|net)$/i.test(h) && /\/medias\/[^/]+\.m3u8$/i.test(p)) return true;
  return /\/playlist\b|\/master\b|\bplaylist\.m3u8/i.test(p) && !/mediaplaylist|bitrate|rendition|-video-|-audio-/i.test(p);
}

function groupItems(items) {
  const fresh = items.filter((i) => !i.stale);
  const stale = items.filter((i) => i.stale);
  const pick = (list) => {
    const whole = (i) => i.kind === "hls" && (i.loom || isMaster(i.url));
    const masters = list.filter(whole);
    const variants = list
      .filter((i) => i.kind === "hls" && !whole(i) && !isAudioOnly(i.url))
      .sort((a, b) => qualityNum(b.url) - qualityNum(a.url));
    const files = list.filter((i) => i.kind === "file");
    // Primary = the actual video(s) worth downloading. Everything else is hidden
    // behind a toggle so the same lesson at 5 bitrates doesn't show as 5 entries.
    if (masters.length) return { primary: masters, extra: [...variants, ...files] };
    if (variants.length) return { primary: [variants[0]], extra: [...variants.slice(1), ...files] };
    return { primary: files, extra: [] };
  };
  const card = (i, role) => ({
    url: i.url,
    kind: i.kind,
    role,
    q: i.kind === "hls" ? qualityLabel(i.url) : null,
  });
  const f = pick(fresh);
  if (f.primary.length) {
    return {
      primary: f.primary.map((i) => card(i, "primary")),
      extra: [...f.extra.map((i) => card(i, "extra")), ...stale.map((i) => card(i, "earlier"))],
    };
  }
  // Nothing new on this page yet: fall back to earlier detections, clearly labelled.
  const s = pick(stale);
  return { primary: s.primary.map((i) => card(i, "earlier")), extra: s.extra.map((i) => card(i, "earlier")) };
}

// --- Badge
function hasActiveJob(tabId, url) {
  for (const j of jobs.values()) if (j.tabId === tabId && j.item.url === url && !isTerminal(j)) return true;
  return false;
}
function activeJobForTab(tabId) {
  let best = null;
  for (const j of jobs.values()) if (j.tabId === tabId && !isTerminal(j) && (!best || j.updatedAt > best.updatedAt)) best = j;
  return best;
}
function updateBadge(tabId, count) {
  if (tabId == null || tabId < 0 || activeJobForTab(tabId)) return;
  if (count == null) {
    const map = tabs.get(tabId);
    count = map?.size ? groupItems([...map.values()]).primary.filter((c) => c.role !== "earlier").length : 0;
  }
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#4f46e5" }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
}
// Tab-specific badge text wins over the global one, so progress is set on the
// job's tab (and globally, for other tabs).
function setBadge(job, text, color) {
  for (const target of [job.tabId >= 0 ? { tabId: job.tabId } : null, {}].filter(Boolean)) {
    chrome.action.setBadgeBackgroundColor({ ...target, color }).catch(() => {});
    chrome.action.setBadgeText({ ...target, text }).catch(() => {});
  }
}
function badgeForJob(job) {
  const pct = job.total ? Math.floor((job.done / job.total) * 100) : 0;
  if (job.status === "muxing") setBadge(job, "MUX", "#f59e0b");
  else if (job.status === "starting" || job.status === "queued") setBadge(job, "…", "#16a34a");
  else if (job.status === "downloading") setBadge(job, job.total ? pct + "%" : "↓", "#16a34a");
  else if (job.status === "saving") setBadge(job, "↓", "#16a34a");
}
function badgeAfterJob(job) {
  if (job.status === "done") setBadge(job, "✓", "#16a34a");
  else if (job.status === "error") setBadge(job, "!", "#dc2626");
  // Best effort (the worker may be gone by then): restore the normal badge.
  setTimeout(() => {
    const other = [...jobs.values()].filter((j) => !isTerminal(j)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (other) badgeForJob(other);
    else chrome.action.setBadgeText({ text: "" }).catch(() => {});
    if (job.tabId >= 0) {
      const next = activeJobForTab(job.tabId);
      if (next) badgeForJob(next);
      else updateBadge(job.tabId);
    }
  }, job.status === "canceled" ? 0 : 8000);
}

// --- Network sniffing -------------------------------------------------------
// Only request types that can carry media (skips images, scripts, fonts, pages).
const WR_FILTER = { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] };

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0 || !isMediaCandidate(d.url, "")) return;
  ready.then(() => record(d.tabId, d.url, { source: "network", frameId: d.frameId, documentId: d.documentId, at: d.timeStamp }));
}, WR_FILTER);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    if (d.statusCode >= 400) {
      // e.g. a 403 MissingKey playlist: not something we can download.
      if ([401, 403, 404, 410].includes(d.statusCode)) ready.then(() => forget(d.tabId, d.url));
      return;
    }
    const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type")?.value;
    if (ct && isMediaCandidate(d.url, ct, d.type)) {
      ready.then(() =>
        record(d.tabId, d.url, { contentType: ct, reqType: d.type, source: "network", frameId: d.frameId, documentId: d.documentId, at: d.timeStamp })
      );
    }
  },
  WR_FILTER,
  ["responseHeaders"]
);

// A real (cross-document) top-level navigation: forget the old page's media.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0 || (d.documentLifecycle && d.documentLifecycle !== "active")) return;
  ready.then(() => {
    meta.top[d.tabId] = stripHash(d.url);
    persistSoon("meta");
    const map = tabs.get(d.tabId);
    if (!map) return;
    for (const [u, it] of map) {
      // Keep anything the new page (or its iframes) already requested.
      const fromNewPage = it.detectedAt >= d.timeStamp || (it.documentId && it.documentId === d.documentId);
      if (!fromNewPage) map.delete(u);
    }
    persistSoon("det:" + d.tabId);
    updateBadge(d.tabId);
  });
});

// SPA navigation (Skool lessons use history.pushState): the page document stays,
// so mark what it loaded so far as "earlier" instead of offering it as this
// lesson's video. Iframes that went away are dropped by liveItems().
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  ready.then(() => {
    const url = stripHash(d.url);
    if (meta.top[d.tabId] === url) return; // e.g. replaceState on the same lesson
    meta.top[d.tabId] = url;
    persistSoon("meta");
    const map = tabs.get(d.tabId);
    if (!map) return;
    // Keep one generation of "earlier" items so a long SPA session doesn't fill up.
    for (const [u, it] of map) {
      if ((it.frameId == null || it.frameId <= 0) && it.detectedAt < d.timeStamp) {
        if (it.stale) map.delete(u);
        else it.stale = true;
      }
    }
    persistSoon("det:" + d.tabId);
    updateBadge(d.tabId);
    // The old lesson's iframe goes away once the new one renders: recount then.
    setTimeout(() => liveItems(d.tabId).then(() => updateBadge(d.tabId)), 1500);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => {
    tabs.delete(tabId);
    delete meta.top[tabId];
    persistNow("det:" + tabId);
    persistSoon("meta");
  });
});

function stripHash(u) {
  return (u || "").split("#")[0];
}

// --- Messaging --------------------------------------------------------------

// Privileged commands may only come from our own extension pages (popup /
// offscreen document), never from content scripts running in web pages.
function fromExtensionPage(sender) {
  return sender.id === chrome.runtime.id && !sender.tab;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type || "";

  if (type === "content:detections") {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      ready.then(() => {
        for (const url of msg.urls || []) {
          record(tabId, url, { source: "dom", frameId: sender.frameId, documentId: sender.documentId });
        }
      });
    }
    return;
  }

  // Progress/completion from the in-frame fallback assembler.
  if (type === "frame:progress") {
    // The reply lets the in-page download stop if the job was canceled.
    ready.then(() => {
      if (!msg.check) onProgress(msg.jobId, "download", msg.done, msg.total);
      sendResponse({ canceled: !jobs.has(msg.jobId) || isTerminal(jobs.get(msg.jobId)) });
    });
    return true;
  }
  if (type === "frame:done") {
    ready.then(() => onFrameResult(jobs.get(msg.jobId), msg));
    return;
  }

  if (!fromExtensionPage(sender)) return;

  if (type === "offscreen:progress") {
    ready.then(() => onProgress(msg.jobId, msg.stage, msg.done, msg.total));
    return;
  }
  if (type === "offscreen:done") {
    // Ack right away: the offscreen queue waits for this before the next job.
    sendResponse({ ok: true });
    ready.then(() => onOffscreenDone(msg)).catch((e) => failJob(msg.jobId, e));
    return;
  }

  if (type === "popup:list") {
    ready
      .then(async () => {
        const groups = groupItems(await liveItems(msg.tabId));
        updateBadge(msg.tabId, groups.primary.filter((c) => c.role !== "earlier").length);
        await reconcileJobs();
        sendResponse({ ...groups, jobs: jobsForTab(msg.tabId) });
      })
      .catch((e) => sendResponse({ primary: [], extra: [], jobs: [], error: String(e?.message || e) }));
    return true;
  }

  if (type === "popup:download") {
    ready
      .then(() => startJob(msg))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }

  if (type === "popup:cancel") {
    ready.then(() => cancelJob(msg.jobId)).finally(() => sendResponse({ ok: true }));
    return true;
  }
});

// --- Jobs -------------------------------------------------------------------
// status: starting -> [queued ->] downloading -> [muxing ->] saving -> done
//         (or error / canceled at any point)
const TERMINAL = new Set(["done", "error", "canceled"]);
function isTerminal(job) {
  return TERMINAL.has(job?.status);
}

function patch(job, fields, persist = "soon") {
  // A finished job stays finished (e.g. a step that resumes after a cancel).
  if (isTerminal(job) && fields.status && !TERMINAL.has(fields.status)) return;
  Object.assign(job, fields, { updatedAt: Date.now() });
  if (persist === "now") persistNow("jobs");
  else persistSoon("jobs", 500);
  broadcast(job);
}

// What the popup needs (never the blob URL or cookie-bearing internals).
function publicJob(j) {
  return {
    id: j.id,
    tabId: j.tabId,
    url: j.item.url,
    name: j.item.name,
    kind: j.assembleKind || j.item.kind,
    saveAs: !!j.saveAs,
    status: j.status,
    stage: j.stage,
    done: j.done || 0,
    total: j.total || 0,
    error: j.error || "",
    detail: j.detail || "",
    note: j.note || "",
    route: j.route || "",
    savedPath: j.savedPath || "",
    downloadId: j.downloadId ?? null,
    updatedAt: j.updatedAt,
  };
}
function broadcast(job) {
  chrome.runtime.sendMessage({ type: "job:update", job: publicJob(job) }).catch(() => {});
}
function jobsForTab(tabId) {
  return [...jobs.values()].filter((j) => j.tabId === tabId).map(publicJob);
}

function pruneJobs() {
  const done = [...jobs.values()].filter(isTerminal).sort((a, b) => b.updatedAt - a.updatedAt);
  const cutoff = Date.now() - 60 * 60 * 1000;
  done.forEach((j, i) => {
    if (i >= 30 || j.updatedAt < cutoff) jobs.delete(j.id);
  });
}

async function startJob(msg) {
  const url = msg.item?.url;
  if (!url) throw new Error("No URL provided.");
  const tabId = msg.tabId ?? -1;
  // Clicking again while that video is still downloading just re-attaches
  // (for Loom, any entry from the same player frame is the same video).
  const det0 = tabs.get(tabId)?.get(url);
  const sameLoom = (j) =>
    det0?.documentId && j.item.documentId === det0.documentId && regDomain(hostOf(url)) === "loom.com" && regDomain(hostOf(j.item.url)) === "loom.com";
  for (const j of jobs.values()) {
    if (j.tabId === tabId && !isTerminal(j) && (j.item.url === url || sameLoom(j))) return { ok: true, jobId: j.id, existing: true, url: j.item.url };
  }
  pruneJobs();
  meta.seq = (meta.seq + 1) % 1_000_000;
  persistNow("meta");
  const det = tabs.get(tabId)?.get(url);
  const job = {
    id: "j" + Date.now().toString(36) + meta.seq.toString(36),
    ruleBase: 1000 + (meta.seq % 2000) * 10,
    tabId,
    pageUrl: msg.pageUrl || "",
    item: {
      url,
      kind: msg.item.kind === "file" ? "file" : "hls",
      name: sanitize(msg.item.name),
      documentId: det?.documentId || null,
      loomFrame: !!det?.loom,
    },
    quality: msg.quality || "highest",
    folder: sanitizeFolder(msg.folder || ""),
    saveAs: !!msg.saveAs,
    status: "starting",
    stage: "",
    notes: [],
    ruleIds: [],
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  patch(job, {}, "now");
  badgeForJob(job);
  runJob(job).catch((e) => failJob(job.id, e));
  return { ok: true, jobId: job.id };
}

async function runJob(job) {
  running.add(job.id);
  try {
    await runJobSteps(job);
  } finally {
    running.delete(job.id);
    // Canceled mid-step: drop anything a step installed after finishJob ran.
    if (isTerminal(job)) cleanupJob(job);
  }
}

async function runJobSteps(job) {
  let url = job.item.url;
  let kind = job.item.kind;
  let skipFrame = false;

  // 0) Loom videos: don't fight the HLS/CloudFront segments — ask Loom's own API
  //    (from inside the Loom iframe) for the ready-made signed MP4, like yt-dlp.
  if (regDomain(hostOf(url)) === "loom.com") {
    patch(job, { stage: "loom" });
    const r = await tryLoomApi(job);
    if (isTerminal(job)) return;
    if (r.mp4Url) {
      // The Loom referer rule can't affect a chrome.downloads fetch; don't let it
      // linger and rewrite other jobs' cloudfront.net requests meanwhile.
      const loomRule = job.ruleBase + 9;
      job.ruleIds = (job.ruleIds || []).filter((id) => id !== loomRule);
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [loomRule] }).catch(() => {});
      patch(job, { route: "loom-api", mode: "loom-api" });
      await startDownload(job, r.mp4Url, ".mp4");
      return;
    }
    if (r.hlsUrl) {
      // Loom returned a signed HLS playlist — assemble it via offscreen (its
      // segments are signed, so no cookies/CORS needed).
      url = r.hlsUrl;
      kind = "hls";
      skipFrame = true;
    } else if (job.item.loomFrame) {
      // The placeholder is the embed page itself; there's nothing else to fetch.
      throw new Error("Loom didn't return a download link (" + (r.error || "api failed") + "). Press play on the video, then try again.");
    } else {
      job.notes.push("loom: " + (r.error || "api failed"));
    }
  }

  // 1) Offscreen assembler, with cookies/referer injected via session DNR rules
  //    that only apply to this extension's own (tab-less) requests.
  patch(job, { route: "offscreen", status: "queued", stage: "prepare", assembleUrl: url, assembleKind: kind, skipFrame }, "now");
  job.ruleIds = await installAuthRules(job, url);
  if (isTerminal(job)) return;
  await ensureOffscreen();
  if (isTerminal(job)) return;
  const ack = await sendToOffscreen({
    type: "offscreen:assemble",
    jobId: job.id,
    item: { url, kind, quality: job.quality },
  });
  // Canceled while we were handing it over: the offscreen cancel may have missed it.
  if (isTerminal(job)) return sendToOffscreen({ type: "offscreen:cancel", jobId: job.id }).catch(() => {});
  if (!ack?.accepted) throw new Error("The offscreen assembler didn't accept the job.");
  // Completion arrives as a separate "offscreen:done" message.
}

function onProgress(jobId, stage, done, total) {
  const job = jobs.get(jobId);
  if (!job || isTerminal(job)) return;
  const status = stage === "queued" ? "queued" : stage === "mux" || stage === "finalize" ? "muxing" : "downloading";
  patch(job, { status, stage, done: done || 0, total: total || 0 });
  badgeForJob(job);
}

async function onOffscreenDone(msg) {
  const job = jobs.get(msg.jobId);
  if (!job || isTerminal(job)) {
    if (msg.blobUrl) revokeBlob(msg.blobUrl);
    return;
  }
  running.add(job.id); // so reconcileJobs() leaves it alone while we finish it
  try {
    await onOffscreenDoneSteps(job, msg);
  } finally {
    running.delete(job.id);
  }
}

async function onOffscreenDoneSteps(job, msg) {
  if (msg.ok) {
    patch(job, { blobUrl: msg.blobUrl, mode: msg.mode }, "now");
    await startDownload(job, msg.blobUrl, msg.ext || ".mp4");
    return;
  }
  if (msg.canceled) return finishJob(job, "canceled");

  // 2) Last resort: fetch INSIDE the frame that owns the media host (its own
  //    cookies, incl. partitioned ones, attach automatically).
  job.offscreenError = msg.error || "Download failed.";
  job.offscreenStatus = msg.httpStatus || 0;
  const authish = msg.httpStatus === 401 || msg.httpStatus === 403 || msg.network || msg.auth;
  if (authish && !job.skipFrame && !job.frameTried) {
    job.frameTried = true;
    patch(job, { route: "frame", status: "downloading", stage: "download", done: 0, total: 0 }, "now");
    // The frame also reports "frame:done" itself, in case this worker restarts.
    await onFrameResult(job, await tryFrameDownload(job));
    return;
  }
  await failWithDiag(job);
}

async function onFrameResult(job, fr) {
  // Delivered twice (executeScript result + "frame:done"); handle the first.
  if (!job || isTerminal(job) || job.route !== "frame" || !fr || job.frameSettled) return;
  job.frameSettled = true;
  if (fr.ok) {
    return finishJob(job, "done", {
      mode: fr.mode,
      note: "Saved by the page itself, so it went to your default Downloads folder" + (fr.ext === ".ts" ? " as .ts" : "") + ".",
    });
  }
  job.notes.push("frame: " + fr.error);
  await failWithDiag(job);
}

async function failWithDiag(job) {
  const diag = job.tabId >= 0 ? await frameDiag(job.tabId) : "";
  finishJob(job, "error", {
    error: friendlyError(job.offscreenError, job.offscreenStatus),
    detail: [job.offscreenError, ...job.notes, diag].filter(Boolean).join(" || "),
  });
}

async function failJob(jobId, e) {
  const job = jobs.get(jobId);
  if (!job || isTerminal(job)) return;
  const raw = e?.message || String(e);
  finishJob(job, "error", { error: friendlyError(raw, 0), detail: [raw, ...(job.notes || [])].join(" || ") });
}

async function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || isTerminal(job)) return;
  if (job.downloadId != null) {
    try {
      await chrome.downloads.cancel(job.downloadId);
    } catch {}
  }
  if (job.route === "offscreen" && (await hasOffscreen())) {
    sendToOffscreen({ type: "offscreen:cancel", jobId }).catch(() => {});
  }
  // A frame download can't be interrupted; its eventual result is ignored.
  finishJob(job, "canceled");
}

function finishJob(job, status, extra = {}) {
  if (isTerminal(job)) return;
  patch(job, { status, ...extra }, "now");
  cleanupJob(job);
  badgeAfterJob(job);
  pruneJobs();
}

function cleanupJob(job) {
  if (job.blobUrl) {
    revokeBlob(job.blobUrl);
    job.blobUrl = null;
  }
  if (job.ruleIds?.length) {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: job.ruleIds }).catch(() => {});
    job.ruleIds = [];
  }
  if (job.uiHold) {
    job.uiHold = false;
    syncDownloadUi();
  }
  persistSoon("jobs", 100);
  maybeCloseOffscreen();
}

// Jobs this worker instance is actively driving (lost if the worker restarts).
const running = new Set();

// Re-check jobs that could otherwise wait forever: a crashed offscreen document
// (e.g. out of memory), a worker restart mid-step, a missed download event.
async function reconcileJobs() {
  const open = [...jobs.values()].filter((j) => !isTerminal(j));
  if (!open.length) return;
  let known = null;
  for (const j of open) {
    if (isTerminal(j) || running.has(j.id)) continue;
    const idle = () => Date.now() - (j.updatedAt || 0);
    if (j.downloadId != null) {
      const [d] = await chrome.downloads.search({ id: j.downloadId }).catch(() => []);
      if (!d) finishJob(j, "error", { error: "The download disappeared from Chrome's list.", detail: "download " + j.downloadId + " missing" });
      else if (d.state !== "in_progress") onDownloadEnded(j, d.state, d.error, d.filename);
    } else if (j.status === "starting") {
      if (!running.has(j.id)) runJob(j).catch((e) => failJob(j.id, e));
    } else if (j.route === "offscreen") {
      if (!known) {
        const st = (await hasOffscreen()) ? await sendToOffscreen({ type: "offscreen:status" }).catch(() => null) : null;
        known = new Set([st?.active, ...(st?.queued || [])].filter(Boolean));
      }
      // Re-check after the awaits: the job may have moved on meanwhile.
      if (isTerminal(j) || j.route !== "offscreen" || j.downloadId != null || running.has(j.id)) continue;
      if (!known.has(j.id) && idle() > 60_000) {
        finishJob(j, "error", {
          error: "The download stopped unexpectedly (the video may be too large for the browser). Try a lower quality.",
          detail: "offscreen lost job " + j.id,
        });
      }
    } else if (j.route === "frame" && !j.frameSettled && idle() > 10 * 60_000) {
      finishJob(j, "error", { error: "Lost track of the in-page download; check your Downloads folder.", detail: "frame job idle" });
    }
  }
}

// --- Saving -----------------------------------------------------------------
async function startDownload(job, url, ext) {
  const filename = job.saveAs ? sanitize(job.item.name) + ext : targetName(job, ext);
  // Auto mode saves silently: hide Chrome's download bubble only while our own
  // file is being written (setUiOptions is browser-wide). Save-As needs the UI.
  if (job.saveAs) {
    job.saveStartedAt = Date.now();
    await setDownloadUi(true);
  } else {
    job.uiHold = true;
    persistNow("jobs");
    await setDownloadUi(false);
  }
  if (isTerminal(job)) return syncDownloadUi(); // canceled meanwhile
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, saveAs: job.saveAs, conflictAction: "uniquify" });
  } catch (e) {
    // e.g. "Invalid filename": don't throw away minutes of work over a name.
    job.notes.push("filename: " + (e?.message || e));
    id = await chrome.downloads.download({ url, filename: fallbackName(job, ext), saveAs: job.saveAs, conflictAction: "uniquify" });
  }
  if (isTerminal(job)) {
    // Canceled while Chrome was starting it (for a remote MP4, a full round trip).
    chrome.downloads.cancel(id).catch(() => {});
    return;
  }
  job.downloadId = id;
  patch(job, { status: "saving", stage: "save", downloadId: id }, "now");
  badgeForJob(job);
  // A blob download can finish before we get here; check its state once.
  const [d] = await chrome.downloads.search({ id });
  if (d && d.state !== "in_progress") onDownloadEnded(job, d.state, d.error, d.filename);
}

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  ready.then(async () => {
    const job = [...jobs.values()].find((j) => j.downloadId === delta.id);
    if (!job || isTerminal(job)) return;
    let filename = "";
    try {
      filename = (await chrome.downloads.search({ id: delta.id }))[0]?.filename || "";
    } catch {}
    onDownloadEnded(job, state, delta.error?.current, filename);
  });
});

function onDownloadEnded(job, state, error, filename) {
  if (isTerminal(job)) return;
  if (state === "complete") {
    rememberFolder(job, filename);
    finishJob(job, "done", { savedPath: filename || "" });
  } else if (error === "USER_CANCELED") {
    finishJob(job, "canceled");
  } else {
    finishJob(job, "error", { error: "Chrome couldn't save the file (" + (error || "interrupted") + ").", detail: String(error || "") });
  }
}

// Learn the absolute Downloads root from an auto-mode save (we know the relative
// path we asked for), so a Save-As folder can be reused later in auto mode.
// Stamped with when the folder was *chosen* (job start / Save-As dialog), so a
// folder typed while an older download was running isn't undone later.
function rememberFolder(job, filename) {
  if (!filename) return;
  const dir = filename.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  chrome.storage.local.get(["downloadsRoot", "lastFolder"]).then(({ downloadsRoot, lastFolder }) => {
    const remember = (folder, at) => {
      if (!lastFolder?.at || at >= lastFolder.at) chrome.storage.local.set({ lastFolder: { folder, at } });
    };
    if (!job.saveAs) {
      const suffix = job.folder ? "/" + job.folder : "";
      if (!suffix || dir.endsWith(suffix)) {
        chrome.storage.local.set({ downloadsRoot: dir.slice(0, dir.length - suffix.length) });
      }
      remember(job.folder, job.createdAt);
    } else {
      const at = job.saveStartedAt || job.createdAt;
      if (downloadsRoot && (dir === downloadsRoot || dir.startsWith(downloadsRoot + "/"))) {
        remember(dir.slice(downloadsRoot.length + 1), at);
      } else if (!downloadsRoot) {
        // Root not learned yet: assume Chrome's default folder is named Downloads.
        const i = dir.toLowerCase().lastIndexOf("/downloads");
        const rest = i >= 0 ? dir.slice(i + "/downloads".length) : null;
        if (rest === "" || rest?.startsWith("/")) remember(rest.slice(1), at);
      }
    }
  });
}

// --- Download UI holds -------------------------------------------------------
async function setDownloadUi(enabled) {
  try {
    await chrome.downloads.setUiOptions?.({ enabled });
  } catch {}
}
// The UI is off exactly while an auto-mode download of ours is in flight.
function syncDownloadUi() {
  return setDownloadUi(![...jobs.values()].some((j) => j.uiHold && !isTerminal(j)));
}

// --- Auth rules ----------------------------------------------------------------
// We fetch from an offscreen document (extension context bypasses CORS via host
// permissions) and use declarativeNetRequest to attach the auth the media host
// needs: the browser's cookies for that host (incl. HttpOnly CloudFront cookies)
// plus a Referer. Rules are *session* rules scoped to this extension's own
// tab-less requests (the offscreen fetches), never your normal browsing, and
// are removed when the job ends.

// Registrable domain (eTLD+1), approximated without the full Public Suffix
// List: ccTLD second levels (co.uk, com.au, …) and common multi-tenant hosts
// (cloudfront.net, b-cdn.net, …) count as suffixes, so "d1.cloudfront.net" and
// "example.co.uk" stay separate sites instead of merging cookies with strangers.
const SHARED_SUFFIXES = new Set([
  "cloudfront.net", "amazonaws.com", "s3.amazonaws.com", "b-cdn.net", "akamaized.net", "azureedge.net",
  "azurewebsites.net", "blob.core.windows.net", "github.io", "herokuapp.com", "vercel.app", "netlify.app",
  "pages.dev", "workers.dev", "r2.dev", "web.app", "firebaseapp.com", "appspot.com", "googleusercontent.com",
  "googleapis.com", "storage.googleapis.com", "blogspot.com", "fly.dev", "onrender.com",
]);
function isPublicSuffix(d) {
  const labels = d.split(".");
  if (labels.length === 1) return true;
  if (labels.length === 2 && labels[1].length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go|gv|ltd|plc|nom|sch|mil|info|biz)$/i.test(labels[0])) return true;
  return SHARED_SUFFIXES.has(d.toLowerCase());
}
function regDomain(host) {
  const labels = (host || "").split(".").filter(Boolean);
  for (let n = 2; n <= labels.length; n++) {
    const d = labels.slice(-n).join(".");
    if (!isPublicSuffix(d)) return d;
  }
  return labels.join(".");
}
function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}
// Schemeful site (eTLD+1) used as the CHIPS partition top-level site.
function siteOf(u) {
  try {
    const url = new URL(u);
    return url.protocol + "//" + regDomain(url.hostname);
  } catch {
    return "";
  }
}
function originOf(u) {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin + "/" : "";
  } catch {
    return "";
  }
}

// Collect cookies for a domain, including CHIPS-partitioned cookies stored under
// the given top-level site (how third-party embeds like Loom store CloudFront
// cookies). HttpOnly cookies are included because this runs with host access.
async function cookieHeaderForDomain(domain, topSite) {
  const merged = new Map();
  const add = (arr) => (arr || []).forEach((c) => merged.set(c.name, c.value));
  try {
    add(await chrome.cookies.getAll({ domain }));
  } catch {}
  if (topSite) {
    try {
      add(await chrome.cookies.getAll({ domain, partitionKey: { topLevelSite: topSite } }));
    } catch {}
  }
  return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

const RULE_TYPES = ["xmlhttprequest", "media", "other"];
// Only this extension's own tab-less requests: TAB_ID_NONE alone would also
// match websites' service workers, so require our origin as the initiator.
// (Note: chrome.downloads requests started from a service worker bypass DNR.)
function ownRequests(domains) {
  return { requestDomains: domains, resourceTypes: RULE_TYPES, tabIds: [chrome.tabs.TAB_ID_NONE], initiatorDomains: [chrome.runtime.id] };
}

// Per-domain header rules: the page's Referer plus that domain's cookies. We
// cover the playlist's domain, the page's domain, and common video hosts, since
// segments often live on a different host than the playlist (e.g. Loom/Bunny).
async function installAuthRules(job, itemUrl) {
  const topSite = siteOf(job.pageUrl);
  const referer = originOf(job.pageUrl) || originOf(itemUrl);
  const pageDomain = regDomain(hostOf(job.pageUrl));
  const domains = [...new Set([regDomain(hostOf(itemUrl)), pageDomain, "loom.com", "b-cdn.net"])].filter(Boolean);
  const rules = [];
  for (let i = 0; i < domains.length && i < 8; i++) {
    // A shared suffix like b-cdn.net gets the Referer only, never pooled cookies.
    const cookie = isPublicSuffix(domains[i]) ? "" : await cookieHeaderForDomain(domains[i], topSite);
    const headers = [];
    if (referer) headers.push({ header: "referer", operation: "set", value: referer });
    if (cookie) headers.push({ header: "cookie", operation: "set", value: cookie });
    if (!headers.length) continue;
    rules.push({
      id: job.ruleBase + i,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: headers },
      condition: ownRequests([domains[i]]),
    });
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id), addRules: rules });
  return [...new Set([...(job.ruleIds || []), ...rules.map((r) => r.id)])];
}

// Remove leftovers: legacy persistent dynamic rules (≤1.11 rewrote Cookie/Referer
// on normal browsing) and session rules of jobs that are no longer running.
async function cleanupRules() {
  const dyn = await chrome.declarativeNetRequest.getDynamicRules();
  if (dyn.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: dyn.map((r) => r.id) });
  const keep = new Set([...jobs.values()].filter((j) => !isTerminal(j)).flatMap((j) => j.ruleIds || []));
  const stale = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id).filter((id) => !keep.has(id));
  if (stale.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
}

// Diagnostic: list the page's frame hosts so we can see if a Loom iframe exists.
async function frameDiag(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const hosts = frames.map((f) => hostOf(f.url) || f.url || "?").filter((h, i, a) => a.indexOf(h) === i);
    return `frames[${hosts.join(",")}]`;
  } catch (e) {
    return "frames-err:" + (e?.message || e);
  }
}

function friendlyError(raw, status) {
  const msg = String(raw || "");
  if (/DRM-protected/i.test(msg)) return msg;
  if (status === 401 || status === 403 || /\((401|403)\)/.test(msg)) {
    return "The video host refused access (the link may have expired). Reload the lesson, press play, and try again.";
  }
  if (status === 404 || status === 410) return "The video host no longer has this stream. Reload the lesson and try again.";
  if (/ffmpeg/i.test(msg)) return "Couldn't merge the audio and video. Try a lower quality.";
  if (/timed out|failed to fetch|network/i.test(msg)) return "Network problem while downloading. Check your connection and try again.";
  return msg.replace(/\[off[\d.]+\]\s*/g, "").slice(0, 180) || "Download failed.";
}

// --- Loom -----------------------------------------------------------------------
// Find the Loom iframe that played this item (by the document that requested
// it, else by video id in the URL), read its video id, and call Loom's own API
// from inside that frame (so cookies flow) to get a direct signed MP4 URL.
async function tryLoomApi(job) {
  try {
    if (job.tabId == null || job.tabId < 0) return { error: "no tabId" };
    const frames = await chrome.webNavigation.getAllFrames({ tabId: job.tabId });
    const looms = (frames || []).filter((f) => regDomain(hostOf(f.url)) === "loom.com" && LOOM_ID.test(f.url || ""));
    if (!looms.length) return { error: "no loom frame" };
    const idOf = (f) => LOOM_ID.exec(f.url)[2];
    const frame =
      looms.find((f) => job.item.documentId && f.documentId === job.item.documentId) ||
      looms.find((f) => job.item.url.includes(idOf(f))) ||
      looms[0];
    const out = await chrome.scripting.executeScript({
      target: { tabId: job.tabId, frameIds: [frame.frameId] },
      func: loomApiFetch,
      args: [idOf(frame)],
    });
    const r = out?.[0]?.result;
    if (!r?.ok || !r.url) return { error: r?.error || "loom api: no url" };

    // Send the Loom page as referer (like Loom's own player) for our probe and
    // the offscreen HLS fetches of the signed URL.
    const ruleId = job.ruleBase + 9;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 2,
          action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: "https://www.loom.com/" }] },
          condition: ownRequests(["loom.com", "cloudfront.net"]),
        },
      ],
    });
    job.ruleIds = [...new Set([...(job.ruleIds || []), ruleId])];

    // Loom's URL may have no file extension: HLS playlists start with #EXTM3U.
    const p = pathOf(r.url);
    if (DASH_EXT.test(p)) return { error: "loom returned a DASH manifest" };
    if (/\.mp4$/i.test(p)) return { mp4Url: r.url };
    if (HLS_EXT.test(p)) return { hlsUrl: r.url };
    return (await looksLikeHls(r.url)) ? { hlsUrl: r.url } : { mp4Url: r.url };
  } catch (e) {
    return { error: "loom-inject: " + (e?.message || e) };
  }
}

// Read only the first bytes (the server may ignore Range and send the whole file).
async function looksLikeHls(url) {
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-255" } });
    if (/mpegurl/i.test(res.headers.get("content-type") || "")) {
      res.body?.cancel().catch(() => {});
      return true;
    }
    const reader = res.body?.getReader();
    const { value } = (await reader?.read()) || {};
    reader?.cancel().catch(() => {});
    return !!value && new TextDecoder().decode(value.slice(0, 64)).includes("#EXTM3U");
  } catch {
    return false;
  }
}

// Runs inside the Loom iframe (same-origin to the Loom API, so cookies apply).
async function loomApiFetch(id) {
  async function tryEndpoint(ep) {
    try {
      const r = await fetch(`https://www.loom.com/api/campaigns/sessions/${id}/${ep}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force_original: false, password: null, anonID: null, deviceID: null }),
      });
      if (!r.ok) return { url: null, status: r.status };
      const j = await r.json();
      return { url: j?.url || (Array.isArray(j?.urls) ? j.urls[0] : null), status: 200 };
    } catch (e) {
      return { url: null, status: "ex:" + (e?.message || e) };
    }
  }
  const isMp4 = (u) => u && /\.mp4(\?|$)/i.test(u);
  const [t, raw] = await Promise.all([tryEndpoint("transcoded-url"), tryEndpoint("raw-url")]);
  // Prefer a direct MP4 (raw original first), otherwise fall back to any URL
  // (likely an HLS playlist), which the caller will assemble.
  const mp4 = [raw.url, t.url].find(isMp4);
  if (mp4) return { ok: true, url: mp4 };
  const any = t.url || raw.url;
  if (any) return { ok: true, url: any };
  return { ok: false, error: `transcoded=${t.status} raw=${raw.status}` };
}

// --- In-frame fallback --------------------------------------------------------
// Inject a self-contained assembler into the frame whose origin owns the media
// host, and let it fetch + save from there (cookies are attached automatically).
async function tryFrameDownload(job) {
  try {
    if (job.tabId == null || job.tabId < 0) return { ok: false, error: "no tabId" };
    const url = job.assembleUrl || job.item.url;
    const frames = await chrome.webNavigation.getAllFrames({ tabId: job.tabId });
    const target = regDomain(hostOf(url));
    const cand = (frames || []).filter((f) => f.url && regDomain(hostOf(f.url)) === target);
    const frame =
      cand.find((f) => job.item.documentId && f.documentId === job.item.documentId) || cand.find((f) => f.frameId !== 0) || cand[0];
    if (!frame) return { ok: false, error: "no frame for " + target };
    const out = await chrome.scripting.executeScript({
      target: { tabId: job.tabId, frameIds: [frame.frameId] },
      func: frameAssembler,
      args: [url, job.assembleKind || job.item.kind, sanitize(job.item.name), job.quality, job.id],
    });
    return out?.[0]?.result || { ok: false, error: "no result from frame" };
  } catch (e) {
    return { ok: false, error: "frame-inject: " + (e?.message || e) };
  }
}

// Runs inside a page frame (serialized by executeScript, so fully self-contained).
async function frameAssembler(playlistUrl, kind, filename, quality, jobId) {
  const result = await (async () => {
    const shared = new Set([
      "cloudfront.net", "amazonaws.com", "s3.amazonaws.com", "b-cdn.net", "akamaized.net", "azureedge.net",
      "azurewebsites.net", "blob.core.windows.net", "github.io", "herokuapp.com", "vercel.app", "netlify.app",
      "pages.dev", "workers.dev", "r2.dev", "web.app", "firebaseapp.com", "appspot.com", "googleusercontent.com",
      "googleapis.com", "storage.googleapis.com", "blogspot.com", "fly.dev", "onrender.com",
    ]);
    const isSfx = (d) => {
      const p = d.split(".");
      return (
        p.length === 1 ||
        (p.length === 2 && p[1].length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go|gv|ltd|plc|nom|sch|mil|info|biz)$/i.test(p[0])) ||
        shared.has(d.toLowerCase())
      );
    };
    const rd = (h) => {
      const p = (h || "").split(".").filter(Boolean);
      for (let n = 2; n <= p.length; n++) {
        const d = p.slice(-n).join(".");
        if (!isSfx(d)) return d;
      }
      return p.join(".");
    };
    const creds = (url) => {
      try {
        return rd(new URL(url).hostname) === rd(location.hostname) ? "include" : "omit";
      } catch {
        return "omit";
      }
    };
    const resolveUrl = (b, r) => new URL(r, b).href;
    const searchOf = (u) => {
      try {
        return new URL(u).search || "";
      } catch {
        return "";
      }
    };
    // Signed playlists (CloudFront etc.): carry the query onto children lacking one.
    const sign = (u, q) => {
      try {
        return q && !new URL(u).search ? u + q : u;
      } catch {
        return u;
      }
    };
    const attrs = (line) => {
      const a = {};
      const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
      let m;
      while ((m = re.exec(line))) a[m[1]] = m[3] ?? m[2];
      return a;
    };
    let lastPct = -1;
    let lastSentAt = 0;
    const progress = (done, total) => {
      const pct = total ? Math.floor((done / total) * 100) : 0;
      const now = Date.now();
      if (pct === lastPct && now - lastSentAt < 1000) return;
      lastPct = pct;
      lastSentAt = now;
      try {
        chrome.runtime
          .sendMessage({ type: "frame:progress", jobId, done, total })
          .then((r) => {
            if (r?.canceled) canceled = true;
          })
          .catch(() => {});
      } catch {}
    };
    let canceled = false;
    // Ask once more right before saving (progress replies can lag behind a cancel).
    const stillWanted = async () => {
      try {
        const r = await chrome.runtime.sendMessage({ type: "frame:progress", jobId, done: 0, total: 0, check: true });
        return !r?.canceled;
      } catch {
        return true;
      }
    };
    const ensureExt = (n, ext) => (/\.(mp4|webm|mov|m4v|mkv|ts)$/i.test(n) ? n : n + ext);
    const save = (blob, name) => {
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = name;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(u);
        a.remove();
      }, 120000);
    };
    // Fetch with retries on transient failures (network errors, 408/429/5xx).
    async function f(url, label, attempts = 4) {
      let lastErr;
      for (let i = 0; i < attempts; i++) {
        let res;
        try {
          res = await fetch(url, { credentials: creds(url) });
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 400 * 2 ** i));
          continue;
        }
        if (res.ok) return res;
        let body = "";
        try {
          body = (await res.text()).slice(0, 120).replace(/\s+/g, " ");
        } catch {}
        lastErr = new Error(`${label} (${res.status}) :: ${body}`);
        if (res.status !== 408 && res.status !== 429 && res.status < 500) throw lastErr;
        await new Promise((r) => setTimeout(r, 400 * 2 ** i));
      }
      throw lastErr;
    }

    try {
      if (kind === "file") {
        // Stream it so progress keeps the job alive and a cancel can stop it.
        const res = await f(playlistUrl, "Download failed");
        const total = parseInt(res.headers.get("content-length") || "0", 10) || 0;
        const parts = [];
        let got = 0;
        const reader = res.body.getReader();
        for (;;) {
          if (canceled) {
            reader.cancel().catch(() => {});
            throw new Error("canceled");
          }
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(new Blob([value]));
          got += value.byteLength;
          progress(got, total);
        }
        if (canceled || !(await stillWanted())) throw new Error("canceled");
        save(new Blob(parts, { type: res.headers.get("content-type") || "video/mp4" }), ensureExt(filename, ".mp4"));
        return { ok: true, mode: "frame-direct", ext: ".mp4" };
      }

      const signQ = searchOf(playlistUrl);
      let text = await (await f(playlistUrl, "Playlist failed")).text();
      let mediaUrl = playlistUrl;
      if (/#EXT-X-STREAM-INF/.test(text)) {
        const lines = text.split(/\r?\n/);
        const variants = [];
        let hasAudioRendition = false;
        for (let i = 0; i < lines.length; i++) {
          if (/^#EXT-X-MEDIA:.*TYPE=AUDIO.*URI=/.test(lines[i])) hasAudioRendition = true;
          if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
            const a = attrs(lines[i]);
            const uri = (lines[i + 1] || "").trim();
            const height = parseInt((a.RESOLUTION || "").split("x")[1] || "0", 10);
            if (uri && !uri.startsWith("#")) variants.push({ bw: parseInt(a.BANDWIDTH || "0", 10), uri, height });
          }
        }
        if (!variants.length) throw new Error("No variants");
        // Can't merge a separate audio track here; saving silent video would mislead.
        if (hasAudioRendition) throw new Error("stream has a separate audio track (needs the offscreen merger)");
        variants.sort((a, b) => a.bw - b.bw);
        const target = parseInt(quality, 10);
        let best = variants[variants.length - 1];
        if (quality === "lowest") best = variants[0];
        else if (target) {
          const below = variants.filter((v) => v.height && v.height <= target);
          if (below.length) best = below[below.length - 1];
        }
        mediaUrl = sign(resolveUrl(playlistUrl, best.uri), signQ);
        text = await (await f(mediaUrl, "Variant failed")).text();
      }
      const mediaQ = searchOf(mediaUrl) || signQ;

      const lines = text.split(/\r?\n/);
      const segs = [];
      let key = null,
        initU = null,
        seq0 = 0;
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
          seq0 = parseInt(line.split(":")[1] || "0", 10) || 0;
          continue;
        }
        if (line.startsWith("#EXT-X-BYTERANGE")) throw new Error("byte-range playlists aren't supported here");
        if (line.startsWith("#EXT-X-MAP")) {
          const a = attrs(line);
          if (a.URI) initU = sign(resolveUrl(mediaUrl, a.URI), mediaQ);
          continue;
        }
        if (line.startsWith("#EXT-X-KEY")) {
          const a = attrs(line);
          if (a.KEYFORMAT && a.KEYFORMAT !== "identity") continue;
          key = a.METHOD && a.METHOD !== "NONE" ? { method: a.METHOD, uri: a.URI ? sign(resolveUrl(mediaUrl, a.URI), mediaQ) : null, iv: a.IV || null } : null;
          continue;
        }
        if (line.startsWith("#")) continue;
        segs.push({ url: sign(resolveUrl(mediaUrl, line), mediaQ), key, seq: seq0 + segs.length });
      }
      if (!segs.length) throw new Error("No segments");
      if (segs.some((s) => s.key && s.key.method !== "AES-128")) throw new Error("DRM-protected stream");

      const fmp4 = !!initU;
      const ext = fmp4 ? ".mp4" : ".ts";
      // Cache the *promise* so concurrent workers share one key fetch per URI.
      const keyCache = new Map();
      function getKey(uri) {
        if (!keyCache.has(uri)) {
          keyCache.set(
            uri,
            (async () => {
              const buf = await (await f(uri, "Key failed")).arrayBuffer();
              return crypto.subtle.importKey("raw", buf, "AES-CBC", false, ["decrypt"]);
            })()
          );
        }
        return keyCache.get(uri);
      }
      const ivFor = (ki, s) => {
        const b = new Uint8Array(16);
        if (ki.iv) {
          const h = ki.iv.replace(/^0x/i, "").padStart(32, "0").slice(-32);
          for (let i = 0; i < 16; i++) b[i] = parseInt(h.substr(i * 2, 2), 16) || 0;
          return b;
        }
        new DataView(b.buffer).setUint32(12, s >>> 0, false);
        return b;
      };

      let initBytes = null;
      if (initU) initBytes = new Uint8Array(await (await f(initU, "Init failed")).arrayBuffer());

      // Download segments with bounded concurrency, storing each by index so the
      // final order is preserved.
      const parts = new Array(segs.length);
      let done = 0;
      let next = 0;
      let failed = null;
      async function worker() {
        while (!failed) {
          if (canceled) failed = new Error("canceled");
          const i = next++;
          if (failed || i >= segs.length) return;
          const s = segs[i];
          try {
            let buf = await (await f(s.url, `Segment ${i + 1}/${segs.length} failed`)).arrayBuffer();
            if (s.key) {
              const k = await getKey(s.key.uri);
              buf = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivFor(s.key, s.seq) }, k, buf);
            }
            parts[i] = new Blob([buf]);
          } catch (e) {
            failed ||= e;
            return;
          }
          progress(++done, segs.length);
        }
      }
      await Promise.all(Array.from({ length: Math.min(12, segs.length) }, worker));
      if (canceled || (!failed && !(await stillWanted()))) failed ||= new Error("canceled");
      if (failed) throw failed;

      save(new Blob(initBytes ? [initBytes, ...parts] : parts, { type: fmp4 ? "video/mp4" : "video/mp2t" }), ensureExt(filename, ext));
      return { ok: true, mode: "frame-hls", ext };
    } catch (e) {
      return { ok: false, error: "[frame] " + (e?.message || String(e)) };
    }
  })();
  // Report completion directly too, so a restarted service worker still hears it.
  try {
    chrome.runtime.sendMessage({ type: "frame:done", jobId, ...result }).catch(() => {});
  } catch {}
  return result;
}

// --- Filenames ------------------------------------------------------------------
// Mirrors Chromium's IsSafePortableRelativePath, which makes downloads.download
// reject a name: control/format chars (incl. zero-width joiners inside emoji),
// reserved characters, leading/trailing dots, spaces or "~", and Windows
// device names (also with an extension, e.g. "CON.mp4").
function sanitize(name) {
  let s = String(name || "")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\u{FDD0}-\u{FDEF}\u{FFFE}\u{FFFF}]/gu, "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  s = [...s].slice(0, 120).join(""); // by code point, so emoji aren't split
  s = s.replace(/^[\s.~]+|[\s.~]+$/g, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = "_" + s;
  return s || "video";
}

// Sanitize a relative subfolder (allows nested "a/b", strips unsafe parts).
function sanitizeFolder(f) {
  return (f || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .map((s) => sanitize(s))
    .join("/");
}

// Build the chrome.downloads filename (relative to Downloads), including folder.
function targetName(job, ext) {
  return (job.folder ? job.folder + "/" : "") + sanitize(job.item.name) + ext;
}
function fallbackName(job, ext) {
  return "video-" + job.id + ext;
}

// --- Offscreen management ---------------------------------------------------
// One offscreen document is reused while jobs are running (so the 32MB ffmpeg
// engine stays loaded between queued jobs) and closed when idle, which frees
// ffmpeg's wasm heap (it never shrinks) and any leftover blobs.
let offscreenOp = Promise.resolve();
function withOffscreenLock(fn) {
  const run = offscreenOp.then(fn, fn);
  offscreenOp = run.catch(() => {});
  return run;
}
async function hasOffscreen() {
  try {
    if (chrome.runtime.getContexts) {
      return (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0;
    }
    return !!(await chrome.offscreen.hasDocument?.());
  } catch {
    return false;
  }
}
// createDocument resolves after the page loaded, so its listener is ready.
function ensureOffscreen() {
  return withOffscreenLock(async () => {
    if (await hasOffscreen()) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS", "WORKERS"],
      justification: "Fetch and assemble video segments into a single downloadable file.",
    });
  });
}
function maybeCloseOffscreen() {
  return withOffscreenLock(async () => {
    const busy = [...jobs.values()].some((j) => !isTerminal(j) && j.route === "offscreen");
    if (busy || !(await hasOffscreen())) return;
    try {
      await chrome.offscreen.closeDocument();
    } catch {}
  });
}
function sendToOffscreen(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}
function revokeBlob(blobUrl) {
  hasOffscreen().then((has) => {
    if (has) sendToOffscreen({ type: "offscreen:revoke", blobUrl }).catch(() => {});
  });
}
