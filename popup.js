// popup.js — renders detected media for the active tab and drives download jobs.
//
// Downloads run as jobs in the service worker, so this popup can close and
// reopen at any time: it re-attaches to running jobs and shows their progress.

const listEl = document.getElementById("list");
const countEl = document.getElementById("count");

let activeTabId = null;
let pageUrl = ""; // active tab URL (top-level site for partitioned-cookie lookup)
let baseName = "video"; // derived from the page/lesson title (incl. NN- prefix)
let selectedQuality = "highest";
let saveFolder = ""; // "" = your plain Downloads folder
let askWhere = false; // default: silent auto-save (no dialog, no bubble)

const cards = new Map(); // item url -> card controller
const jobsByUrl = new Map(); // item url -> latest public job

function send(message) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(message, (r) => resolve(chrome.runtime.lastError ? undefined : r))
  );
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Ask the page for this lesson's sidebar position. Injects the content script
// first if the tab predates the last extension reload (so it works without a
// manual page refresh). Returns { number, total } or null.
async function getLesson() {
  const ask = () =>
    new Promise((resolve) =>
      chrome.tabs.sendMessage(activeTabId, { type: "cs:lesson" }, { frameId: 0 }, (r) =>
        resolve(chrome.runtime.lastError ? undefined : r)
      )
    );
  let r = await ask();
  if (r === undefined) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: activeTabId, frameIds: [0] }, files: ["content.js"] });
      r = await ask();
    } catch {}
  }
  return r || null;
}

// Display cleanup only; the service worker makes the name filesystem-safe.
function cleanTitle(name) {
  return (name || "video").replace(/\s+/g, " ").trim() || "video";
}

const ACTIVE = new Set(["starting", "queued", "downloading", "muxing", "saving"]);
const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
const baseOf = (p) => (p || "").replace(/\\/g, "/").split("/").pop();

function statusText(job) {
  const pct = job.total ? Math.floor((job.done / job.total) * 100) : null;
  switch (job.status) {
    case "starting":
      return job.stage === "loom" ? "Asking Loom for the video…" : "Starting…";
    case "queued":
      return job.stage === "queued" ? "Waiting for the previous download to finish…" : "Preparing…";
    case "downloading":
      if (job.route === "frame") return "Downloading inside the page" + (pct != null ? ` ${pct}%` : "") + "…";
      if (job.kind === "file") return job.total ? `Downloading ${pct}% (${mb(job.done)} of ${mb(job.total)})` : job.done ? `Downloading ${mb(job.done)}…` : "Downloading…";
      return pct != null ? `Downloading ${pct}% (${job.done}/${job.total} segments)` : "Downloading…";
    case "muxing":
      return `Merging into MP4…${pct ? ` ${pct}%` : ""}`;
    case "saving":
      return job.saveAs ? "Choose where to save…" : "Saving…";
    case "done":
      return "Saved ✓ " + (baseOf(job.savedPath) || "") + (job.note ? " — " + job.note : "");
    case "canceled":
      return "Canceled";
    case "error":
      return "Error: " + (job.error || "unknown");
  }
  return "";
}

