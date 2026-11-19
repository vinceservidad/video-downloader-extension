const { createWorld } = require('./sw-harness.cjs');
const S = '?sig=ok';
const results = [];
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function test(name, fn) {
  try { await fn(); results.push([name, 'PASS']); console.log('PASS', name); }
  catch (e) { results.push([name, 'FAIL']); console.log('FAIL', name, '-', e.message); }
}
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }
function ok(c, what) { if (!c) throw new Error(what); }
const LOOMID = 'a'.repeat(32), LOOMID2 = 'b'.repeat(32);
const topFrame = (tabId) => ({ frameId: 0, url: 'https://www.skool.com/c/classroom?md=abc', documentId: 'doc-top' });
const baseDl = (w, item, extra = {}) => w.popup({ type: 'popup:download', tabId: 1, pageUrl: 'https://www.skool.com/c/classroom?md=abc', quality: 'highest', folder: 'Course', saveAs: false, item: { kind: 'hls', name: '01 - Lesson', ...item }, ...extra });
const jobDone = (w, id) => w.until(async () => { const j = (await w.jobs()).find((x) => x.id === id); return j && ['done', 'error', 'canceled'].includes(j.status) && j; }, 60000, 'job ' + id);
const getJob = async (w, id) => (await w.jobs()).find((x) => x.id === id);

