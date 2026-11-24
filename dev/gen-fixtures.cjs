// Generate HLS test fixtures into dev/fixtures with the vendored ffmpeg core
// running in Node (no system ffmpeg needed).
const path = require('path');
const fs = require('fs');
const VENDOR = path.join(__dirname, '..', 'vendor');
const OUT = path.join(__dirname, 'fixtures');
globalThis.self = globalThis;
const createFFmpegCore = require(path.join(VENDOR, 'ffmpeg-core.js'));
(async () => {
  const core = await createFFmpegCore({
    locateFile: (p) => path.join(VENDOR, p),
    mainScriptUrlOrBlob: path.join(VENDOR, 'ffmpeg-core.js') + '#' + Buffer.from(JSON.stringify({ wasmURL: path.join(VENDOR, 'ffmpeg-core.wasm') })).toString('base64'),
  });
  let log = [];
  core.setLogger((m) => log.push(m.message));
  const run = (args) => { log = []; core.exec(...args); const r = core.ret; core.reset(); if (r !== 0) { console.error(log.slice(-15).join('\n')); throw new Error('ffmpeg ' + r); } };
  const FS = core.FS;
  const dump = (dir) => {
    const walk = (d) => FS.readdir(d).filter((n) => n !== '.' && n !== '..').forEach((n) => {
      const p = d + '/' + n; const st = FS.stat(p);
      if (FS.isDir(st.mode)) return walk(p);
      const rel = p.replace(/^\/w\//, '');
      fs.mkdirSync(path.join(OUT, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(OUT, rel), FS.readFile(p));
    });
    walk(dir);
  };
  FS.mkdir('/w');
  run(['-f','lavfi','-i','testsrc=size=640x360:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','8','-c:v','libx264','-g','25','-pix_fmt','yuv420p','-c:a','aac','-b:a','64k','-shortest','/w/src.mp4']);
  run(['-i','/w/src.mp4','-vf','scale=320:180','-c:v','libx264','-g','25','-c:a','copy','/w/src180.mp4']);

  const mk = (d) => { try { FS.mkdir('/w/' + d); } catch {} };
  // 1) muxed A/V TS, two variants
  mk('muxed'); mk('muxed/hi'); mk('muxed/lo');
  run(['-i','/w/src.mp4','-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_segment_filename','/w/muxed/hi/s%03d.ts','/w/muxed/hi/index.m3u8']);
  run(['-i','/w/src180.mp4','-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_segment_filename','/w/muxed/lo/s%03d.ts','/w/muxed/lo/index.m3u8']);
  FS.writeFile('/w/muxed/master.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180\nlo/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360\nhi/index.m3u8\n');
  // 2) split audio rendition, TS
  mk('split'); mk('split/v'); mk('split/a');
  run(['-i','/w/src.mp4','-map','0:v','-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_segment_filename','/w/split/v/s%03d.ts','/w/split/v/index.m3u8']);
  run(['-i','/w/src.mp4','-map','0:a','-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_segment_filename','/w/split/a/s%03d.ts','/w/split/a/index.m3u8']);
  FS.writeFile('/w/split/master.m3u8', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Commentary",DEFAULT=NO,URI="a/missing.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,AUTOSELECT=YES,URI="a/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360,AUDIO="aud"\nv/index.m3u8\n');
  // 3) split audio, fMP4
  mk('fmp4'); mk('fmp4/v'); mk('fmp4/vlo'); mk('fmp4/a');
  run(['-i','/w/src.mp4','-map','0:v','-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename','/w/fmp4/v/s%03d.m4s','/w/fmp4/v/index.m3u8']);
  run(['-i','/w/src180.mp4','-map','0:v','-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename','/w/fmp4/vlo/s%03d.m4s','/w/fmp4/vlo/index.m3u8']);
  run(['-i','/w/src.mp4','-map','0:a','-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename','/w/fmp4/a/s%03d.m4s','/w/fmp4/a/index.m3u8']);
  FS.writeFile('/w/fmp4/master.m3u8', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,URI="a/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360,AUDIO="aud"\nv/index.m3u8\n');
  // 4) AES-128, muxed TS, explicit IV and implicit (sequence) IV
  mk('aes'); mk('aes/iv'); mk('aes/seq');
  const key = Uint8Array.from({ length: 16 }, (_, i) => i * 7 + 3);
  FS.writeFile('/w/aes/key.bin', key);
  FS.writeFile('/w/aes/ki_iv.txt', 'key.bin\n/w/aes/key.bin\n0123456789abcdef0123456789abcdef\n');
  FS.writeFile('/w/aes/ki_seq.txt', 'key.bin\n/w/aes/key.bin\n');
  run(['-i','/w/src.mp4','-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_key_info_file','/w/aes/ki_iv.txt','-hls_segment_filename','/w/aes/iv/s%03d.ts','/w/aes/iv/index.m3u8']);
  run(['-i','/w/src.mp4','-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-start_number','5','-hls_key_info_file','/w/aes/ki_seq.txt','-hls_segment_filename','/w/aes/seq/s%03d.ts','/w/aes/seq/index.m3u8']);
  // 5) byte-range single file, muxed TS
  mk('br');
  run(['-i','/w/src.mp4','-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_flags','single_file','/w/br/index.m3u8']);
  // 6) byte-range fMP4 single file (EXT-X-MAP with BYTERANGE)
  mk('brf');
  run(['-i','/w/src.mp4','-c','copy','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_flags','single_file','/w/brf/index.m3u8']);
  // 7) direct mp4
  FS.writeFile('/w/direct.mp4', FS.readFile('/w/src.mp4'));
  FS.unlink('/w/src.mp4'); FS.unlink('/w/src180.mp4');
  fs.rmSync(OUT, { recursive: true, force: true });
  dump('/w');
  postProcess();
  console.log('fixtures written to', OUT);
})().catch((e) => { console.error('ERR', e); process.exit(1); });

// Hand-made variants ffmpeg can't emit directly.
function postProcess() {
  const P = (f) => path.join(OUT, f);
  const rd = (f) => fs.readFileSync(P(f), 'utf8');
  const wr = (f, d) => { fs.mkdirSync(path.dirname(P(f)), { recursive: true }); fs.writeFileSync(P(f), d); };
  // AES: keys one level up; "seq" relies on the implicit (media sequence) IV;
  // "short" uses a non-padded IV that must be right-aligned.
  wr('aes/iv/index.m3u8', rd('aes/iv/index.m3u8').replace('URI="key.bin"', 'URI="../key.bin"'));
  const seq = rd('aes/seq/index.m3u8').replace(',IV=0x00000000000000000000000000000005', '').replace('URI="key.bin"', 'URI="../key.bin"');
  wr('aes/seq/index.m3u8', seq);
  for (const f of fs.readdirSync(P('aes/seq')).filter((f) => f.endsWith('.ts'))) wr('aes/short/' + f, fs.readFileSync(P('aes/seq/' + f)));
  wr('aes/short/index.m3u8', seq.replace('METHOD=AES-128,URI="../key.bin"', 'METHOD=AES-128,URI="../key.bin",IV=0x5'));
  // fMP4 whose init section is encrypted too (EXT-X-KEY before EXT-X-MAP).
  const c = require('crypto');
  const key = fs.readFileSync(P('aes/key.bin'));
  const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const enc = (b) => { const x = c.createCipheriv('aes-128-cbc', key, iv); return Buffer.concat([x.update(b), x.final()]); };
  wr('encinit/init.mp4', enc(fs.readFileSync(P('fmp4/v/init.mp4'))));
  for (const f of fs.readdirSync(P('fmp4/v')).filter((f) => f.endsWith('.m4s'))) wr('encinit/' + f, enc(fs.readFileSync(P('fmp4/v/' + f))));
  wr('encinit/index.m3u8', rd('fmp4/v/index.m3u8').replace('#EXT-X-MAP:URI="init.mp4"', '#EXT-X-KEY:METHOD=AES-128,URI="../aes/key.bin",IV=0x000102030405060708090a0b0c0d0e0f\n#EXT-X-MAP:URI="init.mp4"'));
  // Ladder with an audio-only entry, and a portrait ladder.
  wr('muxed/ladder.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\n../split/a/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,CODECS="avc1.4d401e,mp4a.40.2"\nlo/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"\nhi/index.m3u8\n');
  wr('muxed/portrait.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=180x320\nlo/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=360x640\nhi/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=720x1280\nmissing/index.m3u8\n');

  // DASH (.mpd) manifests built on the generated fMP4 segments & direct.mp4.
  const vSegs = fs.readdirSync(P('fmp4/v')).filter((f) => f.endsWith('.m4s')).sort();
  const aSegs = fs.readdirSync(P('fmp4/a')).filter((f) => f.endsWith('.m4s')).sort();
  wr('dash/template/manifest.mpd', `<?xml version="1.0" encoding="UTF-8"?>
<MPD type="static" mediaPresentationDuration="PT${vSegs.length * 2}S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate initialization="../../fmp4/$RepresentationID$/init.mp4" media="../../fmp4/$RepresentationID$/s$Number%03d$.m4s" timescale="1" duration="2" startNumber="0"/>
      <Representation id="vlo" bandwidth="300000" width="320" height="180" codecs="avc1.4d401e"/>
      <Representation id="v" bandwidth="1200000" width="640" height="360" codecs="avc1.4d401e"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
      <SegmentTemplate initialization="../../fmp4/$RepresentationID$/init.mp4" media="../../fmp4/$RepresentationID$/s$Number%03d$.m4s" timescale="1" duration="2" startNumber="0"/>
      <Representation id="a" bandwidth="64000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`);
  wr('dash/timeline/manifest.mpd', `<?xml version="1.0" encoding="UTF-8"?>
<MPD type="static" mediaPresentationDuration="PT8S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate initialization="../../fmp4/$RepresentationID$/init.mp4" media="../../fmp4/$RepresentationID$/s$Number%03d$.m4s" timescale="1000" startNumber="0">
        <SegmentTimeline><S t="0" d="2000" r="${vSegs.length - 1}"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v" bandwidth="1200000" width="640" height="360"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <SegmentTemplate initialization="../../fmp4/$RepresentationID$/init.mp4" media="../../fmp4/$RepresentationID$/s$Number%03d$.m4s" timescale="1000" startNumber="0">
        <SegmentTimeline><S t="0" d="2000" r="${aSegs.length - 1}"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="a" bandwidth="64000"/>
    </AdaptationSet>
  </Period>
</MPD>`);
  wr('dash/list/manifest.mpd', `<?xml version="1.0" encoding="UTF-8"?>
<MPD type="static" mediaPresentationDuration="PT8S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v" bandwidth="1200000" width="640" height="360">
        <BaseURL>../../fmp4/v/</BaseURL>
        <SegmentList>
          <Initialization sourceURL="init.mp4"/>
          ${vSegs.map((s) => `<SegmentURL media="${s}"/>`).join('\n          ')}
        </SegmentList>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="a" bandwidth="64000">
        <BaseURL>../../fmp4/a/</BaseURL>
        <SegmentList>
          <Initialization sourceURL="init.mp4"/>
          ${aSegs.map((s) => `<SegmentURL media="${s}"/>`).join('\n          ')}
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`);
  wr('dash/single/manifest.mpd', `<?xml version="1.0" encoding="UTF-8"?>
<MPD type="static" mediaPresentationDuration="PT8S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="single" bandwidth="1200000" width="640" height="360">
        <BaseURL>../../direct.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`);
  wr('dash/drm/manifest.mpd', `<?xml version="1.0" encoding="UTF-8"?>
<MPD type="static" mediaPresentationDuration="PT8S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <SegmentTemplate initialization="../../fmp4/v/init.mp4" media="../../fmp4/v/s$Number%03d$.m4s" timescale="1" duration="2" startNumber="0"/>
      <Representation id="v" bandwidth="1200000" width="640" height="360"/>
    </AdaptationSet>
  </Period>
</MPD>`);
}
