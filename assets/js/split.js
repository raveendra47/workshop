import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "/assets/js/shared.js";

let file = null;
let pageCount = 0;
let busy = false;
let lastResult = null;   // { blob, name } — ZIP or single PDF
let lastFiles = [];      // individual { blob, name } when few
let worker = null;

let pageTotal = 0;
let pageCurrent = 0;
let startedAt = 0;
let ticker = null;

const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

const zone = document.querySelector("[data-upload]");
const controls = document.getElementById("split-controls");
const summary = document.getElementById("file-summary");
const nWrap = document.getElementById("n-wrap");
const nInput = document.getElementById("n-input");
const customWrap = document.getElementById("custom-wrap");
const rangesInput = document.getElementById("ranges");
const btn = document.getElementById("split-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.querySelector(".progress-bar");
const progressStatus = document.getElementById("progress-status");
const dlCard = document.getElementById("dl-card");
const status = document.getElementById("status");

const sanitizeBase = (name) =>
  name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "split";

function parseCustom(input, max) {
  const s = input.trim();
  if (!s) throw new Error("Enter ranges like 1-3, 5, 8-10 (or switch mode)");
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
    throw new Error(`Can't read “${t}” — use pages or ranges like 1-3, 5, 8-10`);
  }
  if (!out.length) throw new Error("No pages given");
  return out;
}

// Turns the selected mode into (pageLists, names) — the only mode-specific logic.
function buildPlan() {
  const mode = document.querySelector("input[name=mode]:checked").value;
  const base = sanitizeBase(file.name);
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  const filePages = [], fileNames = [];
  const span = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  if (mode === "page") {
    pages.forEach((p) => { filePages.push([p]); fileNames.push(`${base}_${p}.pdf`); });
  } else if (mode === "n") {
    const n = Math.floor(Number(nInput.value));
    if (!Number.isFinite(n) || n < 1) throw new Error("Enter a valid page count (1 or more)");
    for (let p = 1; p <= pageCount; p += n) {
      const b = Math.min(p + n - 1, pageCount);
      filePages.push(span(p, b));
      fileNames.push(`${base}_${p}-${b}.pdf`);
    }
  } else if (mode === "custom") {
    const used = new Set();
    for (const [a, b] of parseCustom(rangesInput.value, pageCount)) {
      filePages.push(span(a, b));
      const stem = `${base}_${a}${b > a ? "-" + b : ""}`;
      let name = `${stem}.pdf`, k = 2;
      while (used.has(name)) name = `${stem}_${k++}.pdf`;
      used.add(name);
      fileNames.push(name);
    }
  } else if (mode === "odd") {
    const odd = pages.filter((p) => p % 2 === 1);
    filePages.push(odd);
    fileNames.push(`${base}_odd.pdf`);
  } else {
    const even = pages.filter((p) => p % 2 === 0);
    if (!even.length) throw new Error("This PDF has no even pages.");
    filePages.push(even);
    fileNames.push(`${base}_even.pdf`);
  }
  return { filePages, fileNames };
}

// Single writer, same format family as compress/merge.
function renderProgress() {
  progressStatus.textContent = `Splitting — page ${pageCurrent || 1} of ${pageTotal || "?"} · ${elapsed()} s`;
  if (pageTotal > 0) {
    progressBar.style.width = `${Math.min(100, (pageCurrent / pageTotal) * 100)}%`;
  }
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker("/assets/js/workers/split-worker.js");
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
  btn.disabled = !file;
  status.textContent = `Split failed: ${msg}`;
}

function showResult(msg, t) {
  const count = msg.count;
  const inOut = `${formatBytes(file.size)} → ${formatBytes(msg.size)}`;

  if (count === 1) {
    const f = msg.files[0];
    lastResult = { blob: new Blob([f.bytes], { type: "application/pdf" }), name: f.name };
    lastFiles = [];
    dlCard.innerHTML = `
      <p class="result-line">${f.name} · ${formatBytes(msg.size)} · ${t} s</p>
      <div class="dl-row"><button class="btn" id="dl-main">Download</button></div>`;
  } else {
    lastResult = { blob: new Blob([msg.zip], { type: "application/zip" }),
                   name: `${sanitizeBase(file.name)}_split.zip` };
    lastFiles = (msg.files || []).map((f) => ({
      blob: new Blob([f.bytes], { type: "application/pdf" }), name: f.name,
    }));
    dlCard.innerHTML = `
      <p class="result-line">${inOut} · ${t} s</p>
      <div class="dl-row">
        <button class="btn" id="dl-main">Download ZIP · ${count} files</button>
        ${lastFiles.map((f, i) =>
          `<button class="btn btn-secondary dl-one" data-i="${i}">${f.name}</button>`).join("")}
      </div>`;
  }
  dlCard.hidden = false;
  status.textContent = `Split into ${count} ${count > 1 ? "files" : "file"} · ${inOut} · ${t} s`;

  document.getElementById("dl-main").addEventListener("click", () => {
    if (lastResult) downloadBlob(lastResult.blob, lastResult.name);
  });
  dlCard.querySelectorAll(".dl-one").forEach((b) => {
    b.addEventListener("click", () => {
      const f = lastFiles[Number(b.dataset.i)];
      if (f) downloadBlob(f.blob, f.name);
    });
  });
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
  lastFiles = [];
  busy = true;
  btn.disabled = true;
  controls.hidden = true;
  dlCard.hidden = true;
  status.textContent = "Reading page count…";

  file.arrayBuffer().then((buf) => {
    getWorker().postMessage({ type: "probe", data: buf });
  });
});

document.querySelectorAll("input[name=mode]").forEach((r) => {
  r.addEventListener("change", () => {
    const mode = document.querySelector("input[name=mode]:checked").value;
    nWrap.hidden = mode !== "n";
    customWrap.hidden = mode !== "custom";
    status.textContent = "";
  });
});

btn.addEventListener("click", async () => {
  if (busy || !file) return;
  let plan;
  try {
    plan = buildPlan();
  } catch (err) {
    status.textContent = err.message;
    return;
  }

  busy = true;
  btn.disabled = true;
  dlCard.hidden = true;
  status.textContent = "";
  pageTotal = plan.filePages.reduce((s, p) => s + p.length, 0);
  pageCurrent = 0;
  progressBar.classList.remove("determinate");
  startedAt = performance.now();
  progressWrap.hidden = false;
  renderProgress();
  ticker = setInterval(renderProgress, 100);

  const buf = await file.arrayBuffer();
  getWorker().postMessage({
    type: "run", id: 1, data: buf,
    filePages: plan.filePages,
    fileNames: plan.fileNames,
    wantFiles: plan.filePages.length > 1 && plan.filePages.length <= 6,
  });
});

[nInput, rangesInput].forEach((el) => {
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") btn.click(); });
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
  showResult(msg, t);

  await logHistoryEntry({
    tool: "split",
    filename: file.name,
    inSize: file.size,
    outSize: msg.size,
    note: msg.count === 1 ? msg.files[0].name : `${msg.count} files`,
  });
}