(async () => {
  await test('legacy dynamic rules removed + download UI re-enabled on startup', async () => {
    const w = createWorld({ dynamicRules: [{ id: 9001, action: {}, condition: {} }, { id: 9010, action: {}, condition: {} }] });
    w.startSW(); await tick();
    eq(w.dynamicRules.length, 0, 'dynamic rules');
    eq(w.uiOptions.at(-1), true, 'ui enabled');
  });

  await test('detection: segments/aux/403/octet-stream filtered; grouping + badge', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] } });
    w.startSW(); await tick();
    w.req(1, 'https://cdn.test/split/master.m3u8' + S);
    w.req(1, 'https://cdn.test/split/v/index.m3u8' + S);
    w.req(1, 'https://cdn.test/split/a/index.m3u8' + S);
    for (let i = 0; i < 40; i++) w.req(1, `https://cdn.test/split/v/s${String(i).padStart(3, '0')}.ts` + S, { ct: 'video/mp2t' });
    w.req(1, 'https://cdn.test/seg/abcdef', { ct: 'video/mp2t' });
    w.req(1, 'https://cdn.test/blob/abcdef', { ct: 'application/octet-stream' });
    w.req(1, 'https://cdn.test/subs/en/subtitles.m3u8' + S);
    w.req(1, 'https://cdn.test/split/v/fragment-12.mp4' + S, { ct: 'video/mp4' });
    w.req(1, 'https://cdn.test/fmp4/v/chunk.mp4' + S, { ct: 'video/mp4' });
    w.req(1, 'https://cdn.test/forbidden/master.m3u8', { statusCode: 403 });
    w.req(1, 'https://other.test/promo.mp4');
    w.req(1, 'https://other.test/stream?id=5', { ct: 'video/mp4' });
    await tick(50);
    const r = await w.popup({ type: 'popup:list', tabId: 1 });
    eq(r.primary.map((c) => c.url), ['https://cdn.test/split/master.m3u8' + S], 'primary');
    eq(r.extra.map((c) => c.url).sort(), ['https://cdn.test/fmp4/v/chunk.mp4' + S, 'https://cdn.test/split/a/index.m3u8' + S, 'https://cdn.test/split/v/index.m3u8' + S, 'https://other.test/promo.mp4', 'https://other.test/stream?id=5'].sort(), 'extra');
    eq(w.badges[1], '1', 'badge');
  });

  await test('detections survive a service-worker restart', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] } });
    w.startSW(); await tick();
    w.req(1, 'https://cdn.test/muxed/master.m3u8' + S);
    await tick(400); // debounced persist
    w.killSW(); w.startSW(); await tick();
    const r = await w.popup({ type: 'popup:list', tabId: 1 });
    eq(r.primary.length, 1, 'primary after restart');
  });

  await test('SPA lesson change marks old top-frame media "earlier"; gone iframes dropped', async () => {
    const w = createWorld({ frames: { 1: [topFrame(), { frameId: 7, url: 'https://www.loom.com/embed/' + LOOMID, documentId: 'doc-loom-new' }] } });
    w.startSW(); await tick();
    w.events.onCommitted.fire({ tabId: 1, frameId: 0, url: 'https://www.skool.com/c/classroom?md=abc', documentId: 'doc-top', timeStamp: Date.now() - 5000, documentLifecycle: 'active' });
    w.req(1, 'https://cdn.test/muxed/master.m3u8' + S, { timeStamp: Date.now() - 3000 });
    w.req(1, 'https://luna.loom.com/id/x/old/playlist.m3u8' + S, { frameId: 6, documentId: 'doc-loom-old', timeStamp: Date.now() - 3000 });
    await tick();
    w.events.onHistoryStateUpdated.fire({ tabId: 1, frameId: 0, url: 'https://www.skool.com/c/classroom?md=def', timeStamp: Date.now() - 1000 });
    await tick();
    w.req(1, 'https://cdn.test/split/master.m3u8' + S);
    await tick();
    const r = await w.popup({ type: 'popup:list', tabId: 1 });
    // The new lesson's Loom iframe hasn't played yet: it's offered via a placeholder.
    eq(r.primary.map((c) => [c.url, c.role]), [['https://cdn.test/split/master.m3u8' + S, 'primary'], ['https://www.loom.com/embed/' + LOOMID, 'primary']], 'primary');
    eq(r.extra.map((c) => [c.url, c.role]), [['https://cdn.test/muxed/master.m3u8' + S, 'earlier']], 'extra');
  });

  await test('HLS job end-to-end: session rules scoped to TAB_ID_NONE, saved, cleaned up, offscreen closed', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] } });
    w.startSW(); await tick();
    w.req(1, 'https://cdn.test/split/master.m3u8' + S);
    let rulesSeen = null;
    const orig = w.chrome.declarativeNetRequest.updateSessionRules;
    w.chrome.declarativeNetRequest.updateSessionRules = async (o) => { if (o.addRules?.length) rulesSeen = o.addRules; return orig(o); };
    const res = await baseDl(w, { url: 'https://cdn.test/split/master.m3u8' + S });
    ok(res.ok && res.jobId, 'ack ' + JSON.stringify(res));
    const j = await jobDone(w, res.jobId);
    eq(j.status, 'done', 'status ' + j.error + ' ' + j.detail);
    eq(j.mode, 'av-mux', 'mode');
    ok(rulesSeen && rulesSeen.every((r) => JSON.stringify(r.condition.tabIds) === '[-1]' && JSON.stringify(r.condition.initiatorDomains) === '["ext"]'), 'rules scoped ' + JSON.stringify(rulesSeen?.[0]?.condition));
    eq(w.downloads.length, 1, 'downloads');
    eq(w.downloads[0].filename, '/Users/me/Downloads/Course/01 - Lesson.mp4', 'filename');
    await tick(50);
    eq(w.sessionRules.length, 0, 'rules removed');
    eq(w.offscreen, null, 'offscreen closed');
    eq(w.uiOptions.slice(-2), [false, true], 'ui hold released');
    ok(w.popupInbox.some((m) => m.type === 'job:update' && m.job.status === 'downloading'), 'progress broadcast');
    const lf = (await w.local.get('lastFolder')).lastFolder;
    eq(lf?.folder, 'Course', 'lastFolder');
    eq((await w.local.get('downloadsRoot')).downloadsRoot, '/Users/me/Downloads', 'downloadsRoot');
  });

  await test('worker killed mid-download: offscreen:done wakes a fresh worker which still saves', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] }, server: { delayMs: 250 } });
    w.autoWake = true;
    w.startSW(); await tick();
    const res = await baseDl(w, { url: 'https://cdn.test/muxed/master.m3u8' + S });
    await w.until(() => w.popupInbox.some((m) => m.type === 'job:update' && m.job.id === res.jobId && m.job.status === 'downloading'), 20000, 'downloading');
    await tick(600); // let the debounced job save land
    w.killSW();
    const j = await jobDone(w, res.jobId);
    eq(j.status, 'done', 'status ' + (j.error || ''));
    eq(w.downloads.length, 1, 'downloads');
  });

  await test('cancel while downloading: no file, rules removed, offscreen told', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] }, server: { delayMs: 250 } });
    w.startSW(); await tick();
    const res = await baseDl(w, { url: 'https://cdn.test/split/master.m3u8' + S });
    await w.until(() => w.popupInbox.some((m) => m.type === 'job:update' && m.job.id === res.jobId && m.job.status === 'downloading'), 20000, 'downloading');
    await w.popup({ type: 'popup:cancel', jobId: res.jobId });
    const j = await jobDone(w, res.jobId);
    eq(j.status, 'canceled', 'status');
    await tick(300);
    eq(w.downloads.length, 0, 'downloads');
    eq(w.sessionRules.length, 0, 'rules');
  });

  await test('duplicate click re-attaches; second video queues behind the first', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] } });
    w.startSW(); await tick();
    const a = await baseDl(w, { url: 'https://cdn.test/muxed/master.m3u8' + S });
    const a2 = await baseDl(w, { url: 'https://cdn.test/muxed/master.m3u8' + S });
    const b = await baseDl(w, { url: 'https://cdn.test/fmp4/master.m3u8' + S, name: '02 - Next' });
    eq(a2.jobId, a.jobId, 'dedupe');
    eq((await jobDone(w, a.jobId)).status, 'done', 'a');
    eq((await jobDone(w, b.jobId)).status, 'done', 'b');
    eq(w.downloads.length, 2, 'two files');
    await tick(50);
    eq([w.offscreenCreates, w.offscreenCloses], [1, 1], 'offscreen reused then closed');
  });

  await test('unsafe names sanitized; rejected name falls back instead of losing the video', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] } });
    w.startSW(); await tick();
    const r1 = await baseDl(w, { url: 'https://cdn.test/muxed/master.m3u8' + S, name: 'CON' }, { folder: ' ..//Mod 1. ' });
    await jobDone(w, r1.jobId);
    const r2 = await baseDl(w, { url: 'https://cdn.test/muxed/lo/index.m3u8' + S, name: '👨‍💻 Intro​. ' }, { folder: '' });
    await jobDone(w, r2.jobId);
    eq(w.downloads.map((d) => d.filename.replace('/Users/me/Downloads/', '')), ['Mod 1/_CON.mp4', '👨💻 Intro.mp4'], 'names');
    const orig = w.chrome.downloads.download;
    let first = true;
    w.chrome.downloads.download = async (o) => { if (first) { first = false; throw new Error('Invalid filename'); } return orig(o); };
    const r3 = await baseDl(w, { url: 'https://cdn.test/aes/iv/index.m3u8' + S, name: 'Whatever' });
    const j3 = await jobDone(w, r3.jobId);
    eq(j3.status, 'done', 'fallback status');
    ok(/Course\/?video-j|video-j/.test(w.downloads.at(-1).filename), 'fallback name ' + w.downloads.at(-1).filename);
  });

  await test('Loom: API MP4 downloaded directly from the frame that played it (multi-Loom page)', async () => {
    const frames = { 1: [topFrame(), { frameId: 5, url: 'https://www.loom.com/embed/' + LOOMID, documentId: 'doc-l1' }, { frameId: 6, url: 'https://www.loom.com/embed/' + LOOMID2, documentId: 'doc-l2' }] };
    const calls = [];
    const w = createWorld({ frames, loomApi: (ep, u) => { calls.push(u); return ep === 'raw-url' ? { url: 'https://cdn.test/direct.mp4?sig=ok&v=' + (u.includes(LOOMID2) ? 2 : 1) } : { url: 'https://cdn.test/split/master.m3u8?sig=ok' }; } });
    w.startSW(); await tick();
    w.req(1, 'https://luna.loom.com/id/zz/hls/playlist.m3u8' + S, { frameId: 6, documentId: 'doc-l2' });
    await tick();
    let loomRule = null;
    const orig = w.chrome.declarativeNetRequest.updateSessionRules;
    w.chrome.declarativeNetRequest.updateSessionRules = async (o) => { if (o.addRules?.length) loomRule = o.addRules[0]; return orig(o); };
    const res = await baseDl(w, { url: 'https://luna.loom.com/id/zz/hls/playlist.m3u8' + S });
    const j = await jobDone(w, res.jobId);
    eq(j.status, 'done', 'status ' + (j.error || '') + ' ' + (j.detail || ''));
    eq(j.mode, 'loom-api', 'mode');
    ok(calls.every((u) => u.includes(LOOMID2)), 'used the right Loom frame ' + calls.join(','));
    eq(w.downloads[0].url, 'https://cdn.test/direct.mp4?sig=ok&v=2', 'mp4 url');
    eq(loomRule?.condition.tabIds, [-1], 'loom referer rule scoped');
    await tick(50);
    eq(w.sessionRules.length, 0, 'rule removed');
  });

  await test('Loom: API HLS assembled offscreen (sign query propagated)', async () => {
    const frames = { 1: [topFrame(), { frameId: 5, url: 'https://www.loom.com/embed/' + LOOMID, documentId: 'doc-l1' }] };
    const w = createWorld({ frames, loomApi: (ep) => (ep === 'transcoded-url' ? { url: 'https://cdn.test/split/master.m3u8?sig=ok' } : null) });
    w.startSW(); await tick();
    const res = await baseDl(w, { url: 'https://luna.loom.com/id/zz/hls/playlist.m3u8' + S });
    const j = await jobDone(w, res.jobId);
    eq([j.status, j.mode], ['done', 'av-mux'], 'status/mode ' + (j.error || ''));
  });

  await test('frame fallback when offscreen gets 403 but the page frame has cookies', async () => {
    const frames = { 1: [topFrame(), { frameId: 3, url: 'https://player.cdn.test/embed/1', documentId: 'doc-p' }] };
    const w = createWorld({ frames, server: { forbidOmit: true } });
    w.startSW(); await tick();
    const res = await baseDl(w, { url: 'https://cdn.test/muxed/hi/index.m3u8' + S });
    const j = await jobDone(w, res.jobId);
    eq([j.status, j.route, j.mode], ['done', 'frame', 'frame-hls'], 'frame route ' + (j.error || '') + ' ' + (j.detail || ''));
    ok(w.log.some((l) => l === 'frame-save:01 - Lesson.ts'), 'saved in page ' + w.log.join(','));
  });

  await test('canceling an in-page (frame) download stops it before saving', async () => {
    const frames = { 1: [topFrame(), { frameId: 3, url: 'https://player.cdn.test/embed/1', documentId: 'doc-p' }] };
    const w = createWorld({ frames, server: { forbidOmit: true, delayMs: 300 } });
    w.startSW(); await tick();
    const res = await baseDl(w, { url: 'https://cdn.test/muxed/hi/index.m3u8' + S });
    await w.until(() => w.popupInbox.some((m) => m.type === 'job:update' && m.job.id === res.jobId && m.job.route === 'frame'), 20000, 'frame route');
    await w.popup({ type: 'popup:cancel', jobId: res.jobId });
    await tick(2500);
    eq((await getJob(w, res.jobId)).status, 'canceled', 'status');
    ok(!w.log.some((l) => l.startsWith('frame-save:')), 'saved anyway: ' + w.log.join(','));
  });

  await test('cancel during the Loom API step leaves no rules behind', async () => {
    const frames = { 1: [topFrame(), { frameId: 5, url: 'https://www.loom.com/embed/' + LOOMID, documentId: 'doc-l1' }] };
    let release;
    const gate = new Promise((r) => (release = r));
    const w = createWorld({ frames, loomApi: (ep) => (ep === 'raw-url' ? { url: 'https://cdn.test/direct.mp4?sig=ok' } : null) });
    w.startSW(); await tick();
    const orig = w.chrome.scripting.executeScript;
    w.chrome.scripting.executeScript = async (o) => { await gate; return orig(o); };
    const res = await baseDl(w, { url: 'https://luna.loom.com/id/zz/hls/playlist.m3u8' + S });
    await tick(50);
    await w.popup({ type: 'popup:cancel', jobId: res.jobId });
    release();
    await tick(300);
    eq(w.sessionRules.length, 0, 'rules left: ' + JSON.stringify(w.sessionRules.map((r) => r.id)));
    eq(w.downloads.length, 0, 'downloads');
  });

  await test('revisiting a lesson: same Loom playlist from a new iframe stays listed', async () => {
    const w = createWorld({ frames: { 1: [topFrame(), { frameId: 5, url: 'https://www.loom.com/embed/' + LOOMID, documentId: 'dA' }] } });
    w.startSW(); await tick();
    const U = 'https://luna.loom.com/id/x/hls/playlist.m3u8' + S;
    w.req(1, U, { frameId: 5, documentId: 'dA' });
    await tick();
    w.frames[1] = [topFrame(), { frameId: 9, url: 'https://www.loom.com/embed/' + LOOMID, documentId: 'dA2' }];
    w.req(1, U, { frameId: 9, documentId: 'dA2' });
    await tick();
    const r = await w.popup({ type: 'popup:list', tabId: 1 });
    eq(r.primary.map((c) => c.url), [U], 'primary');
  });

  await test('long SPA session: the current lesson is still detected after 40 lessons', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] } });
    w.startSW(); await tick();
    for (let n = 0; n < 40; n++) {
      w.events.onHistoryStateUpdated.fire({ tabId: 1, frameId: 0, url: 'https://www.skool.com/c/classroom?md=' + n, timeStamp: Date.now() - 1 });
      await tick(5);
      w.req(1, `https://stream.test/l${n}/playlist.m3u8`);
      for (const q of ['720p', '480p', '360p']) w.req(1, `https://stream.test/l${n}/${q}/index.m3u8`);
      await tick(5);
    }
    const r = await w.popup({ type: 'popup:list', tabId: 1 });
    eq(r.primary.map((c) => c.url), ['https://stream.test/l39/playlist.m3u8'], 'primary');
  });

  await test('unplayed / DASH Loom embed is offered and downloads through the Loom API', async () => {
    const frames = { 1: [topFrame(), { frameId: 5, url: 'https://www.loom.com/embed/' + LOOMID + '?hide_owner=true', documentId: 'doc-l1' }] };
    const w = createWorld({ frames, loomApi: (ep) => (ep === 'raw-url' ? { url: 'https://cdn.test/direct.mp4?sig=ok' } : null) });
    w.startSW(); await tick();
    w.req(1, 'https://luna.loom.com/id/x/dash/manifest.mpd' + S, { frameId: 5, documentId: 'doc-l1', ct: 'application/dash+xml' });
    w.req(1, 'https://luna.loom.com/id/x/dash/seg-1.m4s' + S, { frameId: 5, documentId: 'doc-l1', ct: 'video/iso.segment' });
    await tick();
    const r = await w.popup({ type: 'popup:list', tabId: 1 });
    eq(r.primary.map((c) => c.url), [frames[1][1].url], 'placeholder');
    const res = await baseDl(w, { url: frames[1][1].url });
    const j = await jobDone(w, res.jobId);
    eq([j.status, j.mode], ['done', 'loom-api'], 'job ' + (j.error || ''));
  });

  await test('Loom placeholder whose API fails gives a clear error', async () => {
    const frames = { 1: [topFrame(), { frameId: 5, url: 'https://www.loom.com/embed/' + LOOMID, documentId: 'doc-l1' }] };
    const w = createWorld({ frames, loomApi: () => null });
    w.startSW(); await tick();
    await w.popup({ type: 'popup:list', tabId: 1 });
    const res = await baseDl(w, { url: frames[1][1].url });
    const j = await jobDone(w, res.jobId);
    ok(j.status === 'error' && /Loom didn't return a download link/.test(j.error), j.error);
  });

  await test('content-type edge cases: media octet-stream yes, XHR octet-stream no, audio/mpegurl HLS yes', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] } });
    w.startSW(); await tick();
    w.req(1, 'https://storage.test/course/lesson-1', { ct: 'application/octet-stream', type: 'media' });
    w.req(1, 'https://storage.test/api/blob', { ct: 'application/octet-stream', type: 'xmlhttprequest' });
    w.req(1, 'https://api.test/v1/stream/abc/master', { ct: 'audio/mpegurl' });
    await tick(50);
    const r = await w.popup({ type: 'popup:list', tabId: 1 });
    const urls = [...r.primary, ...r.extra].map((c) => c.url).sort();
    eq(urls, ['https://api.test/v1/stream/abc/master', 'https://storage.test/course/lesson-1'], 'detected');
  });

  await test('same-URL replaceState after a worker restart keeps the current video', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] } });
    w.startSW(); await tick();
    w.events.onCommitted.fire({ tabId: 1, frameId: 0, url: 'https://www.skool.com/c/classroom?md=abc', documentId: 'doc-top', timeStamp: Date.now() - 5000, documentLifecycle: 'active' });
    await tick();
    w.req(1, 'https://stream.mux.com/pbA.m3u8' + S);
    await tick(400);
    w.killSW(); w.startSW(); await tick();
    w.events.onHistoryStateUpdated.fire({ tabId: 1, frameId: 0, url: 'https://www.skool.com/c/classroom?md=abc#t=5', timeStamp: Date.now() });
    await tick();
    const r = await w.popup({ type: 'popup:list', tabId: 1 });
    eq(r.primary.map((c) => [c.url, c.role]), [['https://stream.mux.com/pbA.m3u8' + S, 'primary']], 'primary');
  });

  await test('a root-level playlist (Mux) does not hide MP4s on the same host', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] } });
    w.startSW(); await tick();
    w.req(1, 'https://stream.mux.com/pbA.m3u8' + S);
    w.req(1, 'https://stream.mux.com/pbB/high.mp4');
    await tick();
    const r = await w.popup({ type: 'popup:list', tabId: 1 });
    ok([...r.primary, ...r.extra].some((c) => c.url === 'https://stream.mux.com/pbB/high.mp4'), 'mp4 hidden');
  });

  await test('sign-in page (200 HTML) for the extension -> in-page fallback', async () => {
    const frames = { 1: [topFrame(), { frameId: 3, url: 'https://player.cdn.test/embed/1', documentId: 'doc-p' }] };
    const w = createWorld({ frames, server: { htmlOmit: true } });
    w.startSW(); await tick();
    const res = await baseDl(w, { url: 'https://cdn.test/muxed/hi/index.m3u8' + S });
    const j = await jobDone(w, res.jobId);
    eq([j.status, j.route], ['done', 'frame'], 'route ' + (j.error || '') + (j.detail || ''));
  });

  await test('<video src> files with segment-like names are still listed', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] } });
    w.startSW(); await tick();
    await w.deliver({ tabId: 1, frameId: 0, documentId: 'doc-top' }, { type: 'content:detections', urls: ['https://site.test/Module-2/Segment-3.mp4'] }).catch(() => {});
    await tick();
    const r = await w.popup({ type: 'popup:list', tabId: 1 });
    eq(r.primary.map((c) => c.url), ['https://site.test/Module-2/Segment-3.mp4'], 'primary');
  });

  await test('403 everywhere -> friendly error with details', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] }, server: { forbid: ['muxed'] } });
    w.startSW(); await tick();
    const res = await baseDl(w, { url: 'https://cdn.test/muxed/master.m3u8' + S });
    const j = await jobDone(w, res.jobId);
    eq(j.status, 'error', 'status');
    ok(/refused access/.test(j.error), 'friendly: ' + j.error);
    ok(/\(403\)/.test(j.detail) && /off1\.7/.test(j.detail), 'detail: ' + j.detail);
  });

  await test('job orphaned by a crashed offscreen document is failed on next popup open', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] }, server: { delayMs: 250 } });
    w.startSW(); await tick();
    const res = await baseDl(w, { url: 'https://cdn.test/split/master.m3u8' + S });
    await w.until(() => w.popupInbox.some((m) => m.type === 'job:update' && m.job.id === res.jobId && m.job.status === 'downloading'), 20000, 'downloading');
    w.offscreen.off.ctx.chrome.runtime.sendMessage = () => new Promise(() => {}); // renderer crash: goes silent
    w.offscreen = null;
    await tick(700);
    w.killSW();
    const s = await w.session.get('jobs');
    s.jobs.forEach((j) => (j.updatedAt -= 120000));
    await w.session.set(s);
    w.startSW(); await tick();
    await w.popup({ type: 'popup:list', tabId: 1 });
    const j = await jobDone(w, res.jobId);
    eq(j.status, 'error', 'status');
    ok(/stopped unexpectedly/.test(j.error), j.error);
  });

  await test('content scripts cannot issue privileged commands', async () => {
    const w = createWorld({ frames: { 1: [topFrame()] } });
    w.startSW(); await tick();
    const r = await w.deliver({ tabId: 1, frameId: 0, documentId: 'doc-top' }, { type: 'popup:download', tabId: 1, item: { url: 'https://cdn.test/muxed/master.m3u8' + S, kind: 'hls', name: 'x' } }).catch((e) => 'err:' + e.message);
    await tick(100);
    eq((await w.jobs()).length, 0, 'no job created');
  });

  await test('auth rules use the active page origin as Referer and scope cookies to that site (not hardcoded Skool)', async () => {
    const w = createWorld({ frames: { 1: [{ frameId: 0, url: 'https://courses.acme.io/module/1', documentId: 'doc-acme' }] } });
    const cookieDomains = [];
    w.chrome.cookies.getAll = async (q) => {
      cookieDomains.push(q.domain);
      if (q.domain === 'acme.io' && !q.partitionKey) return [{ name: 'acme_sess', value: 'tok1' }];
      if (q.domain === 'skool.com' && !q.partitionKey) return [{ name: 'skool_sess', value: 'secret' }];
      return [];
    };
    let rulesSeen = null;
    const orig = w.chrome.declarativeNetRequest.updateSessionRules;
    w.chrome.declarativeNetRequest.updateSessionRules = async (o) => { if (o.addRules?.length) rulesSeen = o.addRules; return orig(o); };
    w.startSW(); await tick();
    const res = await baseDl(w, { url: 'https://cdn.test/muxed/master.m3u8' + S }, { pageUrl: 'https://courses.acme.io/module/1' });
    const j = await jobDone(w, res.jobId);
    eq(j.status, 'done', 'status ' + (j.error || ''));
    ok(rulesSeen && rulesSeen.length > 0, 'rules installed');
    ok(rulesSeen.every((r) => r.action.requestHeaders.find((h) => h.header === 'referer')?.value === 'https://courses.acme.io/'), 'referer uses page origin');
    const acmeRule = rulesSeen.find((r) => r.condition.requestDomains.includes('acme.io'));
    ok(acmeRule && acmeRule.action.requestHeaders.find((h) => h.header === 'cookie')?.value === 'acme_sess=tok1', 'page domain cookie attached');
    ok(!rulesSeen.some((r) => r.condition.requestDomains.includes('skool.com')), 'no skool.com rule on non-Skool site');
    ok(!cookieDomains.includes('skool.com'), 'skool.com cookies not read');
  });

  const failed = results.filter((r) => r[1] !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
