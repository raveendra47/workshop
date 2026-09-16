import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "/assets/js/shared.js";

let file = null;
let busy = false;
let lastResult = null;
let pageTotal = 0;
let pageCurrent = 0;
let startedAt = 0;
let ticker = null;

const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

const zone = document.querySelector("[data-upload]");
const controls = document.getElementById("tool-controls");
const summary = document.getElementById("file-summary");
const shrinkEl = document.getElementById("shrink");
const btn = document.getElementById("run-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.querySelector(".progress-bar");
const progressStatus = document.getElementById("progress-status");
const dlCard = document.getElementById("dl-card");
const status = document.getElementById("status");

function renderProgress() {
  progressStatus.textContent = `Converting — page ${pageCurrent || 1} of ${pageTotal || "?"} · ${elapsed()} s`;
  if (pageTotal > 0) {
    progressBar.style.width = `${Math.min(100, (pageCurrent / pageTotal) * 100)}%`;
  }
}

function fail(msg) {
  clearInterval(ticker);
  progressWrap.hidden = true;
  busy = false;
  btn.disabled = false;
  status.textContent = `Conversion failed: ${msg}`;
}

initUpload(zone, (picked) => {
  const f = picked[picked.length - 1];
  if (!f || !f.name.toLowerCase().endsWith(".pdf")) {
    if (f) status.textContent = "That's not a PDF.";
    return;
  }
  file = f;
  lastResult = null;
  busy = false;
  btn.disabled = false;
  controls.hidden = false;
  dlCard.hidden = true;
  summary.textContent = `${file.name} — ${formatBytes(file.size)}`;
  if (file.size > 80 * 1024 * 1024) {
    status.textContent = `${formatBytes(file.size)} is large — this will take a while and use a lot of memory.`;
  }
});

btn.addEventListener("click", () => {
  if (busy || !file) return;
  busy = true;
  btn.disabled = true;
  controls.hidden = true;
  dlCard.hidden = true;
  status.textContent = "";
  pageTotal = 0;
  pageCurrent = 0;
  progressBar.classList.remove("determinate");
  progressBar.style.width = "";
  startedAt = performance.now();
  progressWrap.hidden = false;
  renderProgress();
  ticker = setInterval(renderProgress, 100);

  const worker = new Worker("/assets/js/workers/grayscale-worker.js", { type: "module" });
  worker.onmessage = (e) => handle(worker, e.data);
  worker.onerror = (e) => {
    fail(e.message || "worker error (see console)");
    worker.terminate();
  };

  file.arrayBuffer().then((buf) => {
    const payload = {
    type: "run", id: 1, data: buf,
    preset: shrinkEl.checked ? "ebook" : null,
    };
    worker.postMessage(payload, [buf]);
  });
});

async function handle(worker, msg) {
  if (msg.type === "log") {
    console.log("[gs]", msg.line);
    let m = msg.line.match(/Processing pages 1 through (\d+)/i);
    if (m) { pageTotal = Number(m[1]); progressBar.classList.add("determinate"); }
    m = msg.line.match(/\bPage (\d+)\b/i);
    if (m) {
      pageCurrent = Number(m[1]);
      if (pageTotal > 0) progressBar.style.width = `${Math.min(100, (pageCurrent / pageTotal) * 100)}%`;
    }
    return;
  }
  if (msg.type === "error") { fail(msg.message); worker.terminate(); return; }

  if (msg.type !== "done") return;
  const t = elapsed();
  worker.terminate();

  if (msg.size >= file.size) {
    clearInterval(ticker);
    progressWrap.hidden = true;
    busy = false;
    btn.disabled = false;
    controls.hidden = false;
    status.textContent = `Converted, but no smaller (${formatBytes(file.size)} → ${formatBytes(msg.size)}). The file is grayscale now — download it below if that's what you wanted.`;
    // Even "no gain" output is valid here: the goal was color change, not size.
    lastResult = { blob: new Blob([msg.data], { type: "application/pdf" }), name: outName() };
    dlCard.innerHTML = `
      <p class="result-line">${outName()} · ${formatBytes(msg.size)} · ${t} s</p>
      <div class="dl-row"><button class="btn" id="dl-main">Download</button></div>`;
    dlCard.hidden = false;
    document.getElementById("dl-main").addEventListener("click", () =>
      lastResult && downloadBlob(lastResult.blob, lastResult.name));
    return;
  }

  const saved = Math.round((1 - msg.size / file.size) * 100);
  lastResult = { blob: new Blob([msg.data], { type: "application/pdf" }), name: outName() };
  clearInterval(ticker);
  progressWrap.hidden = true;
  busy = false;
  btn.disabled = false;
  controls.hidden = false;
  dlCard.innerHTML = `
    <p class="result-big">−${saved}%</p>
    <p class="result-line">${formatBytes(file.size)} → ${formatBytes(msg.size)} in ${t} s</p>
    <div class="dl-row"><button class="btn" id="dl-main">Download</button></div>`;
  dlCard.hidden = false;
  document.getElementById("dl-main").addEventListener("click", () =>
    lastResult && downloadBlob(lastResult.blob, lastResult.name));

  await logHistoryEntry({
    tool: "grayscale", filename: file.name,
    inSize: file.size, outSize: msg.size,
    note: shrinkEl.checked ? "gray + shrink" : "gray",
  });
}

function outName() {
  const base = file.name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "document";
  return `${base}_grayscale.pdf`;
}