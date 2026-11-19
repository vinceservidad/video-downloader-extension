// Popup behavior against the real background.js/offscreen.js (see sw-harness.cjs).
const { createWorld } = require('./sw-harness.cjs');
const { openPopup } = require('./popup-harness.cjs');
const S = '?sig=ok';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const LOOMID = 'a'.repeat(32), LOOMID2 = 'b'.repeat(32);
const topFrame = () => ({ frameId: 0, url: 'https://www.skool.com/c/classroom?md=abc', documentId: 'doc-top' });
const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, 'PASS']); console.log('PASS', name); }
  catch (e) { results.push([name, 'FAIL']); console.log('FAIL', name, '-', e.message); }
}
const ok = (c, what) => { if (!c) throw new Error(what); };
const dl = (w, item, extra = {}) => w.popup({ type: 'popup:download', tabId: 1, pageUrl: 'https://www.skool.com/c/classroom?md=abc', quality: 'highest', folder: 'Course', saveAs: false, item: { kind: 'hls', name: '01 - Lesson', ...item }, ...extra });
const jobDone = (w, id) => w.until(async () => { const j = (await w.jobs()).find((x) => x.id === id); return j && ['done', 'error', 'canceled'].includes(j.status) && j; }, 60000, 'job ' + id);
const loomWorld = (opts = {}) => createWorld({ frames: { 1: [topFrame(), { frameId: 5, url: 'https://www.loom.com/embed/' + LOOMID, documentId: 'doc-l1' }] }, loomApi: (ep) => (ep === 'raw-url' ? { url: 'https://cdn.test/direct.mp4?sig=ok' } : null), ...opts });

(async () => {
  await test('click Download (Loom MP4) -> lesson-prefixed name, Saved ✓', async () => {
    const w = loomWorld();
    w.startSW(); await tick();
    w.req(1, 'https://luna.loom.com/id/zz/hls/playlist.m3u8' + S, { frameId: 5, documentId: 'doc-l1' });
    await tick();
    const p = openPopup(w);
    await tick(100);
    const c = p.cardInfo(p.cards()[0]);
    ok(c.fname === '03 - M4: Structure Overview', 'fname ' + c.fname); // display keeps ':'; the SW sanitizes on save
    await c.btn.click();
    await tick(300);
    const st = p.cardInfo(p.cards()[0]).status.textContent;
    ok(/^Saved ✓ 03 - M4_ Structure Overview\.mp4/.test(st), 'status ' + st);
  });

  await test('job finishing while the popup opens is not overwritten by the older snapshot', async () => {
    const w = loomWorld({ downloadDelay: 150 });
    w.startSW(); await tick();
    const U = 'https://luna.loom.com/id/zz/hls/playlist.m3u8' + S;
    w.req(1, U, { frameId: 5, documentId: 'doc-l1' });
    await tick();
    const res = await dl(w, { url: U });
    await w.until(async () => (await w.jobs()).find((j) => j.id === res.jobId && j.status === 'saving'), 5000, 'saving');
    const p = openPopup(w, { lessonDelay: 400 });
    await jobDone(w, res.jobId);
    await tick(800);
    const c = p.cardInfo(p.cards()[0]);
    ok(/Saved ✓/.test(c.status.textContent), 'status ' + c.status.textContent);
    ok(!c.btn.disabled && c.cancel.style.display === 'none', 'buttons');
  });

  await test("previous lesson's running job still shows (with Cancel) after an SPA lesson change", async () => {
    const w = loomWorld({ downloadDelay: 3000 });
    w.startSW(); await tick();
    const U1 = 'https://luna.loom.com/id/l1/hls/playlist.m3u8' + S;
    w.req(1, U1, { frameId: 5, documentId: 'doc-l1' });
    await tick();
    const res = await dl(w, { url: U1 });
    await w.until(async () => (await w.jobs()).find((j) => j.id === res.jobId && j.status === 'saving'), 5000, 'saving');
    w.events.onHistoryStateUpdated.fire({ tabId: 1, frameId: 0, url: 'https://www.skool.com/c/classroom?md=def', timeStamp: Date.now() });
    w.frames[1] = [topFrame(), { frameId: 8, url: 'https://www.loom.com/embed/' + LOOMID2, documentId: 'doc-l2' }];
    w.req(1, 'https://luna.loom.com/id/l2/hls/playlist.m3u8' + S, { frameId: 8, documentId: 'doc-l2' });
    await tick(50);
    const p = openPopup(w);
    await tick(200);
    const infos = p.cards().map((c) => p.cardInfo(c));
    const orphan = infos.find((i) => i.fname === '01 - Lesson');
    ok(orphan, 'no card for the running job: ' + infos.map((i) => i.fname).join(','));
    ok(orphan.cancel.style.display === 'block' && orphan.btn.style.display === 'none', 'orphan buttons');
    ok(infos.some((i) => i.fname.startsWith('03 - ')), 'current lesson card');
  });

  await test('folder typed while an older download runs is kept', async () => {
    const w = loomWorld({ downloadDelay: 300 });
    w.startSW(); await tick();
    const U = 'https://luna.loom.com/id/zz/hls/playlist.m3u8' + S;
    w.req(1, U, { frameId: 5, documentId: 'doc-l1' });
    await tick();
    await w.local.set({ folder: 'Module 1', folderEditedAt: Date.now() - 10000 });
    const p1 = openPopup(w);
    await tick(100);
    await p1.cardInfo(p1.cards()[0]).btn.click();
    await tick(50);
    p1.byId.folder.value = 'Module 2';
    for (const fn of p1.byId.folder.listeners.input) fn();
    p1.close();
    await tick(600);
    const p2 = openPopup(w);
    await tick(100);
    ok(p2.byId.folder.value === 'Module 2', 'folder ' + p2.byId.folder.value);
  });

  await test('Save-As folder under Downloads is reused later in auto mode', async () => {
    const w = loomWorld();
    w.startSW(); await tick();
    const U = 'https://luna.loom.com/id/zz/hls/playlist.m3u8' + S;
    w.req(1, U, { frameId: 5, documentId: 'doc-l1' });
    await tick();
    const r1 = await dl(w, { url: U }, { folder: '' }); // auto mode teaches the Downloads root
    await jobDone(w, r1.jobId);
    const orig = w.chrome.downloads.download;
    w.chrome.downloads.download = async (o) => orig({ ...o, filename: 'Course B/' + o.filename }); // user picks a subfolder in the dialog
    const r2 = await dl(w, { url: U }, { saveAs: true });
    await jobDone(w, r2.jobId);
    await tick(50);
    await w.local.set({ ask: false });
    const p = openPopup(w);
    await tick(100);
    ok(p.byId.folder.value === 'Course B', 'folder ' + p.byId.folder.value);
  });

  await test('a lone job never claims to wait for a previous download', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] }, server: { delayMs: 150 } });
    w.startSW(); await tick();
    w.req(1, 'https://cdn.test/muxed/master.m3u8' + S);
    await tick();
    const p = openPopup(w);
    await tick(100);
    const seen = new Set();
    p.cardInfo(p.cards()[0]).btn.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) { seen.add(p.cardInfo(p.cards()[0]).status.textContent.replace(/\d+/g, 'N')); await tick(10); }
    ok(![...seen].some((t) => /Waiting for the previous/.test(t)), [...seen].join(' / '));
  });

  const failed = results.filter((r) => r[1] !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
