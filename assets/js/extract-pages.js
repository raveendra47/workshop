import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "./shared.js";

let file = null;
let pageCount = 0;
let busy = false;
let lastResult = null;
let worker = null;

let pageTotal = 0;
let pageCurrent = 0;
let startedAt = 0;
let ticker = null;

const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

const zone = document.querySelector("[data-upload]");
const controls = document.getElementById("tool-controls");
const summary = document.getElementById("file-summary");
const rangesInput = document.getElementById("ranges");
const btn = document.getElementById("run-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.querySelector(".progress-bar");
const progressStatus = document.getElementById("progress-status");
const dlCard = document.getElementById("dl-card");
const status = document.getElementById("status");

const sanitizeBase = (name) =>
  name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "pages";

function parseRanges(input, max) {
  const s = input.trim();
  if (!s) throw new Error("Enter pages or ranges like 1-3, 5, 8-10");
  const out = [];
  for (const part of s.split(/[,;]+/)) {
    const t = part.trim();
    if (!t) continue;
    let m = t.match(/^(\d+)$/);
    if (m) {
      const p = Number(m[1]);
      if (p < 1 || p > max) throw new Error(`Page ${p} is out of range (1–${max})`);
      out.push([p, p]);
      continue;
    }
    m = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (a < 1 || b > max) throw new Error(`Range ${a}-${b} is out of range (1–${max})`);
      if (a > b) throw new Error(`Range ${a}-${b}: start is after end`);
      out.push([a, b]);
      continue;
    }
    throw new Error(`Can't read "${t}" — use pages or ranges like 1-3, 5, 8-10`);
  }
  if (!out.length) throw new Error("No pages given");
  return out;
}

// Extract keeps selected pages in selection order: 5, 1-3 → 5,1,2,3.
function buildPages() {
  const flat = [];
  for (const [a, b] of parseRanges(rangesInput.value, pageCount)) {
    for (let p = a; p <= b; p++) flat.push(p);
  }
  if (flat.length === pageCount) {
    throw new Error("That's every page — you want no change. Extract a subset.");
  }
  return flat;
}

function renderProgress() {
  progressStatus.textContent = `Extracting — page ${pageCurrent || 1} of ${pageTotal || "?"} · ${elapsed()} s`;
  if (pageTotal > 0) {
    progressBar.style.width = `${Math.min(100, (pageCurrent / pageTotal) * 100)}%`;
  }
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./workers/extract-worker.js", import.meta.url).href);
  worker.onmessage = (e) => handle(e.data);
  worker.onerror = (e) => {
    worker = null;
    fail(`Worker error: ${e.message || "see console"}`);
  };
  return worker;
}

function fail(msg) {
  clearInterval(ticker);
  progressWrap.hidden = true;
  busy = false;
  btn.disabled = false;
  status.textContent = `Extract failed: ${msg}`;
}

initUpload(zone, (picked) => {
  const f = picked[picked.length - 1];
  if (!f || !f.name.toLowerCase().endsWith(".pdf")) {
    if (f) status.textContent = "That's not a PDF.";
    return;
  }
  file = f;
  pageCount = 0;
  lastResult = null;
  busy = true;
  btn.disabled = true;
  controls.hidden = true;
  dlCard.hidden = true;
  status.textContent = "Reading page count…";

  file.arrayBuffer().then((buf) => {
    getWorker().postMessage({ type: "probe", data: buf });
  });
});

btn.addEventListener("click", async () => {
  if (busy || !file) return;
  let pages;
  try {
    pages = buildPages();
  } catch (err) {
    status.textContent = err.message;
    return;
  }

  busy = true;
  btn.disabled = true;
  dlCard.hidden = true;
  status.textContent = "";
  pageTotal = pages.length;
  pageCurrent = 0;
  progressBar.style.width = "0%";
  startedAt = performance.now();
  progressWrap.hidden = false;
  renderProgress();
  ticker = setInterval(renderProgress, 100);

  const buf = await file.arrayBuffer();
  getWorker().postMessage({ type: "run", id: 1, data: buf, pages });
});

rangesInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btn.click();
});

async function handle(msg) {
  if (msg.type === "probe") {
    pageCount = msg.pageCount;
    busy = false;
    controls.hidden = false;
    btn.disabled = false;
    summary.textContent = `${file.name} — ${formatBytes(file.size)} · ${pageCount} pages`;
    status.textContent = "";
    return;
  }
  if (msg.type === "start") {
    pageTotal = msg.total;
    progressBar.classList.add("determinate");
    renderProgress();
    return;
  }
  if (msg.type === "progress") {
    pageCurrent = msg.page;
    renderProgress();
    return;
  }
  if (msg.type === "error") { fail(msg.message); return; }

  if (msg.type !== "done") return;
  const t = elapsed();
  clearInterval(ticker);
  progressWrap.hidden = true;
  busy = false;
  btn.disabled = false;

  const name = `${sanitizeBase(file.name)}_extract.pdf`;
  lastResult = { blob: new Blob([msg.data], { type: "application/pdf" }), name };
  dlCard.innerHTML = `
    <p class="result-line">${name} · ${formatBytes(msg.size)} · ${msg.count} pages · ${t} s</p>
    <div class="dl-row"><button class="btn" id="dl-main">Download</button></div>`;
  dlCard.hidden = false;
  status.textContent = `Extracted ${msg.count} pages · ${formatBytes(msg.size)} · ${t} s`;

  document.getElementById("dl-main").addEventListener("click", () => {
    if (lastResult) downloadBlob(lastResult.blob, lastResult.name);
  });

  await logHistoryEntry({
    tool: "extract", filename: file.name,
    inSize: file.size, outSize: msg.size, note: `${msg.count} pages`,
  });
}