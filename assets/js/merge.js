import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "/assets/js/shared.js";

const files = [];
const seen = new Set();
let lastResult = null;   // { blob, name } — held for manual (re-)download

const zone = document.querySelector("[data-upload]");
const list = document.getElementById("file-list");
const btn = document.getElementById("merge-btn");
const status = document.getElementById("status");
const dlCard = document.getElementById("dl-card");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.querySelector(".progress-bar");
const progressStatus = document.getElementById("progress-status");

let merging = false;
let pageTotal = 0;
let pageCurrent = 0;
let startedAt = 0;
let ticker = null;

const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

// Single writer, compress-style format.
function renderProgress() {
  progressStatus.textContent = `Merging — page ${pageCurrent || 1} of ${pageTotal || "?"} · ${elapsed()} s`;
  if (pageTotal > 0) {
    progressBar.style.width = `${Math.min(100, (pageCurrent / pageTotal) * 100)}%`;
  }
}

// Output name: first file in the list (user-controlled order) + _merged.
function outName() {
  const base = (files[0]?.name || "merged").replace(/\.pdf$/i, "");
  const clean = base.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80);
  return `${clean || "merged"}_merged.pdf`;
}

initUpload(zone, (picked) => {
  for (const f of picked) {
    if (f.name.toLowerCase().endsWith(".pdf")) files.push(f);
    else status.textContent = `Skipped ${f.name} — not a PDF.`;
  }
  lastResult = null;
  dlCard.hidden = true;
  render();
});

function mkBtn(text, title, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", title);
  if (cls) b.classList.add(cls);
  b.addEventListener("click", onClick);
  return b;
}

function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= files.length) return;
  [files[i], files[j]] = [files[j], files[i]];
  render();
  list.children[i]?.classList.add("settle");
  list.children[j]?.classList.add("settle");
}

function render() {
  list.textContent = "";
  files.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "file-row";
    const key = `${f.name}|${f.size}|${f.lastModified}`;
    if (!seen.has(key)) { row.classList.add("row-enter"); seen.add(key); }
    row.style.setProperty("--i", Math.min(i, 8));

    const label = document.createElement("span");
    label.textContent = `${i + 1}. ${f.name} — ${formatBytes(f.size)}`;

    const controls = document.createElement("span");
    controls.className = "row-controls";
    const up = mkBtn("↑", "Move up", null, () => move(i, -1));
    const down = mkBtn("↓", "Move down", null, () => move(i, +1));
    const rm = mkBtn("✕", "Remove", "row-remove", () => {
      row.classList.add("leaving");
      setTimeout(() => { files.splice(files.indexOf(f), 1); render(); }, 170);
    });
    up.disabled = i === 0;
    down.disabled = i === files.length - 1;
    controls.append(up, down, rm);

    row.append(label, controls);
    list.append(row);
  });
  btn.disabled = files.length < 2;
}

function finish() {
  clearInterval(ticker);
  progressWrap.hidden = true;
  merging = false;
  btn.disabled = files.length < 2;
}

btn.addEventListener("click", async () => {
  if (merging || files.length < 2) return;
  merging = true;
  btn.disabled = true;
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

  const inSize = files.reduce((s, f) => s + f.size, 0);
  const worker = new Worker("/assets/js/workers/merge-worker.js");
  worker.onmessage = (e) => handle(worker, e.data, inSize);
  worker.onerror = (e) => {
    finish();
    status.textContent = `Merge failed: ${e.message || "worker error (see console)"}`;
    worker.terminate();
  };

  const buffers = await Promise.all(files.map((f) => f.arrayBuffer()));
  worker.postMessage(
    { type: "run", id: 1, buffers, names: files.map((f) => f.name) },
    buffers, // zero-copy transfer
  );
});

async function handle(worker, msg, inSize) {
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

  if (msg.type === "error") {
    finish();
    status.textContent = `Merge failed: ${msg.message}`;
    worker.terminate();
    return;
  }

  if (msg.type !== "done") return;
  const t = elapsed();
  worker.terminate();
  finish();

  const name = outName();
  lastResult = { blob: new Blob([msg.data], { type: "application/pdf" }), name };

  document.getElementById("dl-line").textContent = `${name} · ${formatBytes(msg.size)}`;
  dlCard.hidden = false;
  status.textContent = `Merged ${files.length} files · ${msg.pages} pages · ${formatBytes(msg.size)} · ${t} s`;

  await logHistoryEntry({
    tool: "merge",
    filename: files.map((f) => f.name).join(", "),
    inSize,
    outSize: msg.size,
    note: name,
  });
}