const { createWorld } = require('./sw-harness.cjs');
const S = '?sig=ok';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const LOOMID = 'a'.repeat(32);
const topFrame = () => ({ frameId: 0, url: 'https://www.skool.com/c/classroom?md=abc', documentId: 'doc-top' });
const baseDl = (w, item, extra = {}) => w.popup({ type: 'popup:download', tabId: 1, pageUrl: 'https://www.skool.com/c/classroom?md=abc', quality: 'highest', folder: 'Course', saveAs: false, item: { kind: 'hls', name: '01 - Lesson', ...item }, ...extra });
const getJob = async (w, id) => (await w.jobs()).find((x) => x.id === id);
const jobDone = (w, id) => w.until(async () => { const j = (await w.jobs()).find((x) => x.id === id); return j && ['done', 'error', 'canceled'].includes(j.status) && j; }, 60000, 'job ' + id);

(async () => {
  const which = process.argv[2] || 'all';

  if (which === 'all' || which === 't1') {
    // 1) Cancel while chrome.downloads.download() for the Loom MP4 is still pending (TTFB).
    const frames = { 1: [topFrame(), { frameId: 5, url: 'https://www.loom.com/embed/' + LOOMID, documentId: 'doc-l1' }] };
    const w = createWorld({ frames, loomApi: (ep) => (ep === 'raw-url' ? { url: 'https://cdn.test/direct.mp4?sig=ok' } : null), downloadDelay: 200 });
    w.startSW(); await tick();
    const orig = w.chrome.downloads.download;
    let release; const gate = new Promise((r) => (release = r));
    w.chrome.downloads.download = async (o) => { await gate; return orig(o); };
    const res = await baseDl(w, { url: 'https://luna.loom.com/id/zz/hls/playlist.m3u8' + S });
    await w.until(() => w.popupInbox.some((m) => m.type === 'job:update' && m.job.id === res.jobId && m.job.route === 'loom-api'), 5000, 'loom-api');
    await tick(20);
    await w.popup({ type: 'popup:cancel', jobId: res.jobId });
    await tick(50);
    console.log('T1 after cancel:', (await getJob(w, res.jobId)).status);
    release();
    await tick(600);
    const j = await getJob(w, res.jobId);
    console.log('T1 final status:', j.status, 'downloads:', w.downloads.map((d) => d.state), 'ui:', w.uiOptions);
  }

  if (which === 'all' || which === 't2') {
    // 2) Cancel while the job is between ensureOffscreen and the assemble ack, with another job active.
    const w = createWorld({ frames: { 1: [topFrame()] }, server: { delayMs: 400 } });
    w.startSW(); await tick();
    const a = await baseDl(w, { url: 'https://cdn.test/split/master.m3u8' + S });
    await w.until(() => w.popupInbox.some((m) => m.type === 'job:update' && m.job.id === a.jobId && m.job.status === 'downloading'), 20000, 'a downloading');
    // Delay the assemble delivery of the second job a little.
    const origSend = w.chrome.runtime.sendMessage;
    let release; const gate = new Promise((r) => (release = r));
    w.chrome.runtime.sendMessage = (msg, cb) => {
      if (msg.type === 'offscreen:assemble' && msg.jobId !== a.jobId) { gate.then(() => origSend(msg, cb)); return; }
      return origSend(msg, cb);
    };
    const b = await baseDl(w, { url: 'https://cdn.test/muxed/master.m3u8' + S, name: '02' });
    await w.until(() => w.popupInbox.some((m) => m.type === 'job:update' && m.job.id === b.jobId && m.job.route === 'offscreen'), 5000, 'b offscreen');
    await tick(50);
    await w.popup({ type: 'popup:cancel', jobId: b.jobId });
    release();
    await tick(100);
    const off = w.offscreen?.off;
    console.log('T2 b status:', (await getJob(w, b.jobId)).status);
    // Is the canceled job queued/active in the offscreen?
    const st = await new Promise((r) => w.offscreen.listeners[0]({ type: 'offscreen:status' }, { id: 'ext' }, r));
    console.log('T2 offscreen status after cancel:', JSON.stringify(st), 'b=', b.jobId);
    await jobDone(w, a.jobId);
    await tick(100);
    const hitsBefore = [...w.server.hits.entries()].filter(([k]) => k.startsWith('muxed')).reduce((n, [, v]) => n + v, 0);
    await tick(3000);
    const hitsAfter = [...w.server.hits.entries()].filter(([k]) => k.startsWith('muxed')).reduce((n, [, v]) => n + v, 0);
    console.log('T2 muxed fetches after a finished (canceled job b still downloading?):', hitsBefore, '->', hitsAfter, 'offscreen open:', !!w.offscreen);
  }
  process.exit(0);
})();