function makeCard(item, { label, recommended, suffix, jobOnly }) {
  const card = document.createElement("div");
  card.className = "item";

  const fname = document.createElement("input");
  fname.className = "fname";
  fname.type = "text";
  // An "earlier" video is from a previous lesson: don't give it this lesson's name.
  fname.value = jobOnly ? item.name : (item.role === "earlier" ? "Earlier video" : baseName) + (suffix || "");
  fname.spellcheck = false;
  fname.readOnly = !!jobOnly;

  const meta = document.createElement("div");
  meta.className = "meta";
  if (recommended) {
    const rec = document.createElement("span");
    rec.className = "rec";
    rec.textContent = "recommended";
    meta.append(rec);
  }
  const tag = document.createElement("span");
  const tagText = item.role === "earlier" ? "earlier" : item.role === "job" ? "job" : item.kind;
  tag.className = "tag " + (item.role === "earlier" || item.role === "job" ? "earlier" : item.kind);
  tag.textContent = tagText;
  const lbl = document.createElement("span");
  lbl.textContent = label + (item.q ? " · " + item.q : "");
  meta.append(tag, lbl);

  const actions = document.createElement("div");
  actions.className = "actions";
  const btn = document.createElement("button");
  const isStream = item.kind === "hls" || item.kind === "dash";
  btn.textContent = isStream ? "Download (merge stream)" : "Download";
  const cancel = document.createElement("button");
  cancel.className = "cancel";
  cancel.textContent = "Cancel";
  actions.append(btn, cancel);

  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("div");
  bar.append(fill);

  const status = document.createElement("div");
  status.className = "status";

  const details = document.createElement("details");
  details.className = "details";
  details.hidden = true;
  const sum = document.createElement("summary");
  sum.textContent = "Details";
  const detailText = document.createElement("div");
  details.append(sum, detailText);

  // A job whose video isn't listed any more (e.g. you moved to the next lesson):
  // show its progress and Cancel, but no Download button — a retry from here
  // could pick up the current lesson's player instead.
  if (jobOnly) btn.style.display = "none";

  let pollTimer = null;
  function show(job) {
    const active = ACTIVE.has(job.status);
    btn.disabled = active;
    btn.textContent = active
      ? "Downloading…"
      : job.status === "done"
        ? "Download again"
        : job.status === "error"
          ? "Try again"
          : isStream
            ? "Download (merge stream)"
            : "Download";
    cancel.style.display = active ? "block" : "none";
    status.textContent = statusText(job);
    status.className = "status" + (job.status === "done" ? " ok" : job.status === "error" ? " err" : "");
    const pct = job.total ? Math.min(100, Math.floor((job.done / job.total) * 100)) : 0;
    bar.style.display = job.status === "downloading" || job.status === "muxing" ? "block" : "none";
    bar.classList.toggle("mux", job.status === "muxing");
    fill.style.width = pct + "%";
    details.hidden = !(job.status === "error" && job.detail);
    detailText.textContent = job.detail || "";
    // Chrome is streaming the file itself (e.g. Loom's MP4): show its progress.
    clearInterval(pollTimer);
    if (job.status === "saving" && job.downloadId != null) {
      const poll = async () => {
        const [d] = await chrome.downloads.search({ id: job.downloadId }).catch(() => []);
        if (!d || d.state !== "in_progress" || !d.bytesReceived) return;
        const t = d.totalBytes > 0 ? d.totalBytes : 0;
        status.textContent = t ? `Downloading ${Math.floor((d.bytesReceived / t) * 100)}% (${mb(d.bytesReceived)} of ${mb(t)})` : `Downloading ${mb(d.bytesReceived)}…`;
        bar.style.display = t ? "block" : "none";
        fill.style.width = (t ? Math.floor((d.bytesReceived / t) * 100) : 0) + "%";
      };
      poll();
      pollTimer = setInterval(poll, 1000);
    }
  }

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    status.className = "status";
    status.textContent = "Starting…";
    details.hidden = true;
    const res = await send({
      type: "popup:download",
      pageUrl,
      tabId: activeTabId,
      quality: selectedQuality,
      folder: saveFolder,
      saveAs: askWhere,
      item: { url: item.url, kind: item.kind, name: fname.value },
    });
    if (!res?.ok) {
      status.className = "status err";
      status.textContent = "Error: " + (res?.error || "the extension didn't respond — reload it and try again");
      btn.disabled = false;
    } else if (res.existing && res.url !== item.url) {
      // Same Loom video, already downloading from another entry.
      status.textContent = "Already downloading this video (see its card).";
      btn.disabled = false;
    }
    // Progress arrives as "job:update" messages.
  });

  cancel.addEventListener("click", async () => {
    const job = jobsByUrl.get(item.url);
    if (job) await send({ type: "popup:cancel", jobId: job.id });
  });

  card.append(fname, meta, actions, bar, status, details);
  return { el: card, show };
}

function render(res) {
  const primary = res?.primary || [];
  const extra = res?.extra || [];
  cards.clear();
  jobsEl = null;
  rendered = true;
  if (!primary.length) {
    countEl.textContent = "";
    listEl.innerHTML =
      '<div class="empty">No videos detected yet.<br>Play the video on the page, then reopen this popup.</div>';
    return;
  }

  const fresh = primary.filter((i) => i.role !== "earlier");
  countEl.textContent = fresh.length ? `${fresh.length} video${fresh.length === 1 ? "" : "s"}` : "";
  listEl.innerHTML = "";

  const add = (parent, item, opts) => {
    const c = makeCard(item, opts);
    cards.set(item.url, c);
    parent.appendChild(c.el);
    const job = jobsByUrl.get(item.url); // an update that arrived before the card
    if (job) c.show(job);
  };

  primary.forEach((item, i) => {
    const earlier = item.role === "earlier";
    add(listEl, item, {
      label: earlier ? "Earlier on this tab" : item.kind === "hls" || item.kind === "dash" ? "Full lesson video" : "Direct file",
      recommended: i === 0 && !earlier,
      suffix: primary.length > 1 ? ` (${i + 1})` : "",
    });
  });

  if (extra.length) {
    const toggle = document.createElement("button");
    toggle.className = "toggle";
    const label = () => `Show ${extra.length} other source${extra.length === 1 ? "" : "s"}`;
    toggle.textContent = label();
    const holder = document.createElement("div");
    holder.style.display = "none";

    extra.forEach((item, i) => {
      add(holder, item, {
        label: item.role === "earlier" ? "Earlier on this tab" : item.kind === "hls" ? "Single quality variant" : "Direct file / clip",
        recommended: false,
        suffix: item.q ? ` (${item.q})` : ` (extra ${i + 1})`,
      });
    });

    toggle.addEventListener("click", () => {
      const shown = holder.style.display !== "none";
      holder.style.display = shown ? "none" : "block";
      toggle.textContent = shown ? label() : "Hide other sources";
    });

    listEl.append(toggle, holder);
  }
}

