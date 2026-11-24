const fs = require('fs');
const path = require('path');
const { makeServer, loadOffscreen, probe, OUTDIR } = require('./harness.cjs');
const S = '?sig=ok';
const CASES = [
  { name: 'muxed-master-highest', url: 'https://cdn.test/muxed/master.m3u8' + S, quality: 'highest', expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'muxed-lo-direct', url: 'https://cdn.test/muxed/lo/index.m3u8' + S, expect: { video: true, audio: true } },
  { name: 'muxed-master-480', url: 'https://cdn.test/muxed/master.m3u8' + S, quality: '480', expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'split-ts-default-audio', url: 'https://cdn.test/split/master.m3u8' + S, quality: 'highest', expect: { video: true, audio: true, audioStreams: 1, minDur: 7.5 } },
  { name: 'split-fmp4', url: 'https://cdn.test/fmp4/master.m3u8' + S, quality: 'highest', expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'aes-explicit-iv', url: 'https://cdn.test/aes/iv/index.m3u8' + S, expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'aes-seq-iv', url: 'https://cdn.test/aes/seq/index.m3u8' + S, expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'aes-short-iv', sameAs: 'aes-seq-iv', url: 'https://cdn.test/aes/short/index.m3u8' + S, expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'byterange-ts', url: 'https://cdn.test/br/index.m3u8' + S, expect: { video: true, audio: true, minDur: 7.5, maxDur: 8.5 } },
  { name: 'byterange-fmp4', url: 'https://cdn.test/brf/index.m3u8' + S, expect: { video: true, audio: true, minDur: 7.5, maxDur: 8.5 } },
  { name: 'direct-file', url: 'https://cdn.test/direct.mp4' + S, kind: 'file', expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'retry-503', url: 'https://cdn.test/muxed/master.m3u8' + S, server: { failOnce: ['muxed/hi/s001.ts'] }, expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'muxjs-fallback-ts', url: 'https://cdn.test/muxed/master.m3u8' + S, off: { noFFmpeg: true }, expectMode: 'hls-mp4-muxjs', muxjsDur: true, expect: { video: true, audio: true } },
  { name: 'exec-crash-fallback', url: 'https://cdn.test/aes/seq/index.m3u8' + S, off: { execFails: true }, expectMode: 'hls-mp4-muxjs', muxjsDur: true, expect: { video: true, audio: true } },
  { name: 'raw-fmp4-fallback', url: 'https://cdn.test/brf/index.m3u8' + S, off: { noFFmpeg: true }, expectMode: 'fmp4', expect: { video: true, audio: true } },
  { name: 'writefile-fallback', url: 'https://cdn.test/split/master.m3u8' + S, off: { mountFails: true }, expectMode: 'av-mux', expect: { video: true, audio: true } },
  { name: 'split-no-ffmpeg-errors', url: 'https://cdn.test/split/master.m3u8' + S, off: { noFFmpeg: true }, expectError: /ffmpeg/ },
  { name: 'ignore-range-server', url: 'https://cdn.test/br/index.m3u8' + S, server: { ignoreRange: true }, expect: { video: true, audio: true } },
  { name: 'encrypted-init-fmp4', url: 'https://cdn.test/encinit/index.m3u8' + S, expect: { video: true } },
  { name: 'ladder-lowest-skips-audio-only', url: 'https://cdn.test/muxed/ladder.m3u8' + S, quality: 'lowest', sameAs: 'muxed-lo-direct', expect: { video: true, audio: true } },
  { name: 'portrait-360-short-side', url: 'https://cdn.test/muxed/portrait.m3u8' + S, quality: '360', sameAs: 'muxed-master-highest', expect: { video: true, audio: true } },
  { name: 'workerfs-exec-fails-retry-memfs', url: 'https://cdn.test/split/master.m3u8' + S, off: { mountedExecFails: true }, expectMode: 'av-mux', expect: { video: true, audio: true } },
  { name: 'sign-in-page-flags-auth', url: 'https://cdn.test/muxed/master.m3u8' + S, server: { htmlOmit: true }, expectError: /sign-in page/, expectAuth: true },
  { name: 'direct-file-sign-in-page', url: 'https://cdn.test/direct.mp4' + S, kind: 'file', server: { htmlOmit: true }, expectError: /sign-in page/, expectAuth: true },
  { name: 'forbidden-403', url: 'https://cdn.test/muxed/master.m3u8' + S, server: { forbid: ['hi/s002.ts'] }, expectError: /403/ },
  { name: 'dash-template-highest', url: 'https://cdn.test/dash/template/manifest.mpd' + S, kind: 'dash', quality: 'highest', expectMode: 'dash-av-mux', expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'dash-template-lowest', url: 'https://cdn.test/dash/template/manifest.mpd' + S, kind: 'dash', quality: 'lowest', expectMode: 'dash-av-mux', expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'dash-timeline', url: 'https://cdn.test/dash/timeline/manifest.mpd' + S, kind: 'dash', expectMode: 'dash-av-mux', expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'dash-segment-list', url: 'https://cdn.test/dash/list/manifest.mpd' + S, kind: 'dash', expectMode: 'dash-av-mux', expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'dash-single-baseurl', url: 'https://cdn.test/dash/single/manifest.mpd' + S, kind: 'dash', expectMode: 'dash-mp4', expect: { video: true, audio: true, minDur: 7.5 } },
  { name: 'dash-drm-rejected', url: 'https://cdn.test/dash/drm/manifest.mpd' + S, kind: 'dash', expectError: /DRM-protected/ },
  { name: 'dash-sign-in-page', url: 'https://cdn.test/dash/template/manifest.mpd' + S, kind: 'dash', server: { htmlOmit: true }, expectError: /sign-in page/, expectAuth: true },
];
const only = process.argv[2];
(async () => {
  const results = [];
  for (const c of CASES) {
    if (only && !c.name.includes(only)) continue;
    const stats = { loads: 0, execs: [], writes: 0, mounts: 0, terminates: 0 };
    const server = makeServer(c.server);
    const off = loadOffscreen({ server, stats, ...(c.off || {}) });
    const jobId = 'j-' + c.name;
    const t0 = Date.now();
    let res;
    try {
      const r = await off.send({ type: 'offscreen:assemble', jobId, item: { url: c.url, kind: c.kind || 'hls', quality: c.quality || 'highest' }, quality: c.quality });
      if (r && r.accepted) {
        for (;;) {
          const done = off.outbox.find((m) => m.type === 'offscreen:done' && m.jobId === jobId);
          if (done) { res = done; break; }
          await new Promise((r) => setTimeout(r, 20));
          if (Date.now() - t0 > 120000) throw new Error('timeout');
        }
      } else res = r;
    } catch (e) { res = { ok: false, error: 'harness: ' + e.message }; }
    const row = { name: c.name, ms: Date.now() - t0, mode: res?.mode, ok: !!res?.ok };
    if (res?.ok) {
      const blob = off.blobs.get(res.blobUrl);
      const bytes = blob._bytes || new Uint8Array(await blob.arrayBuffer());
      fs.writeFileSync(path.join(OUTDIR, c.name + (res.ext || '.mp4')), bytes);
      const p = await probe(bytes, c.name + '.bin');
      Object.assign(row, { size: bytes.length, fmt: p.format, v: p.video, a: p.audio, aN: p.audioStreams, dur: p.duration, dec: p.decodedTo, errs: p.errors, execs: stats.execs.length, mounts: stats.mounts, writes: stats.writes });
      const e = c.expect || {};
      const fails = [];
      if (c.expectError) fails.push('expected error');
      if (e.video && !p.video) fails.push('no video');
      if (e.audio && !p.audio) fails.push('no audio');
      if (!e.audio && p.audio && c.name.startsWith('encrypted')) {}
      if (e.audioStreams && p.audioStreams !== e.audioStreams) fails.push('audioStreams=' + p.audioStreams);
      if (c.expectMode && res.mode !== c.expectMode) fails.push('mode ' + res.mode);
      // Normal ffmpeg runs must read inputs through WORKERFS, not copy them in.
      if (stats.execs.length && !c.off && stats.writes) fails.push('used writeFile instead of WORKERFS');
      if (c.name === 'workerfs-exec-fails-retry-memfs' && !(stats.execs.length === 2 && stats.writes === 2)) fails.push('no MEMFS retry');
      if (c.name === 'exec-crash-fallback' && stats.writes) fails.push('copied inputs into memory after a crash');
      if (c.name === 'ignore-range-server' && server.hits.get('br/index.ts') > 1) fails.push('whole file fetched ' + server.hits.get('br/index.ts') + 'x');
      for (const [k, d] of (c.muxjsDur ? [['decoded', p.decodedTo]] : [['header', p.duration], ['decoded', p.decodedTo]])) {
        if (!(d >= 7.5 && d <= 8.6)) fails.push(k + ' duration ' + d);
      }
      row.md5 = require('crypto').createHash('md5').update(bytes).digest('hex').slice(0, 8);
      if (c.sameAs) { const o = results.find((r) => r.name === c.sameAs); if (!o || o.md5 !== row.md5) fails.push('differs from ' + c.sameAs); }
      if (p.errors) fails.push(p.errors + ' decode errors');
      if (p.ret !== 0) fails.push('probe ret ' + p.ret + ' ' + p.tail);
      row.pass = fails.length ? 'FAIL: ' + fails.join(', ') : 'PASS';
    } else {
      row.error = (res?.error || '').slice(0, 160);
      row.pass = c.expectError && c.expectError.test(res?.error || '') && (!c.expectAuth || res.auth) ? 'PASS' : 'FAIL';
    }
    const segHits = [...server.hits.entries()].filter(([k]) => /\.(ts|m4s)$/.test(k)).reduce((a, [, v]) => a + v, 0);
    row.segReqs = segHits;
    results.push(row);
    console.log(JSON.stringify(row));
  }
  const failed = results.filter((r) => r.pass !== 'PASS');
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
