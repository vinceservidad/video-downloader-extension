const { createWorld } = require('./sw-harness.cjs');
const S = '?sig=ok';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const topFrame = () => ({ frameId: 0, url: 'https://www.skool.com/c/classroom?md=abc', documentId: 'doc-top' });
const baseDl = (w, item, extra = {}) => w.popup({ type: 'popup:download', tabId: 1, pageUrl: 'https://www.skool.com/c/classroom?md=abc', quality: 'highest', folder: 'Course', saveAs: false, item: { kind: 'hls', name: '01 - Lesson', ...item }, ...extra });
const jobDone = (w, id) => w.until(async () => { const j = (await w.jobs()).find((x) => x.id === id); return j && ['done', 'error', 'canceled'].includes(j.status) && j; }, 60000, 'job ' + id);
(async () => {
  const frames = { 1: [topFrame(), { frameId: 3, url: 'https://player.cdn.test/embed/1', documentId: 'doc-p' }] };
  const w = createWorld({ frames, server: { forbidOmit: true, delayMs: 50 } });
  w.autoWake = true;
  w.startSW(); await tick();
  const res = await baseDl(w, { url: 'https://cdn.test/muxed/hi/index.m3u8' + S });
  await w.until(() => w.offscreen, 5000, 'offscreen');
  const off = w.offscreen.off.ctx.chrome.runtime;
  const orig = off.sendMessage;
  let did = false;
  off.sendMessage = async (m) => {
    if (m.type === 'offscreen:done' && !did) {
      did = true;
      await tick(700);
      w.killSW();
      const s = await w.session.get('jobs');
      s.jobs.forEach((j) => (j.updatedAt -= 90000));
      await w.session.set(s);
    }
    return orig(m);
  };
  const j = await jobDone(w, res.jobId);
  await tick(3000);
  console.log('AUTH-WAKE:', j.status, j.route, '|', j.error, '|', j.detail, '| frame saves', w.log.filter((l) => l.startsWith('frame-save')));
  process.exit(0);
})();
