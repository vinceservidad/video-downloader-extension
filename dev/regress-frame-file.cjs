const vm = require('vm');
const { createWorld } = require('./sw-harness.cjs');
const S = '?sig=ok';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const topFrame = () => ({ frameId: 0, url: 'https://www.skool.com/c/classroom?md=abc', documentId: 'doc-top' });
const frames = () => ({ 1: [topFrame(), { frameId: 3, url: 'https://player.cdn.test/embed/1', documentId: 'doc-p' }] });
const dl = (w) => w.popup({ type: 'popup:download', tabId: 1, pageUrl: 'https://www.skool.com/c/classroom?md=abc', quality: 'highest', folder: 'Course', saveAs: false, item: { kind: 'file', name: '01 - Lesson', url: 'https://cdn.test/direct.mp4' + S } });
const getJob = async (w, id) => (await w.jobs()).find((x) => x.id === id);

function gateIncludeFetch(w) {
  let release; const gate = new Promise((r) => (release = r));
  const orig = w.server.fetch;
  let started = false;
  w.server.fetch = async (u, init = {}) => { if (init.credentials === 'include') { started = true; await gate; } return orig(u, init); };
  return { release, started: () => started };
}
function advanceClock(ctx, ms) {
  const RealDate = Date;
  class D extends RealDate { static now() { return RealDate.now() + ms; } }
  ctx.Date = D;
}

(async () => {
  // A: SW stays alive, user opens popup after 11 min of a healthy frame download.
  {
    const w = createWorld({ frames: frames(), server: { forbidOmit: true } });
    w.startSW(); await tick();
    const g = gateIncludeFetch(w);
    const res = await dl(w);
    await w.until(() => g.started(), 20000, 'frame fetch started');
    const pre = await getJob(w, res.jobId);
    console.log('A pre:', pre.status, pre.route);
    const frameProgress = w.popupInbox.filter((m) => m.type === 'frame:progress').length;
    advanceClock(w.sw, 11 * 60000);
    await w.popup({ type: 'popup:list', tabId: 1 });
    await tick(50);
    g.release();
    await tick(300);
    const j = await getJob(w, res.jobId);
    console.log('A frame:progress msgs:', frameProgress, '| saved in page:', w.log.filter((l) => l.startsWith('frame-save')), '| final:', j.status, '|', j.error);
  }
  // B: SW terminated during the frame download; frame:done wakes a fresh SW.
  {
    const w = createWorld({ frames: frames(), server: { forbidOmit: true } });
    w.startSW(); await tick();
    const g = gateIncludeFetch(w);
    const orig = w.chrome.scripting.executeScript;
    let killed = false;
    w.chrome.scripting.executeScript = (o) => { const p = orig(o); return o.func.name === 'frameAssembler' ? p.then((r) => (killed ? new Promise(() => {}) : r)) : p; };
    const res = await dl(w);
    await w.until(() => g.started(), 20000, 'frame fetch started');
    await tick(700); // let persists flush
    killed = true; w.killSW();
    const s = await w.session.get('jobs');
    s.jobs.forEach((j) => (j.updatedAt -= 11 * 60000));
    await w.session.set(s);
    w.autoWake = true;
    g.release();
    await tick(500);
    const j = await getJob(w, res.jobId);
    console.log('B saved in page:', w.log.filter((l) => l.startsWith('frame-save')), '| final:', j.status, '|', j.error);
  }
  // C: Cancel during a frame file download.
  {
    const w = createWorld({ frames: frames(), server: { forbidOmit: true } });
    w.startSW(); await tick();
    const g = gateIncludeFetch(w);
    const res = await dl(w);
    await w.until(() => g.started(), 20000, 'frame fetch started');
    await w.popup({ type: 'popup:cancel', jobId: res.jobId });
    g.release();
    await tick(300);
    const j = await getJob(w, res.jobId);
    console.log('C saved in page after cancel:', w.log.filter((l) => l.startsWith('frame-save')), '| final:', j.status);
  }
  // D: control — frame file download under 10 min with SW restart.
  {
    const w = createWorld({ frames: frames(), server: { forbidOmit: true } });
    w.startSW(); await tick();
    const g = gateIncludeFetch(w);
    const orig = w.chrome.scripting.executeScript;
    let killed = false;
    w.chrome.scripting.executeScript = (o) => { const p = orig(o); return o.func.name === 'frameAssembler' ? p.then((r) => (killed ? new Promise(() => {}) : r)) : p; };
    const res = await dl(w);
    await w.until(() => g.started(), 20000, 'frame fetch started');
    await tick(700);
    killed = true; w.killSW();
    const s = await w.session.get('jobs');
    s.jobs.forEach((j) => (j.updatedAt -= 4 * 60000));
    await w.session.set(s);
    w.autoWake = true;
    g.release();
    await tick(500);
    const j = await getJob(w, res.jobId);
    console.log('D (4 min) final:', j.status, j.mode || '', j.error || '');
  }
  process.exit(0);
})();
