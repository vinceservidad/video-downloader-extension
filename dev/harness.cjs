// Node test harness for offscreen.js (run via `node dev/run-all.cjs`): fake CDN (sign-query + Range + fault injection),
// Blob/FileReaderSync shims, and an FFmpegWASM shim backed by the real vendored
// ffmpeg core. Outputs are validated by decoding them with the same core.
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { webcrypto } = require('crypto');

const EXT = path.join(__dirname, '..');
const VENDOR = path.join(EXT, 'vendor');
const FIX = path.join(__dirname, 'fixtures');
const OUTDIR = path.join(require('os').tmpdir(), 'mvd-test-out', process.env.OUT || 'out');
fs.mkdirSync(OUTDIR, { recursive: true });

// ---------------------------------------------------------------- ffmpeg core
globalThis.self = globalThis;
const createFFmpegCore = require(path.join(VENDOR, 'ffmpeg-core.js'));
async function newCore() {
  return createFFmpegCore({
    locateFile: (p) => path.join(VENDOR, p),
    mainScriptUrlOrBlob:
      path.join(VENDOR, 'ffmpeg-core.js') + '#' + Buffer.from(JSON.stringify({ wasmURL: path.join(VENDOR, 'ffmpeg-core.wasm') })).toString('base64'),
  });
}

// ---------------------------------------------------------------- Blob shim
const NodeBlob = globalThis.Blob;
function bytesOf(part) {
  if (part instanceof SyncBlob) return part._bytes;
  if (part instanceof ArrayBuffer) return new Uint8Array(part);
  if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
  if (typeof part === 'string') return new TextEncoder().encode(part);
  throw new Error('unsupported blob part ' + Object.prototype.toString.call(part));
}
class SyncBlob extends NodeBlob {
  constructor(parts = [], opts) {
    const arrs = parts.map(bytesOf);
    super(arrs, opts);
    const n = arrs.reduce((a, b) => a + b.byteLength, 0);
    const all = new Uint8Array(n);
    let o = 0;
    for (const a of arrs) { all.set(a, o); o += a.byteLength; }
    this._bytes = all;
  }
  slice(start = 0, end = this._bytes.byteLength, type) {
    return new SyncBlob([this._bytes.slice(start, end)], { type });
  }
}
class FileReaderSync {
  readAsArrayBuffer(blob) {
    const b = blob._bytes;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
}

// ---------------------------------------------------------------- fake CDN
function makeServer(opts = {}) {
  const hits = new Map();
  const failOnce = new Set(opts.failOnce || []);
  const sigRequired = opts.sig !== false;
  async function fakeFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const signal = init.signal;
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const p = url.pathname.replace(/^\//, '');
    hits.set(p, (hits.get(p) || 0) + 1);
    if (url.hostname !== 'cdn.test') return new Response('no host', { status: 404 });
    if (sigRequired && url.searchParams.get('sig') !== 'ok') return new Response('<Error><Code>MissingKey</Code></Error>', { status: 403 });
    if ((opts.forbid || []).some((f) => p.includes(f))) return new Response('forbidden', { status: 403 });
    if (opts.forbidOmit && init.credentials === 'omit') return new Response('need cookies', { status: 403 });
    if (opts.htmlOmit && init.credentials === 'omit') return new Response('<!DOCTYPE html><html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if ((opts.stall || []).some((f) => p.includes(f))) {
      // Headers arrive, then the body stalls forever (until the request is aborted).
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(100));
          signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    }
    if (failOnce.has(p)) { failOnce.delete(p); return new Response('busy', { status: 503 }); }
    const file = path.join(FIX, p);
    if (!fs.existsSync(file)) return new Response('not found ' + p, { status: 404 });
    const data = fs.readFileSync(file);
    const headers = new Headers(init.headers || {});
    const range = headers.get('range');
    const ctype = p.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : p.endsWith('.mpd') ? 'application/dash+xml' : p.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream';
    if (range && !opts.ignoreRange) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const s = +m[1];
      const e = m[2] ? +m[2] : data.length - 1;
      return new Response(data.subarray(s, e + 1), { status: 206, headers: { 'content-type': ctype, 'content-range': `bytes ${s}-${e}/${data.length}` } });
    }
    return new Response(data, { status: 200, headers: { 'content-type': ctype, 'content-length': String(data.length) } });
  }
  return { fetch: fakeFetch, hits };
}

