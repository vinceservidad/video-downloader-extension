// Runs every dev test: `node dev/run-all.cjs` (Node 20+, no other installs).
// Generates dev/fixtures on first run using the vendored ffmpeg core.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const node = process.execPath;
const run = (f) => spawnSync(node, [path.join(__dirname, f)], { encoding: 'utf8', maxBuffer: 64 << 20 });
if (!fs.existsSync(path.join(__dirname, 'fixtures', 'direct.mp4'))) {
  console.log('Generating fixtures…');
  const g = run('gen-fixtures.cjs');
  if (g.status !== 0) { console.error(g.stdout, g.stderr); process.exit(1); }
}
let failed = 0;
for (const f of ['run-offscreen.cjs', 'run-queue.cjs', 'sw-tests.cjs', 'popup-tests.cjs', 'regressions.cjs']) {
  const r = run(f);
  const out = (r.stdout || '').split('\n').filter((l) => l && !l.startsWith('['));
  if (r.status !== 0) failed++;
  console.log(`== ${f}: ${out.filter((l) => /\d+\/\d+ passed/.test(l)).join(' | ') || '(no summary)'}${r.status ? '  <-- FAILED' : ''}`);
  // Show failing rows (JSON rows carry "pass":"FAIL…"; others start with FAIL).
  out.filter((l) => /^FAIL|"pass":"FAIL|^ERR/.test(l)).forEach((l) => console.log('   ' + l.slice(0, 300)));
  if (r.status && r.stderr) console.log(r.stderr.split('\n').filter((l) => l && !l.startsWith('[')).slice(-5).join('\n'));
}
console.log(failed ? `\n${failed} problem(s)` : '\nall good');
process.exit(failed ? 1 : 0);
