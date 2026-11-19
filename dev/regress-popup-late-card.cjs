const { createWorld } = require('./sw-harness.cjs');
const { openPopup } = require('./popup-harness.cjs');
const S = '?sig=ok';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const LOOMID = 'a'.repeat(32), LOOMID2 = 'b'.repeat(32);
const topFrame = () => ({ frameId: 0, url: 'https://www.skool.com/c/classroom?md=abc', documentId: 'doc-top' });
const dl = (w, item, extra = {}) => w.popup({ type: 'popup:download', tabId: 1, pageUrl: 'https://www.skool.com/c/classroom?md=abc', quality: 'highest', folder: 'Course', saveAs: false, item: { kind: 'hls', name: '01 - Lesson', ...item }, ...extra });
(async () => {
  // Previous lesson's job finishes while the popup is waiting for the lesson number.
  const w = createWorld({ frames: { 1: [topFrame(), { frameId: 5, url: 'https://www.loom.com/embed/' + LOOMID, documentId: 'doc-l1' }] }, loomApi: (ep) => (ep === 'raw-url' ? { url: 'https://cdn.test/direct.mp4?sig=ok' } : null), downloadDelay: 250 });
  w.startSW(); await tick();
  const U1 = 'https://luna.loom.com/id/l1/hls/playlist.m3u8' + S;
  w.req(1, U1, { frameId: 5, documentId: 'doc-l1' });
  await tick();
  const res = await dl(w, { url: U1 });
  await w.until(async () => (await w.jobs()).find((j) => j.id === res.jobId && j.status === 'saving'), 5000, 'saving');
  w.events.onHistoryStateUpdated.fire({ tabId: 1, frameId: 0, url: 'https://www.skool.com/c/classroom?md=def', timeStamp: Date.now() });
  w.frames[1] = [topFrame(), { frameId: 8, url: 'https://www.loom.com/embed/' + LOOMID2, documentId: 'doc-l2' }];
  await tick(20);
  const p = openPopup(w, { lessonDelay: 0 });
  await tick(1500);
  const infos = p.cards().map((c) => p.cardInfo(c));
  const jobs = await w.jobs();
  console.log('job status:', jobs.find((j) => j.id === res.jobId).status);
  console.log('cards:', infos.map((i) => i.fname + ' | ' + i.status.textContent));
  process.exit(0);
})();