// ---------------------------------------------------------------- FFmpeg shim
function makeFFmpegShim(stats, flags = {}) {
  class FFmpeg {
    constructor() { this.listeners = { log: [], progress: [] }; this.core = null; }
    on(ev, cb) { (this.listeners[ev] ||= []).push(cb); }
    async load({ coreURL, wasmURL } = {}) {
      stats.loads++;
      if (coreURL && !coreURL.endsWith('vendor/ffmpeg-core.js')) throw new Error('unexpected coreURL ' + coreURL);
      // Make the core believe it runs in a (classic) worker, like in Chrome, so
      // its real WORKERFS (assert(ENVIRONMENT_IS_WORKER) + FileReaderSync) works.
      globalThis.importScripts = () => {};
      globalThis.FileReaderSync = FileReaderSync;
      try {
        this.core = await newCore();
      } finally {
        delete globalThis.importScripts;
      }
      this.core.setLogger((m) => this.listeners.log.forEach((cb) => cb(m)));
      this.core.setProgress((p) => this.listeners.progress.forEach((cb) => cb(p)));
      return true;
    }
    #need() { if (!this.core) throw new Error('ffmpeg is not loaded, call `await ffmpeg.load()` first'); }
    async exec(args) { this.#need(); stats.execs.push(args); if (flags.execFails) throw new Error('RuntimeError: memory access out of bounds'); if (flags.mountedExecFails && args.some((a) => /^\/in\d+\//.test(a)) && this._mounted) return 1; this.core.exec(...args); const r = this.core.ret; this.core.reset(); return r; }
    async writeFile(p, data) {
      this.#need(); stats.writes++;
      // Real @ffmpeg/ffmpeg transfers (detaches) Uint8Array buffers to the worker.
      const copy = data instanceof Uint8Array ? structuredClone(data, { transfer: [data.buffer] }) : data;
      this.core.FS.writeFile(p, copy); return true;
    }
    async readFile(p) { this.#need(); return this.core.FS.readFile(p); }
    async deleteFile(p) { this.#need(); this.core.FS.unlink(p); return true; }
    async createDir(p) { this.#need(); this.core.FS.mkdir(p); return true; }
    async deleteDir(p) { this.#need(); this.core.FS.rmdir(p); return true; }
    async listDir(p) { this.#need(); return this.core.FS.readdir(p).map((name) => ({ name })); }
    async mount(fsType, options, mountPoint) {
      this.#need(); stats.mounts++;
      if (flags.mountFails) throw new Error('mount unsupported');
      const f = this.core.FS.filesystems[fsType];
      if (!f) return false;
      stats.realMounts = (stats.realMounts || 0) + 1;
      // structured clone of Blobs to the worker is by reference
      this.core.FS.mount(f, options, mountPoint); this._mounted = true; return true;
    }
    async unmount(mountPoint) { this.#need(); this.core.FS.unmount(mountPoint); this._mounted = false; return true; }
    terminate() { stats.terminates++; this.core = null; }
  }
  return { FFmpeg };
}

// ---------------------------------------------------------------- offscreen VM
function loadOffscreen({ server, stats, noFFmpeg, mountFails, execFails, mountedExecFails }) {
  const listeners = [];
  const outbox = [];
  const blobs = new Map();
  let blobSeq = 0;
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (msg) => { outbox.push(msg); return Promise.resolve(); },
      getURL: (p) => 'chrome-extension://test/' + p,
      id: 'test',
    },
  };
  const URLShim = class extends URL {};
  URLShim.createObjectURL = (b) => { const u = 'blob:chrome-extension://test/' + ++blobSeq; blobs.set(u, b); return u; };
  URLShim.revokeObjectURL = (u) => blobs.delete(u);
  const ctx = {
    chrome, fetch: server.fetch, Response, Headers, Request, AbortController, AbortSignal,
    Blob: SyncBlob, FileReaderSync, URL: URLShim, URLSearchParams, TextEncoder, TextDecoder,
    crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    console, Uint8Array, ArrayBuffer, DataView, Promise, Date, Math, JSON, Error, Map, Set,
    structuredClone, performance,
  };
  ctx.self = ctx; ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'muxjs.min.js'), 'utf8'), ctx, { filename: 'muxjs.min.js' });
  if (!noFFmpeg) ctx.FFmpegWASM = makeFFmpegShim(stats, { mountFails, execFails, mountedExecFails });
  vm.runInContext(fs.readFileSync(process.env.OFFSCREEN || path.join(EXT, 'offscreen.js'), 'utf8'), ctx, { filename: 'offscreen.js' });
  function send(msg) {
    return new Promise((resolve) => {
      let answered = false;
      const sendResponse = (r) => { answered = true; resolve(r); };
      let asyncResp = false;
      for (const fn of listeners) if (fn(msg, { id: 'test' }, sendResponse) === true) asyncResp = true;
      if (!asyncResp && !answered) resolve(undefined);
    });
  }
  return { send, outbox, blobs, ctx, listeners };
}

// ---------------------------------------------------------------- probing
let probeCore;
async function probe(bytes, name) {
  probeCore ||= await newCore();
  const FS = probeCore.FS;
  const file = '/' + name;
  FS.writeFile(file, bytes);
  let log = [];
  probeCore.setLogger((m) => log.push(m.message));
  probeCore.exec('-v', 'info', '-i', file, '-f', 'null', '-');
  const ret = probeCore.ret; probeCore.reset();
  FS.unlink(file);
  const text = log.join('\n');
  const inText = text.split(/Output #0/)[0];
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
  const decoded = [...text.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  const toS = (m) => (m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null);
  return {
    ret,
    video: /Stream #0:\d+[^\n]*Video: h264/.test(text),
    audio: /Stream #0:\d+[^\n]*Audio: aac/.test(text),
    audioStreams: (inText.match(/Stream #0:\d+[^\n]*Audio:/g) || []).length,
    duration: toS(dur),
    decodedTo: toS(decoded),
    errors: (text.match(/(error|Invalid|corrupt|non-existing PPS|decode_slice)/gi) || []).length,
    format: (/Input #0, ([^,]+)/.exec(text) || [])[1],
    tail: log.slice(-4).join(' | '),
  };
}

module.exports = { makeServer, loadOffscreen, probe, OUTDIR, FIX, SyncBlob };
