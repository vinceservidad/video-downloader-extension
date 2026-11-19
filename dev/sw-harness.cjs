// Mock-Chrome integration harness: real background.js (service worker) wired to
// the real offscreen.js (+ ffmpeg core) through an in-process runtime message bus.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeServer, loadOffscreen } = require('./harness.cjs');

const EXT = path.join(__dirname, '..');

function makeEvent() {
  const ls = [];
  return { addListener: (f) => ls.push(f), removeListener: (f) => ls.splice(ls.indexOf(f), 1), _ls: ls, fire: (...a) => ls.forEach((f) => f(...a)) };
}
function makeArea() {
  let data = {};
  return {
    get: async (keys) => {
      if (keys == null) return structuredClone(data);
      const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const o = {};
      for (const k of ks) if (k in data) o[k] = structuredClone(data[k]);
      return o;
    },
    set: async (o) => { Object.assign(data, structuredClone(o)); },
    remove: async (k) => { for (const x of [].concat(k)) delete data[x]; },
    _dump: () => data,
  };
}

// Chromium's download filename validation (subset of IsSafePortableRelativePath).
function invalidFilename(name) {
  return name.split('/').some((c) => !c || /[\p{Cc}\p{Cf}]/u.test(c) || /^[\s.~]|[\s.~]$/.test(c) || /[\\:*?"<>|]/.test(c) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(c) || c === '..');
}

function createWorld(opts = {}) {
  const world = {
    session: makeArea(),
    local: makeArea(),
    dynamicRules: opts.dynamicRules || [],
    sessionRules: [],
    downloads: [],
    uiOptions: [],
    badges: {},
    frames: opts.frames || {},
    loomApi: opts.loomApi || null,
    offscreen: null,
    popupInbox: [],
    offscreenCreates: 0,
    offscreenCloses: 0,
    server: makeServer(opts.server),
    ffstats: { loads: 0, execs: [], writes: 0, mounts: 0, terminates: 0 },
    sw: null,
    log: [],
  };
  const events = {
    onBeforeRequest: makeEvent(), onHeadersReceived: makeEvent(), onCommitted: makeEvent(), onHistoryStateUpdated: makeEvent(),
    onRemoved: makeEvent(), onMessage: makeEvent(), onChanged: makeEvent(), onInstalled: makeEvent(), onStartup: makeEvent(),
  };
  world.events = events;

  // ---- runtime message bus: SW <-> offscreen <-> popup
  function deliver(from, msg, cb) {
    // Chrome wakes a terminated worker when a message is sent to it.
    if (from !== 'sw' && !world.sw && world.autoWake) world.startSW();
    const targets = [];
    if (from !== 'sw' && world.sw) targets.push({ ls: events.onMessage._ls, sender: from === 'offscreen' ? { id: 'ext', url: 'chrome-extension://ext/offscreen.html' } : from === 'popup' ? { id: 'ext', url: 'chrome-extension://ext/popup.html' } : { id: 'ext', tab: { id: from.tabId }, frameId: from.frameId, documentId: from.documentId } });
    if (from !== 'offscreen' && world.offscreen) targets.push({ ls: world.offscreen.listeners, sender: { id: 'ext' } });
    if (from !== 'popup') world.popupInbox.push(msg);
    return new Promise((resolve) => {
      let responded = false;
      let async = false;
      const respond = (r) => { if (!responded) { responded = true; resolve({ r }); } };
      for (const t of targets) for (const fn of [...t.ls]) { if (fn(msg, t.sender, respond) === true) async = true; }
      if (!targets.length) return resolve({ err: 'Could not establish connection. Receiving end does not exist.' });
      if (!async && !responded) resolve({ err: 'The message port closed before a response was received.' });
    }).then(({ r, err }) => {
      if (cb) { world.chrome.runtime.lastError = err ? { message: err } : undefined; cb(r); world.chrome.runtime.lastError = undefined; return; }
      if (err && /Receiving end/.test(err)) throw new Error(err);
      return r;
    });
  }
  world.deliver = deliver;

  let dlSeq = 0;
  const chrome = {
    runtime: {
      id: 'ext',
      lastError: undefined,
      onMessage: events.onMessage,
      onInstalled: events.onInstalled,
      onStartup: events.onStartup,
      getURL: (p) => 'chrome-extension://ext/' + p,
      getManifest: () => JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')),
      sendMessage: (msg, cb) => deliver('sw', msg, cb),
      getContexts: async ({ contextTypes }) => (contextTypes.includes('OFFSCREEN_DOCUMENT') && world.offscreen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
    },
    storage: { session: world.session, local: world.local, onChanged: makeEvent() },
    tabs: { TAB_ID_NONE: -1, onRemoved: events.onRemoved, query: async () => [] },
    webRequest: { onBeforeRequest: events.onBeforeRequest, onHeadersReceived: events.onHeadersReceived },
    webNavigation: {
      onCommitted: events.onCommitted,
      onHistoryStateUpdated: events.onHistoryStateUpdated,
      getAllFrames: async ({ tabId }) => structuredClone(world.frames[tabId] || []),
    },
    action: {
      setBadgeText: async ({ tabId, text }) => { world.badges[tabId ?? 'global'] = text; },
      setBadgeBackgroundColor: async () => {},
    },
    declarativeNetRequest: {
      getDynamicRules: async () => structuredClone(world.dynamicRules),
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
        world.dynamicRules = world.dynamicRules.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
      },
      getSessionRules: async () => structuredClone(world.sessionRules),
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
        for (const r of addRules) {
          if (r.condition.tabIds && !world.sessionRules) throw new Error('x');
        }
        world.sessionRules = world.sessionRules.filter((r) => !removeRuleIds.includes(r.id));
        for (const r of addRules) {
          if (world.sessionRules.some((x) => x.id === r.id)) throw new Error('Rule with id ' + r.id + ' does not have a unique ID.');
          world.sessionRules.push(r);
        }
      },
    },
    cookies: { getAll: async () => [] },
    offscreen: {
      createDocument: async ({ url }) => {
        if (world.offscreen) throw new Error('Only a single offscreen document may be created.');
        world.offscreenCreates++;
        const off = loadOffscreen({ server: world.server, stats: world.ffstats, ...(opts.off || {}) });
        // Rewire offscreen's outgoing messages onto the bus.
        off.ctx.chrome.runtime.sendMessage = (msg) => deliver('offscreen', msg);
        off.ctx.chrome.runtime.id = 'ext';
        world.offscreen = { listeners: off.listeners, off };
      },
      closeDocument: async () => {
        if (!world.offscreen) throw new Error('No current offscreen document.');
        world.offscreenCloses++;
        world.offscreen = null;
      },
      hasDocument: async () => !!world.offscreen,
    },
    downloads: {
      download: async ({ url, filename, saveAs }) => {
        if (filename && invalidFilename(filename)) throw new Error('Invalid filename');
        const id = ++dlSeq;
        const item = { id, url, filename: '/Users/me/Downloads/' + filename, saveAs, state: 'in_progress', bytesReceived: 0 };
        world.downloads.push(item);
        const blob = url.startsWith('blob:') ? world.offscreen?.off.blobs.get(url) : null;
        setTimeout(() => {
          if (item.state !== 'in_progress') return;
          if (url.startsWith('blob:') && !blob) { item.state = 'interrupted'; item.error = 'FILE_FAILED'; }
          else { item.state = 'complete'; item.size = blob ? (blob._bytes?.length || blob.size) : 0; }
          events.onChanged.fire({ id, state: { current: item.state }, ...(item.error ? { error: { current: item.error } } : {}) });
        }, opts.downloadDelay ?? 5);
        return id;
      },
      search: async ({ id }) => world.downloads.filter((d) => d.id === id).map((d) => ({ ...d })),
      cancel: async (id) => {
        const d = world.downloads.find((x) => x.id === id);
        if (d && d.state === 'in_progress') { d.state = 'interrupted'; d.error = 'USER_CANCELED'; events.onChanged.fire({ id, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } }); }
      },
      setUiOptions: async (o) => { world.uiOptions.push(o.enabled); },
      onChanged: events.onChanged,
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        // Run the injected function in a fake frame context.
        const frames = world.frames[target.tabId] || [];
        const frame = frames.find((f) => f.frameId === target.frameIds[0]);
        if (!frame) throw new Error('No frame with id ' + target.frameIds[0]);
        const frameFetch = async (u, init) => {
          if (/loom\.com\/api\/campaigns\/sessions\//.test(u)) {
            const ep = u.split('/').pop();
            const r = world.loomApi?.(ep, u);
            if (!r) return new Response('nope', { status: 404 });
            return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return world.server.fetch(u, init);
        };
        const fctx = vm.createContext({ fetch: frameFetch, Response, Headers, URL, JSON, Promise, setTimeout, Uint8Array, DataView, Blob, crypto: require('crypto').webcrypto, location: new URL(frame.url), document: { createElement: () => ({ style: {}, click() { world.log.push('frame-save:' + this.download); }, remove() {} }), body: { appendChild() {} } }, chrome: { runtime: { sendMessage: (m) => deliver({ tabId: target.tabId, frameId: frame.frameId, documentId: frame.documentId }, m) } }, console });
        fctx.URL.createObjectURL = () => 'blob:frame/1';
        const fn = vm.runInContext('(' + func.toString() + ')', fctx);
        const result = await fn(...(args || []));
        return [{ result: JSON.parse(JSON.stringify(result ?? null)) }];
      },
    },
  };
  world.chrome = chrome;

  world.startSW = () => {
    // Fresh worker instance: drop old listeners (a terminated worker's closures die with it).
    for (const e of Object.values(events)) e._ls.length = 0;
    const ctx = {
      chrome, fetch: world.server.fetch, Response, Headers, URL, URLSearchParams, TextDecoder, TextEncoder, AbortController,
      setTimeout, clearTimeout, setInterval, clearInterval, console, Promise, Date, Math, JSON, Error, Map, Set, Array, Object, Number, String, structuredClone,
    };
    ctx.self = ctx; ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
    world.sw = ctx;
    return ctx;
  };
  world.killSW = () => {
    for (const e of Object.values(events)) e._ls.length = 0;
    world.sw = null;
  };
  world.popup = (msg) => deliver('popup', msg);
  world.req = (tabId, url, extra = {}) => {
    const d = { tabId, url, frameId: 0, documentId: 'doc-top', timeStamp: Date.now(), type: 'xmlhttprequest', ...extra };
    events.onBeforeRequest.fire(d);
    events.onHeadersReceived.fire({ ...d, statusCode: extra.statusCode || 200, responseHeaders: extra.ct ? [{ name: 'Content-Type', value: extra.ct }] : [] });
  };
  world.until = async (pred, ms = 60000, what = 'condition') => {
    const t = Date.now();
    for (;;) {
      const v = await pred();
      if (v) return v;
      if (Date.now() - t > ms) throw new Error('timeout waiting for ' + what);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  world.jobs = async () => (await world.session.get('jobs')).jobs || [];
  return world;
}

module.exports = { createWorld, invalidFilename };
