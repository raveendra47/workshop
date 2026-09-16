import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "/assets/js/shared.js";

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

// Single writer, single format.
function renderProgress() {
  progressStatus.textContent = `Compressing — page ${pageCurrent || 1} of ${pageTotal || "?"} · ${elapsed()} s`;
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
  const preset = document.querySelector("input[name=preset]:checked").value;

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

  const worker = new Worker("/assets/js/workers/ghostscript-worker.js", { type: "module" });
  worker.onmessage = (e) => handle(worker, e.data, preset);
  worker.onerror = (e) => {
    finish();
    status.textContent = `Compression failed: ${e.message || "worker error (see console)"}`;
    worker.terminate();
  };

  file.arrayBuffer().then((buf) => {
    worker.postMessage({ type: "run", id: 1, data: buf, preset }, [buf]); // zero-copy transfer
  });
});

function finish() {
  clearInterval(ticker);
  progressWrap.hidden = true;
  running = false;
  btn.disabled = false;
  controls.hidden = false;
}

async function handle(worker, msg, preset) {
  if (msg.type === "log") {
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
    worker.terminate();
    return;
  }

  if (msg.type !== "done") return;
  const t = elapsed();
  worker.terminate();

  if (msg.size >= file.size) {
    finish();
    status.textContent = `No gain at “${PRESET_LABEL[preset]}” (${formatBytes(file.size)} → ${formatBytes(msg.size)}). The original is kept — try “Small”.`;
    await logHistoryEntry({
      tool: "compress", filename: file.name,
      inSize: file.size, outSize: msg.size,
      note: `${preset}: no reduction, original kept`,
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
    <p class="result-line">${formatBytes(file.size)} → ${formatBytes(msg.size)} in ${t} s · ${PRESET_LABEL[preset]} quality</p>
    <button class="btn" id="dl-btn">Download ${lastResult.name}</button>
    <button class="btn btn-secondary" id="again-btn">Compress another</button>`;
  status.textContent = "";
  document.getElementById("dl-btn").addEventListener("click", () => {
    downloadBlob(lastResult.blob, lastResult.name);
  });
  document.getElementById("again-btn").addEventListener("click", reset);

  await logHistoryEntry({
    tool: "compress", filename: file.name,
    inSize: file.size, outSize: msg.size, note: preset,
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