function applyJob(job) {
  if (job.tabId !== activeTabId) return;
  const prev = jobsByUrl.get(job.url);
  // Never let an older snapshot (e.g. the popup:list reply) undo a newer update,
  // but still make sure the newest one has a card.
  if (!prev || prev.updatedAt <= job.updatedAt) jobsByUrl.set(job.url, job);
  const latest = jobsByUrl.get(job.url);
  if (rendered && !cards.has(job.url)) addJobCard(latest);
  cards.get(job.url)?.show(latest);
}

// Recent jobs on this tab that no listed video card can show.
let jobsEl = null;
let rendered = false;
function addJobCard(job) {
  const recent = ACTIVE.has(job.status) || Date.now() - (job.updatedAt || 0) < 10 * 60_000;
  if (!recent) return;
  if (!jobsEl) {
    jobsEl = document.createElement("div");
    listEl.querySelector(".empty")?.remove();
    listEl.prepend(jobsEl);
  }
  const c = makeCard({ url: job.url, kind: job.kind, name: job.name, role: "job" }, { label: "Earlier download", jobOnly: true });
  cards.set(job.url, c);
  jobsEl.appendChild(c.el);
}

// Live job progress from the service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "job:update" && msg.job) applyJob(msg.job);
});

async function init() {
  const verEl = document.getElementById("ver");
  if (verEl) verEl.textContent = "v" + chrome.runtime.getManifest().version;

  // Persisted preferences (quality + save folder + ask-where).
  let stored = {};
  try {
    stored = await chrome.storage.local.get(["quality", "folder", "ask", "folderEditedAt", "lastFolder"]);
  } catch {}
  if (stored.quality) selectedQuality = stored.quality;
  if (typeof stored.folder === "string") saveFolder = stored.folder;
  if (typeof stored.ask === "boolean") askWhere = stored.ask;
  // Reuse the folder of the latest save (e.g. one picked in the Save As dialog)
  // unless you've typed a folder since then.
  const lf = stored.lastFolder;
  if (lf && typeof lf.folder === "string" && lf.at > (stored.folderEditedAt || 0) && lf.folder !== saveFolder) {
    saveFolder = lf.folder;
    chrome.storage.local.set({ folder: saveFolder });
  }

  const qSel = document.getElementById("quality");
  if (qSel) {
    qSel.value = selectedQuality;
    qSel.addEventListener("change", () => {
      selectedQuality = qSel.value;
      chrome.storage.local.set({ quality: selectedQuality });
    });
  }

  const fInput = document.getElementById("folder");
  if (fInput) {
    fInput.value = saveFolder;
    fInput.addEventListener("input", () => {
      saveFolder = fInput.value;
      chrome.storage.local.set({ folder: saveFolder, folderEditedAt: Date.now() });
    });
  }

  const askBox = document.getElementById("ask");
  const folderRow = document.getElementById("folderRow");
  const applyAsk = () => {
    if (folderRow) folderRow.style.display = askWhere ? "none" : "";
  };
  if (askBox) {
    askBox.checked = askWhere;
    applyAsk();
    askBox.addEventListener("change", () => {
      askWhere = askBox.checked;
      chrome.storage.local.set({ ask: askWhere });
      applyAsk();
    });
  }

  const tab = await getActiveTab();
  activeTabId = tab?.id ?? null;
  pageUrl = tab?.url || "";
  // The tab title is the lesson title on Skool (e.g. "M4: Structure Overview").
  const title = cleanTitle((tab?.title || "video").replace(/\s*[-|·]\s*Skool.*$/i, ""));
  const [res, lesson] = await Promise.all([send({ type: "popup:list", tabId: activeTabId }), getLesson()]);
  // Prefix the lesson number from the sidebar: "03 - Title".
  const n = lesson?.number;
  baseName = n ? String(n).padStart(2, "0") + " - " + title : title;
  render(res);
  for (const job of res?.jobs || []) applyJob(job);
}

init();
