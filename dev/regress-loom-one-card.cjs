const { createWorld } = require('./sw-harness.cjs');
const { openPopup } = require('./popup-harness.cjs');
const S = '?sig=ok';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const LOOMID = 'a'.repeat(32);
const top = (md='abc') => ({ frameId: 0, url: 'https://www.skool.com/c/classroom?md='+md, documentId: 'doc-top' });
const jobDone = (w, id) => w.until(async () => { const j = (await w.jobs()).find((x) => x.id === id); return j && ['done', 'error', 'canceled'].includes(j.status) && j; }, 60000, 'job ' + id);
const log = (...a) => console.log(...a);
(async () => {
  // placeholder download, then user presses play (HLS detected) while the MP4 is still downloading
  const w = createWorld({ frames: { 1: [top(), { frameId: 5, url: 'https://www.loom.com/embed/' + LOOMID + '?sid=1', documentId: 'dl1' }] },
    loomApi: (ep) => ep === 'raw-url' ? { url: 'https://cdn.test/direct.mp4?sig=ok' } : null, downloadDelay: 3000 });
  w.startSW(); await tick();
  let p = openPopup(w, { lesson: { number: 1, total: 3 }, tab: { id: 1, url: top().url, title: 'Lesson One - Skool' } });
  await tick(150);
  log('cards', p.cards().map((c) => p.cardInfo(c).fname));
  await p.cardInfo(p.cards()[0]).btn.click();
  await tick(300);
  p.close();
  w.req(1, 'https://luna.loom.com/id/'+LOOMID+'/hls/playlist.m3u8' + S, { frameId: 5, documentId: 'dl1' });
  await tick(50);
  p = openPopup(w, { lesson: { number: 1, total: 3 }, tab: { id: 1, url: top().url, title: 'Lesson One - Skool' } });
  await tick(200);
  log('reopen cards', p.cards().map((c) => { const i = p.cardInfo(c); return i.fname + '|' + i.btn.style.display + '|' + i.btn.disabled + '|' + i.status.textContent + '|' + c.textContent.slice(0,60); }));
  const master = p.cards().map((c) => p.cardInfo(c)).find((i) => i.btn.style.display !== 'none');
  await master.btn.click();
  await tick(4000);
  log('downloads', w.downloads.map((d) => d.filename));
  process.exit(0);
})();
