// Reproductions of bugs found in review (they print what happened); each must
// now show the fixed behavior. Run via run-all.cjs.
const { spawnSync } = require('child_process');
const path = require('path');
const CASES = [
  ['regress-job-races.cjs', [/WAKE: done/, /CANCEL-LOOM: .*final canceled/, /CANCEL-OFF: .*final canceled/]],
  ['regress-auth-wake.cjs', [/AUTH-WAKE: done frame .*frame-save/]],
  ['regress-cancel-windows.cjs', [/T1 final status: canceled/, /T2 muxed fetches .*: 0 -> 0/]],
  ['regress-cookie-scope.cjs', [/co\.uk.*\["example\.co\.uk"\]/, /\["d222\.cloudfront\.net"\]/], [/bank-secret/]],
  ['regress-popup-late-card.cjs', [/Saved ✓ 01 - Lesson\.mp4/]],
  ['regress-frame-file.cjs', [/A .*final: done/, /B .*final: done/, /C saved in page after cancel: \[\] \| final: canceled/]],
  ['regress-earlier-name.cjs', [/Earlier video/], [/Lesson Two\.mp4/]],
  ['regress-loom-one-card.cjs', [/reopen cards \[\s*'01 - Lesson One\|[^\]]*\]/s, /downloads \[ '[^']+' \]/]],
  ['regress-reconcile-wake.cjs', [/OK  quiet 90s .*final status: done/, /403 quiet 90s .*final status: done/]],
];
let pass = 0;
for (const [file, must, mustNot = []] of CASES) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const out = (r.stdout || '') + (r.stderr || '').split('\n').filter((l) => !l.startsWith('[')).join('\n');
  const bad = [...must.filter((re) => !re.test(out)).map((re) => 'missing ' + re), ...mustNot.filter((re) => re.test(out)).map((re) => 'unexpected ' + re)];
  if (bad.length) console.log('FAIL', file, '-', bad.join('; '), '\n' + out.split('\n').slice(-8).join('\n'));
  else pass++;
}
console.log(`\n${pass}/${CASES.length} passed`);
process.exit(pass === CASES.length ? 0 : 1);
