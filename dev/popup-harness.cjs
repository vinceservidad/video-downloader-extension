// Loads the real popup.js into a vm with a tiny fake DOM, wired to the
// sw-harness world (real background.js + offscreen.js).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..');

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.style = {};
    this._text = '';
    this.className = '';
    this.id = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.listeners = {};
    const self = this;
    this.classList = {
      toggle(c, on) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); if (on ?? !s.has(c)) s.add(c); else s.delete(c); self.className = [...s].join(' '); },
      contains(c) { return self.className.split(/\s+/).includes(c); },
    };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this.children = []; this._text = String(v).replace(/<[^>]+>/g, ' '); this._html = v; }
  get innerHTML() { return this._html || ''; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  prepend(c) { c.parent = this; this.children.unshift(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  querySelector(sel) { const cls = sel.replace(/^\./, ''); return this.all().slice(1).find((e) => e.className.split(/\s+/).includes(cls)) || null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  async click() { for (const fn of this.listeners.click || []) await fn(); }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
  find(pred) { return this.all().find(pred); }
  findAll(pred) { return this.all().filter(pred); }
  visible() { for (let e = this; e; e = e.parent) { if (e.hidden || e.style.display === 'none') return false; } return true; }
}

function openPopup(world, { tab = { id: 1, url: 'https://www.skool.com/c/classroom?md=abc', title: 'M4: Structure Overview - Skool' }, lesson = { number: 3, total: 10 }, lessonDelay = 0 } = {}) {
  const byId = {};
  for (const id of ['list', 'count', 'ver', 'quality', 'ask', 'folderRow', 'folder']) {
    const e = new El(id === 'quality' ? 'select' : id === 'ask' || id === 'folder' ? 'input' : 'div');
    e.id = id;
    byId[id] = e;
  }
  const listeners = [];
  const chrome = {
    runtime: {
      id: 'ext',
      lastError: undefined,
      getManifest: () => JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')),
      sendMessage: (msg, cb) => {
        world.deliver('popup', msg, (r) => { chrome.runtime.lastError = world.chrome.runtime.lastError; cb(r); chrome.runtime.lastError = undefined; });
      },
      onMessage: { addListener: (f) => listeners.push(f) },
    },
    storage: { local: world.local },
    tabs: {
      query: async () => [tab],
      sendMessage: (tabId, msg, opts, cb) => { setTimeout(() => cb(lesson), lessonDelay); },
    },
    scripting: { executeScript: async () => [] },
    downloads: { search: (q) => world.chrome.downloads.search(q) },
  };
  // Route SW/offscreen broadcasts to this popup (async, like IPC).
  world.popupInbox = { push: (m) => setTimeout(() => listeners.forEach((f) => f(m, { id: 'ext' }, () => {})), 0) };
  const document = {
    getElementById: (id) => byId[id] || null,
    createElement: (t) => new El(t),
  };
  const ctx = { chrome, document, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Map, Set, JSON, Date, Math, String, Number };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(process.env.POPUP || path.join(EXT, 'popup.js'), 'utf8'), ctx, { filename: 'popup.js' });
  const list = byId.list;
  const cards = () => list.findAll((e) => e.className === 'item');
  const cardInfo = (c) => ({
    fname: c.find((e) => e.className === 'fname').value,
    btn: c.find((e) => e.tagName === 'BUTTON' && e.className !== 'cancel'),
    cancel: c.find((e) => e.className === 'cancel'),
    status: c.find((e) => e.className.startsWith('status')),
    details: c.find((e) => e.tagName === 'DETAILS'),
    visible: c.visible(),
  });
  return { byId, list, cards, cardInfo, listeners, ctx, close: () => { world.popupInbox = []; } };
}

module.exports = { openPopup, El };
