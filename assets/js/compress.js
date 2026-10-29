import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "./shared.js";

// Size contract from the Phase 0 spike (~3.5x memory multiplier; browser heap
// is tighter than Node). Tune after the browser-tab memory test.
const SOFT_LIMIT = 80 * 1024 * 1024;
const HARD_LIMIT = 200 * 1024 * 1024;
const PRESET_LABEL = { screen: "Small", ebook: "Balanced", printer: "High quality" };

let file = null;
let running = false;
let startedAt = 0;
let ticker = null;
let pageTotal = 0;
let pageCurrent = 0;
let lastResult = null;   // { blob, name } — held for manual (re-)download

// Persistent engine — created once, warm for every run (snackpdf pattern).
let worker = null;
let engineReady = false;
let currentPreset = "ebook";

const progressBar = document.querySelector(".progress-bar");
const zone = document.querySelector("[data-upload]");
const controls = document.getElementById("compress-controls");
const summary = document.getElementById("file-summary");
const btn = document.getElementById("compress-btn");
const sizeNote = document.getElementById("size-note");
const progressWrap = document.getElementById("progress-wrap");
const progressStatus = document.getElementById("progress-status");
const resultCard = document.getElementById("result-card");
const status = document.getElementById("status");

const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

// Single writer, single format — now phase-aware: engine load vs actual compression.
function renderProgress() {
  const phase = engineReady ? "Compressing" : "Loading engine";
  progressStatus.textContent = `${phase} — page ${pageCurrent || 1} of ${pageTotal || "?"} · ${elapsed()} s`;
}

initUpload(zone, (picked) => {
  const f = picked[picked.length - 1];
  if (!f || !f.name.toLowerCase().endsWith(".pdf")) {
    if (f) status.textContent = "That's not a PDF.";
    return;
  }
  file = f;
  lastResult = null;
  status.textContent = "";
  resultCard.hidden = true;
  controls.hidden = false;
  summary.textContent = `${file.name} — ${formatBytes(file.size)}`;
  if (file.size > HARD_LIMIT) {
    btn.disabled = true;
    sizeNote.textContent = `Too large for this build (≈ ${formatBytes(HARD_LIMIT)} limit) — the browser would run out of memory.`;
  } else if (file.size > SOFT_LIMIT) {
    btn.disabled = false;
    sizeNote.textContent = `${formatBytes(file.size)} is large — expect a long run and heavy memory use.`;
  } else {
    btn.disabled = false;
    sizeNote.textContent = "";
  }
});

btn.addEventListener("click", () => {
  if (!file || running) return;
  currentPreset = document.querySelector("input[name=preset]:checked").value;

  running = true;
  btn.disabled = true;
  controls.hidden = true;
  resultCard.hidden = true;
  progressWrap.hidden = false;
  pageTotal = 0;
  pageCurrent = 0;
  progressBar.classList.remove("determinate");
  progressBar.style.width = "";
  startedAt = performance.now();
  renderProgress();
  ticker = setInterval(renderProgress, 100);

  const w = getWorker();
  file.arrayBuffer().then((buf) => {
    w.postMessage({ type: "run", id: Date.now(), data: buf, preset: currentPreset }, [buf]); // zero-copy transfer
  });
});

// ---------------------------------------------------------------------------
// Engine lifecycle: one worker for the whole session. Only a crash tears it down.
// ---------------------------------------------------------------------------
function getWorker() {
  if (worker) return worker;
  engineReady = false;
  worker = new Worker(new URL("./workers/ghostscript-worker.js", import.meta.url).href, { type: "module" });
  worker.onmessage = (e) => handle(e.data);
  worker.onerror = (e) => {
    finish();
    status.textContent = `Compression failed: ${e.message || "worker error (see console)"}`;
    worker.terminate();
    worker = null; // clean re-create on next attempt
  };
  worker.postMessage({ type: "boot" }); // engine starts loading immediately
  return worker;
}

function finish() {
  clearInterval(ticker);
  progressWrap.hidden = true;
  running = false;
  btn.disabled = false;
  controls.hidden = false;
}

async function handle(msg) {
  if (msg.type === "engine-ready") {
    engineReady = true;
    if (running) { startedAt = performance.now(); renderProgress(); } // restart clock: compression phase begins
    return;
  }

  if (msg.type === "log") {
    if (!engineReady) { // fallback if engine-ready was missed
      engineReady = true;
      if (running) startedAt = performance.now();
    }
    console.log("[gs]", msg.line);
    let m = msg.line.match(/Processing pages 1 through (\d+)/i);
    if (m) {
      pageTotal = Number(m[1]);
      progressBar.classList.add("determinate");
    }
    m = msg.line.match(/\bPage (\d+)\b/i);
    if (m) {
      pageCurrent = Number(m[1]);
      progressBar.classList.add("determinate");
      if (pageTotal > 0) {
        progressBar.style.width = `${Math.min(100, (pageCurrent / pageTotal) * 100)}%`;
      }
    }
    return;
  }

  if (msg.type === "error") {
    finish();
    status.textContent = `Compression failed: ${msg.message}`;
    return; // worker self-heals internally (engine reboots on next run)
  }

  if (msg.type !== "done") return;
  const t = elapsed();
  // NOTE: no worker.terminate() here — the warm engine is reused for the next run.

  if (msg.size >= file.size) {
    finish();
    status.textContent = `No gain at "${PRESET_LABEL[currentPreset]}" (${formatBytes(file.size)} → ${formatBytes(msg.size)}). The original is kept — try "Small".`;
    await logHistoryEntry({
      tool: "compress", filename: file.name,
      inSize: file.size, outSize: msg.size,
      note: `${currentPreset}: no reduction, original kept`,
    });
    return;
  }

  const saved = Math.round((1 - msg.size / file.size) * 100);
  lastResult = {
    blob: new Blob([msg.data], { type: "application/pdf" }),
    name: outName(),
  };
  finish();
  resultCard.hidden = false;
  resultCard.innerHTML = `
    <p class="result-big">−${saved}%</p>
    <p class="result-line">${formatBytes(file.size)} → ${formatBytes(msg.size)} in ${t} s · ${PRESET_LABEL[currentPreset]} quality</p>
    <button class="btn" id="dl-btn">Download ${lastResult.name}</button>
    <button class="btn btn-secondary" id="again-btn">Compress another</button>`;
  status.textContent = "";
  document.getElementById("dl-btn").addEventListener("click", () => {
    downloadBlob(lastResult.blob, lastResult.name);
  });
  document.getElementById("again-btn").addEventListener("click", reset);

  await logHistoryEntry({
    tool: "compress", filename: file.name,
    inSize: file.size, outSize: msg.size, note: currentPreset,
  });
}

function outName() {
  const base = file.name.replace(/\.pdf$/i, "");
  return `${base}_compressed.pdf`;
}

function reset() {
  lastResult = null;
  resultCard.hidden = true;
  controls.hidden = true;
  summary.textContent = "";
  sizeNote.textContent = "";
  file = null;
  status.textContent = "";
  zone.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Optional: warm the engine while the user is still picking a file.
// Delete these 2 lines if you'd rather not fetch the wasm until first use.
if ("requestIdleCallback" in window) requestIdleCallback(() => getWorker());
else setTimeout(() => getWorker(), 1500);