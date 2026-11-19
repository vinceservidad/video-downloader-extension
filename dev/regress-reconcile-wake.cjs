// Repro: startup reconcileJobs uses a stale idle and kills the job whose
// offscreen:done woke a fresh worker.
const { createWorld } = require('./sw-harness.cjs');
const S = '?sig=ok';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const topFrame = () => ({ frameId: 0, url: 'https://www.skool.com/c/classroom?md=abc', documentId: 'doc-top' });
const baseDl = (w, item, extra = {}) => w.popup({ type: 'popup:download', tabId: 1, pageUrl: 'https://www.skool.com/c/classroom?md=abc', quality: 'highest', folder: 'Course', saveAs: false, item: { kind: 'hls', name: '01 - Lesson', ...item }, ...extra });
const getJob = async (w, id) => (await w.jobs()).find((x) => x.id === id);
const which = process.argv[2];
const URLX = process.argv[3] || 'https://cdn.test/muxed/master.m3u8';

// Kill the SW right before offscreen:done is sent and backdate the persisted
// updatedAt by `ageMs` (the offscreen was quiet that long; SW idle-terminated).
function killBeforeDone(w, ageMs, trace) {
  const off = w.offscreen.off.ctx.chrome.runtime;
  const orig = off.sendMessage;
  let did = false;
  off.sendMessage = async (m) => {
    if (m.type === 'offscreen:done' && !did) {
      did = true;
      await tick(700); // debounced persist lands
      w.killSW();
      const s = await w.session.get('jobs');
      s.jobs.forEach((j) => (j.updatedAt -= ageMs));
      await w.session.set(s);
      trace.push('done-sent ok=' + m.ok);
    }
    return orig(m);
  };
  const swSend = w.chrome.runtime.sendMessage;
  w.chrome.runtime.sendMessage = (m, cb) => { if (m?.type === 'offscreen:revoke') trace.push('revoke'); if (m?.type === 'offscreen:status') trace.push('status?'); return swSend(m, cb); };
  // Trace downloads / close against the same timeline.
  const dl = w.chrome.downloads.download;
  w.chrome.downloads.download = async (o) => { trace.push('download(' + (w.offscreen?.off.blobs.has(o.url) ? 'blob-live' : 'blob-GONE') + ')'); return dl(o); };
  const close = w.chrome.offscreen.closeDocument;
  w.chrome.offscreen.closeDocument = async () => { trace.push('closeDocument'); return close(); };
}

async function runOk(ageMs, label) {
  const w = createWorld({ frames: { 1: [topFrame()] }, server: { delayMs: 50 } });
  w.autoWake = true;
  w.startSW(); await tick();
  const trace = [];
  const res = await baseDl(w, { url: URLX + S });
  await w.until(() => w.offscreen, 5000, 'offscreen');
  killBeforeDone(w, ageMs, trace);
  // Wait until the downloads settle and the job stops changing.
  await w.until(async () => trace.includes('done-sent ok=true'), 60000, 'done');
  await tick(1500);
  const j = await getJob(w, res.jobId);
  const seq = w.popupInbox.filter((m) => m.type === 'job:update' && m.job.id === res.jobId).map((m) => m.job.status).filter((v, i, a) => v !== a[i - 1]);
  console.log(label, '| status seq:', seq.join('>'), '| final status:', j.status, '| error:', j.error || '-', '| detail:', j.detail || '-', '| downloads:', w.downloads.map((d) => d.state + (d.error ? ':' + d.error : '')), '| trace:', trace.join(' > '));
}

async function runFrame(ageMs, label) {
  const frames = { 1: [topFrame(), { frameId: 3, url: 'https://player.cdn.test/embed/1', documentId: 'doc-p' }] };
  const w = createWorld({ frames, server: { forbidOmit: true, delayMs: 50 } });
  w.autoWake = true;
  w.startSW(); await tick();
  const trace = [];
  const res = await baseDl(w, { url: 'https://cdn.test/muxed/hi/index.m3u8' + S });
  await w.until(() => w.offscreen, 5000, 'offscreen');
  killBeforeDone(w, ageMs, trace);
  await w.until(async () => trace.includes('done-sent ok=false'), 60000, 'done');
  await tick(4000);
  const j = await getJob(w, res.jobId);
  console.log(label, '| final status:', j.status, '| route:', j.route, '| error:', j.error || '-', '| detail:', (j.detail || '-').slice(0, 80), '| frame saves:', w.log.filter((l) => l.startsWith('frame-save')));
}

(async () => {
  if (!which || which === 'ok') {
    await runOk(10_000, 'OK  quiet 10s (control)');
    await runOk(90_000, 'OK  quiet 90s          ');
  }
  if (!which || which === 'frame') {
    await runFrame(10_000, '403 quiet 10s (control)');
    await runFrame(90_000, '403 quiet 90s          ');
  }
  process.exit(0);
})();
