const { createWorld } = require('./sw-harness.cjs');
const S = '?sig=ok';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const LOOMID = 'a'.repeat(32);
const topFrame = () => ({ frameId: 0, url: 'https://www.skool.com/c/classroom?md=abc', documentId: 'doc-top' });
const baseDl = (w, item, extra = {}) => w.popup({ type: 'popup:download', tabId: 1, pageUrl: 'https://www.skool.com/c/classroom?md=abc', quality: 'highest', folder: 'Course', saveAs: false, item: { kind: 'hls', name: '01 - Lesson', ...item }, ...extra });
const jobDone = (w, id) => w.until(async () => { const j = (await w.jobs()).find((x) => x.id === id); return j && ['done', 'error', 'canceled'].includes(j.status) && j; }, 60000, 'job ' + id);
const getJob = async (w, id) => (await w.jobs()).find((x) => x.id === id);
const which = process.argv[2];

(async () => {
  if (!which || which === 'wake') {
    // SW terminated during a long quiet phase (e.g. mux.js fallback / faststart);
    // offscreen:done wakes a fresh worker.
    const w = createWorld({ frames: { 1: [topFrame()] }, server: { delayMs: 100 } });
    w.autoWake = true;
    w.startSW(); await tick();
    const res = await baseDl(w, { url: 'https://cdn.test/split/master.m3u8' + S });
    await w.until(() => w.offscreen, 5000, 'offscreen');
    const off = w.offscreen.off.ctx.chrome.runtime;
    const orig = off.sendMessage;
    let did = false;
    off.sendMessage = async (m) => {
      if (m.type === 'offscreen:done' && !did) {
        did = true;
        await tick(700); // debounced persist lands
        w.killSW();
        const s = await w.session.get('jobs');
        s.jobs.forEach((j) => (j.updatedAt -= 90000)); // 90s since the last progress message
        await w.session.set(s);
      }
      return orig(m);
    };
    const j = await jobDone(w, res.jobId);
    await tick(200);
    console.log('WAKE:', j.status, '|', j.error, '|', j.detail, '| downloads', w.downloads.length, w.downloads.map((d) => d.state + ':' + (d.error || '')), '| final', (await getJob(w, res.jobId)).status);
  }
  if (!which || which === 'cancel-loom') {
    // Cancel while chrome.downloads.download (remote Loom MP4) is still resolving.
    const frames = { 1: [topFrame(), { frameId: 5, url: 'https://www.loom.com/embed/' + LOOMID, documentId: 'doc-l1' }] };
    const w = createWorld({ frames, loomApi: (ep) => (ep === 'raw-url' ? { url: 'https://cdn.test/direct.mp4?sig=ok' } : null) });
    w.startSW(); await tick();
    const origDl = w.chrome.downloads.download;
    let release; const gate = new Promise((r) => (release = r));
    let entered = false;
    w.chrome.downloads.download = async (o) => { entered = true; await gate; return origDl(o); };
    const res = await baseDl(w, { url: 'https://luna.loom.com/id/zz/hls/playlist.m3u8' + S });
    await w.until(() => entered, 5000, 'download called');
    await w.popup({ type: 'popup:cancel', jobId: res.jobId });
    const after = (await getJob(w, res.jobId)).status;
    release();
    await tick(300);
    const j = await getJob(w, res.jobId);
    console.log('CANCEL-LOOM: after cancel', after, '-> final', j.status, '| downloads', w.downloads.map((d) => d.state), '| uiHold', j.uiHold);
  }
  if (!which || which === 'cancel-off') {
    // Cancel after the offscreen finished but before the blob download registered.
    const w = createWorld({ frames: { 1: [topFrame()] } });
    w.startSW(); await tick();
    const origDl = w.chrome.downloads.download;
    let release; const gate = new Promise((r) => (release = r));
    let entered = false;
    w.chrome.downloads.download = async (o) => { entered = true; await gate; return origDl(o); };
    const res = await baseDl(w, { url: 'https://cdn.test/muxed/master.m3u8' + S });
    await w.until(() => entered, 20000, 'download called');
    await w.popup({ type: 'popup:cancel', jobId: res.jobId });
    const after = (await getJob(w, res.jobId)).status;
    release();
    await tick(300);
    const j = await getJob(w, res.jobId);
    console.log('CANCEL-OFF: after cancel', after, '-> final', j.status, j.error || '', '| downloads', w.downloads.map((d) => d.state + ':' + (d.error || '')), '| offscreen', !!w.offscreen);
  }
  process.exit(0);
})();
