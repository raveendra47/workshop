import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "/assets/js/shared.js";

let file = null;
let exposed = 0;
let busy = false;
let lastResult = null;
let worker = null;

let startedAt = 0;
let ticker = null;

const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

const zone = document.querySelector("[data-upload]");
const controls = document.getElementById("tool-controls");
const summary = document.getElementById("file-summary");
const metaList = document.getElementById("meta-list");
const keepTitleWrap = document.getElementById("keep-title-wrap");
const keepTitleEl = document.getElementById("keep-title");
const btn = document.getElementById("run-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressStatus = document.getElementById("progress-status");
const dlCard = document.getElementById("dl-card");
const status = document.getElementById("status");

const HUMAN = {
  title: "Title", author: "Author", subject: "Subject", keywords: "Keywords",
  creator: "Creator (originating app)", producer: "Producer (writing software)",
  creationDate: "Creation date", modDate: "Modification date",
};

function renderLeakList(meta) {
  metaList.textContent = "";
  const pretty = (k) => {
    if (k === "creationDate" || k === "modDate") {
      try { return new Date(meta[k]).toLocaleString(); } catch { return meta[k]; }
    }
    return meta[k];
  };
  let any = false;
  for (const k of Object.keys(HUMAN)) {
    if (!meta[k]) continue;
    any = true;
    const row = document.createElement("div");
    row.className = "file-row leak-row";
    const label = document.createElement("span");
    label.innerHTML = `<span class="badge external">exposed</span> ${HUMAN[k]}`;
    const val = document.createElement("span");
    val.className = "history-meta";
    val.textContent = `"${pretty(k)}"`;
    row.append(label, val);
    metaList.append(row);
  }
  if (meta.hasXMP) {
    any = true;
    const row = document.createElement("div");
    row.className = "file-row leak-row";
    const label = document.createElement("span");
    label.innerHTML = `<span class="badge external">exposed</span> XMP metadata stream`;
    const val = document.createElement("span");
    val.className = "history-meta";
    val.textContent = "richer metadata — removed with the rest";
    row.append(label, val);
    metaList.append(row);
  }
  if (!any) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "No identifying metadata found — this PDF is already clean. You can still run Sanitize to be sure.";
    metaList.append(p);
  }
  keepTitleWrap.hidden = !meta.title;
}

function renderProgress() {
  progressStatus.textContent = `Cleaning metadata · ${elapsed()} s`;
}

function fail(msg) {
  clearInterval(ticker);
  progressWrap.hidden = true;
  busy = false;
  btn.disabled = false;
  status.textContent = `Sanitize failed: ${msg}`;
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker("/assets/js/workers/sanitize-worker.js");
  worker.onmessage = (e) => handle(e.data);
  worker.onerror = (e) => {
    worker = null;
    fail(`Worker error: ${e.message || "see console"}`);
  };
  return worker;
}

initUpload(zone, (picked) => {
  const f = picked[picked.length - 1];
  if (!f || !f.name.toLowerCase().endsWith(".pdf")) {
    if (f) status.textContent = "That's not a PDF.";
    return;
  }
  file = f;
  lastResult = null;
  busy = true;
  btn.disabled = true;
  controls.hidden = true;
  dlCard.hidden = true;
  status.textContent = "Inspecting metadata…";

  file.arrayBuffer().then((buf) => {
    getWorker().postMessage({ type: "probe", data: buf });
  });
});

btn.addEventListener("click", async () => {
  if (busy || !file) return;
  busy = true;
  btn.disabled = true;
  dlCard.hidden = true;
  status.textContent = "";
  startedAt = performance.now();
  progressWrap.hidden = false;
  renderProgress();
  ticker = setInterval(renderProgress, 100);

  const buf = await file.arrayBuffer();
  getWorker().postMessage({
    type: "run", id: 1, data: buf,
    keepTitle: keepTitleEl.checked,
  });
});

async function handle(msg) {
  if (msg.type === "probe") {
    busy = false;
    controls.hidden = false;
    btn.disabled = false;
    exposed = msg.exposed;
    summary.textContent = `${file.name} — ${formatBytes(file.size)} · ${msg.pageCount} pages · ${exposed} exposed ${exposed === 1 ? "item" : "items"}`;
    renderLeakList(msg.meta);
    status.textContent = "";
    return;
  }

  if (msg.type === "error") { fail(msg.message); return; }

  if (msg.type !== "done") return;
  const t = elapsed();
  clearInterval(ticker);
  progressWrap.hidden = true;
  busy = false;
  btn.disabled = false;

  const base = file.name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "document";
  const name = `${base}_clean.pdf`;
  lastResult = { blob: new Blob([msg.data], { type: "application/pdf" }), name };

  dlCard.innerHTML = `
    <p class="result-line">${name} · ${formatBytes(msg.size)} · ${t} s</p>
    <p class="csp-sub">Proof it worked: re-upload this output — the leak list will be empty.</p>
    <div class="dl-row"><button class="btn" id="dl-main">Download</button></div>`;
  dlCard.hidden = false;
  status.textContent = `Stripped ${msg.removed} ${msg.removed === 1 ? "item" : "items"} · ${t} s`;

  document.getElementById("dl-main").addEventListener("click", () => {
    if (lastResult) downloadBlob(lastResult.blob, lastResult.name);
  });

  await logHistoryEntry({
    tool: "sanitize", filename: file.name,
    inSize: file.size, outSize: msg.size,
    note: `${msg.removed} stripped${keepTitleEl.checked ? ", title kept" : ""}`,
  });
}