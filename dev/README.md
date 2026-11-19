# Dev tests

`node dev/run-all.cjs` — runs everything in Node (20+), no installs needed:

- `run-offscreen.cjs` — the real `offscreen.js` against a fake CDN (signed
  query required, Range support, fault injection) with fixtures made by the
  vendored ffmpeg core. Outputs are decoded to check video/audio/duration.
- `run-queue.cjs` — offscreen job queue, cancel and progress semantics.
- `sw-tests.cjs` — the real `background.js` with a mocked `chrome.*`, wired to
  the real offscreen pipeline: detection filtering, SPA navigation, job
  lifecycle, worker restarts, Loom paths, fallbacks, DNR rule scoping.
- `popup-tests.cjs` — the real `popup.js` in a tiny fake DOM on top of that:
  job display on reopen, jobs from a previous lesson, folder memory.
- `regressions.cjs` — runs the `regress-*.cjs` reproductions of bugs found in
  review (worker-restart races, late cancels, cookie scoping, …) and checks
  their output shows the fixed behavior.

Fixtures are generated into `dev/fixtures/` on first run (~2 MB). These only
cover logic; still check a real lesson in Chrome after changes.

`node dev/pack.cjs` — builds a clean zip of only the runtime extension files
into `dev/dist/my-video-downloader-v<version>.zip` (excluding `dev/`, backups,
and editor files).
