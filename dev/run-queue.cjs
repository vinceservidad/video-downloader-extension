// Queueing, cancel and progress semantics of the offscreen job runner.
const { makeServer, loadOffscreen } = require('./harness.cjs');
const S = '?sig=ok';
const wait = async (pred, ms = 60000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };
(async () => {
  const stats = { loads: 0, execs: [], writes: 0, mounts: 0, terminates: 0 };
  const server = makeServer({ delayMs: 30 });
  const off = loadOffscreen({ server, stats });
  const item = (u) => ({ url: 'https://cdn.test/' + u + S, kind: 'hls', quality: 'highest' });
  const r1 = await off.send({ type: 'offscreen:assemble', jobId: 'A', item: item('muxed/master.m3u8') });
  const r2 = await off.send({ type: 'offscreen:assemble', jobId: 'B', item: item('split/master.m3u8') });
  const dup = await off.send({ type: 'offscreen:assemble', jobId: 'B', item: item('split/master.m3u8') });
  const r3 = await off.send({ type: 'offscreen:assemble', jobId: 'C', item: item('fmp4/master.m3u8') });
  console.log('acks', JSON.stringify([r1, r2, dup, r3]));
  const st = await off.send({ type: 'offscreen:status' });
  console.log('status', JSON.stringify(st));
  // cancel C while queued
  await off.send({ type: 'offscreen:cancel', jobId: 'C' });
  await wait(() => ['A', 'B', 'C'].every((j) => off.outbox.some((m) => m.type === 'offscreen:done' && m.jobId === j)));
  const done = (j) => off.outbox.filter((m) => m.type === 'offscreen:done' && m.jobId === j);
  for (const j of ['A', 'B', 'C']) console.log(j, JSON.stringify(done(j).map(({ ok, canceled, mode, error }) => ({ ok, canceled, mode, error }))));
  const prog = off.outbox.filter((m) => m.type === 'offscreen:progress');
  const stagesB = [...new Set(prog.filter((m) => m.jobId === 'B').map((m) => m.stage))];
  console.log('B stages', stagesB.join(','), 'A msgs', prog.filter((m) => m.jobId === 'A').length);
  // order: B must start after A finished
  const idxDoneA = off.outbox.findIndex((m) => m.type === 'offscreen:done' && m.jobId === 'A');
  const idxFirstBDownload = off.outbox.findIndex((m) => m.jobId === 'B' && m.stage === 'download');
  console.log('sequential', idxDoneA < idxFirstBDownload);
  // cancel while active (download stage)
  await off.send({ type: 'offscreen:assemble', jobId: 'D', item: item('aes/iv/index.m3u8') });
  await wait(() => off.outbox.some((m) => m.jobId === 'D' && m.stage === 'download'));
  await off.send({ type: 'offscreen:cancel', jobId: 'D' });
  await wait(() => off.outbox.some((m) => m.type === 'offscreen:done' && m.jobId === 'D'));
  console.log('D', JSON.stringify(done('D').map(({ ok, canceled, error }) => ({ ok, canceled, error }))));
  // next job still works after a cancel
  await off.send({ type: 'offscreen:assemble', jobId: 'E', item: item('muxed/master.m3u8') });
  await wait(() => off.outbox.some((m) => m.type === 'offscreen:done' && m.jobId === 'E'));
  console.log('E ok', done('E')[0].ok, 'blobs alive', off.blobs.size);
  await off.send({ type: 'offscreen:revoke', blobUrl: done('E')[0].blobUrl });
  console.log('after revoke', off.blobs.size, 'ffmpeg loads', stats.loads);
  // A stalled response body: cancel must still end the job promptly.
  const stallOff = loadOffscreen({ server: makeServer({ stall: ['hi/s001.ts'] }), stats: { loads: 0, execs: [], writes: 0, mounts: 0, terminates: 0 } });
  await stallOff.send({ type: 'offscreen:assemble', jobId: 'F', item: item('muxed/master.m3u8') });
  await new Promise((r) => setTimeout(r, 300));
  await stallOff.send({ type: 'offscreen:cancel', jobId: 'F' });
  await wait(() => stallOff.outbox.some((m) => m.type === 'offscreen:done' && m.jobId === 'F'), 5000);
  const doneF = stallOff.outbox.find((m) => m.type === 'offscreen:done' && m.jobId === 'F');
  console.log('F (stalled body, canceled)', JSON.stringify({ ok: doneF.ok, canceled: doneF.canceled }));
  // Messages from content scripts (sender.tab set) are ignored.
  const spoof = await new Promise((resolve) => {
    let got;
    for (const fn of off.listeners) fn({ type: 'offscreen:status' }, { id: 'test', tab: { id: 1 } }, (r) => (got = r));
    setTimeout(() => resolve(got), 50);
  });
  const expect = [
    [doneF.canceled, true], [spoof, undefined],
    [JSON.stringify(st), JSON.stringify({ active: 'A', queued: ['B', 'C'] })],
    [done('A')[0]?.ok, true], [done('B')[0]?.ok, true], [done('C')[0]?.canceled, true], [done('D')[0]?.canceled, true],
    [idxDoneA < idxFirstBDownload, true], [done('E')[0]?.ok, true], [done('B').length, 1], [stats.loads, 1],
  ];
  const bad = expect.filter(([a, b]) => a !== b);
  console.log(bad.length ? 'FAIL queue checks ' + JSON.stringify(bad) : `queue: ${expect.length}/${expect.length} passed`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
