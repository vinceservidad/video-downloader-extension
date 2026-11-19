// Builds a clean distributable zip of runtime extension files only
// (excludes dev/, backup-*/, .claude/, .DS_Store, generate-icons.js).
// Usage: `node dev/pack.cjs`
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// Explicit runtime allowlist so stray dev/backup/editor files never slip in.
const FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'offscreen.html',
  'offscreen.js',
  'popup.html',
  'popup.js',
  'muxjs.min.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'vendor/ffmpeg.js',
  'vendor/814.ffmpeg.js',
  'vendor/ffmpeg-core.js',
  'vendor/ffmpeg-core.wasm',
];

const missing = FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) {
  console.error('Missing runtime file(s):', missing.join(', '));
  process.exit(1);
}

const distDir = path.join(__dirname, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const outZip = path.join(distDir, `my-video-downloader-v${manifest.version}.zip`);
if (fs.existsSync(outZip)) fs.unlinkSync(outZip);

const r = spawnSync('zip', ['-q', '-9', outZip, ...FILES], { cwd: ROOT, encoding: 'utf8' });
if (r.status !== 0) {
  console.error('zip failed:', r.stderr || r.stdout || r.error);
  process.exit(1);
}

const sizeMB = (fs.statSync(outZip).size / 1048576).toFixed(2);
console.log(`Packed ${FILES.length} files -> ${path.relative(ROOT, outZip)} (${sizeMB} MB)`);
