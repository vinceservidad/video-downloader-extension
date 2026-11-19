// content.js
//
// Detects <video>/<source> URLs in the page (and its frames) and reports them
// to the service worker. Network-level detection (HLS playlists, etc.) happens
// in background.js; downloading happens in the offscreen document. This file
// only discovers media that's referenced directly in the markup, and answers
// the popup's "which lesson is this?" question.

(function () {
  if (window.__myVideoDownloaderLoaded) return;
  window.__myVideoDownloaderLoaded = true;

  const reported = new Set();
  let observer = null;
  let interval = null;
  let pending = null;

  // After the extension is reloaded/removed, this orphaned copy keeps running
  // in open tabs; stop quietly instead of throwing on every tick.
  function alive() {
    if (chrome.runtime?.id) return true;
    observer?.disconnect();
    clearInterval(interval);
    clearTimeout(pending);
    return false;
  }

  function collect() {
    const urls = [];
    document.querySelectorAll("video").forEach((v) => {
      if (v.currentSrc) urls.push(v.currentSrc);
      if (v.src) urls.push(v.src);
    });
    document.querySelectorAll("video source").forEach((s) => {
      if (s.src) urls.push(s.src);
    });
    const fresh = urls.filter((u) => u && !u.startsWith("blob:") && !reported.has(u));
    if (!fresh.length) return;
    fresh.forEach((u) => reported.add(u));
    try {
      chrome.runtime.sendMessage({ type: "content:detections", urls: fresh }).catch(() => {});
    } catch {}
  }

  // Best-effort: this lesson's position in the classroom sidebar, so the popup
  // can prefix the filename (e.g. "03 - ..."). Based on the ?md= ids in sidebar
  // links, not on styling, so it's resilient — returns null if it can't tell.
  function computeLesson() {
    try {
      const cur = new URL(location.href).searchParams.get("md");
      if (!cur) return null;
      const ids = [];
      document.querySelectorAll('a[href*="md="]').forEach((a) => {
        try {
          const id = new URL(a.href, location.origin).searchParams.get("md");
          if (id) ids.push(id);
        } catch {}
      });
      const uniq = [...new Set(ids)];
      const idx = uniq.indexOf(cur);
      return idx >= 0 ? { number: idx + 1, total: uniq.length } : null;
    } catch {
      return null;
    }
  }

  // Answer the popup's direct request (computed on demand, never stale).
  if (window.top === window) {
    chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
      if (msg?.type === "cs:lesson") {
        sendResponse(computeLesson());
        return true;
      }
    });
  }

  function tick() {
    pending = null;
    if (alive()) collect();
  }
  // Coalesce DOM mutation bursts (SPAs mutate constantly) into one scan.
  function schedule() {
    if (!pending) pending = setTimeout(tick, 500);
  }

  tick();
  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });
  // currentSrc can change without a DOM mutation (source selection).
  interval = setInterval(tick, 3000);
})();
