import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "/assets/js/shared.js";

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
const allWrap = document.getElementById("all-wrap");
const customWrap = document.getElementById("custom-wrap");
const planInput = document.getElementById("plan");
const btn = document.getElementById("run-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.querySelector(".progress-bar");
const progressStatus = document.getElementById("progress-status");
const dlCard = document.getElementById("dl-card");
const status = document.getElementById("status");

const sanitizeBase = (name) =>
  name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "rotated";

// Custom grammar: page[-page][:angle]. An item's angle, in priority order:
//   1. explicit  (5:180)
//   2. sticky    (angle from an earlier item — "1-3:90, 7" gives 7 the 90)
//   3. pill default (the "Turn clockwise by" selector)
function buildDeltas() {
  const mode = document.querySelector("input[name=mode]:checked").value;
  const deltas = new Array(pageCount).fill(0);

  if (mode === "all") {
    const a = Number(document.querySelector("input[name=angle]:checked").value);
    deltas.fill(a);
    return { deltas, note: `all +${a}°` };
  }

  const s = planInput.value.trim();
  if (!s) throw new Error("Enter pages and angles like 1-3:90, 7, 8:180 — or leave empty to use the pill angle for every page");

  const pillAngle = Number(document.querySelector("input[name=angle]:checked").value);
  let sticky = null;
  let defaulted = 0;

  if (!s) { /* unreachable — kept for clarity */ }

  for (const part of s.split(/[,;]+/)) {
    const t = part.trim();
    if (!t) continue;

    const m = t.match(/^(\d+)(?:\s*-\s*(\d+))?(?:\s*:\s*(90|180|270|-90))?$/);
    if (!m) throw new Error(`Can't read "${t}" — use 1-3:90, 7, 8:180 (90/180/270/-90)`);

    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > pageCount) throw new Error(`Range ${a}-${b} is out of range (1–${pageCount})`);
    if (a > b) throw new Error(`Range ${a}-${b}: start is after end`);

    let angle;
    if (m[3]) {
      angle = m[3] === "-90" ? 270 : Number(m[3]);
      sticky = angle;                       // explicit angle sticks for later bare items
    } else if (sticky !== null) {
      angle = sticky;
    } else {
      angle = pillAngle;                    // fall back to the visible pills
      defaulted++;
    }
    for (let p = a; p <= b; p++) deltas[p - 1] = angle;
  }

  const changedPages = deltas.filter((d) => d !== 0).length;
  if (!changedPages) throw new Error("Nothing to rotate — every angle is 0.");
  const note = defaulted > 0
    ? `custom, ${changedPages} pages (${defaulted} via default angle)`
    : `custom, ${changedPages} pages`;
  return { deltas, note };
}

function renderProgress() {
  progressStatus.textContent = `Rotating — page ${pageCurrent || 1} of ${pageTotal || "?"} · ${elapsed()} s`;
  if (pageTotal > 0) {
    progressBar.style.width = `${Math.min(100, (pageCurrent / pageTotal) * 100)}%`;
  }
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker("/assets/js/workers/rotate-worker.js");
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
  status.textContent = `Rotate failed: ${msg}`;
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

const angleLegend = document.querySelector("#angle-wrap legend");
document.querySelectorAll("input[name=mode]").forEach((r) => {
  r.addEventListener("change", () => {
    const mode = document.querySelector("input[name=mode]:checked").value;
    customWrap.hidden = mode !== "custom";
    angleLegend.textContent = mode === "custom"
      ? "Default angle (for pages without their own)"
      : "Turn clockwise by";
    status.textContent = "";
  });
});

btn.addEventListener("click", async () => {
  if (busy || !file) return;
  let plan;
  try {
    plan = buildDeltas();
  } catch (err) {
    status.textContent = err.message;
    return;
  }

  busy = true;
  btn.disabled = true;
  dlCard.hidden = true;
  status.textContent = "";
  pageTotal = pageCount;
  pageCurrent = 0;
  progressBar.style.width = "0%";
  startedAt = performance.now();
  progressWrap.hidden = false;
  renderProgress();
  ticker = setInterval(renderProgress, 100);

  const buf = await file.arrayBuffer();
  getWorker().postMessage({ type: "run", id: 1, data: buf, deltas: plan.deltas, note: plan.note });
});

planInput.addEventListener("keydown", (e) => { if (e.key === "Enter") btn.click(); });

async function handle(msg) {
  if (msg.type === "probe") {
    pageCount = msg.pageCount;
    busy = false;
    controls.hidden = false;
    btn.disabled = false;
    summary.textContent = `${file.name} — ${formatBytes(file.size)} · ${pageCount} pages`
      + (msg.baked ? ` · ${msg.baked} pages already carry a baked-in rotation (changes apply on top)` : "");
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

  const name = `${sanitizeBase(file.name)}_rotated.pdf`;
  lastResult = { blob: new Blob([msg.data], { type: "application/pdf" }), name };
  dlCard.innerHTML = `
    <p class="result-line">${name} · ${formatBytes(msg.size)} · ${t} s</p>
    <div class="dl-row"><button class="btn" id="dl-main">Download</button></div>`;
  dlCard.hidden = false;
  status.textContent = `Rotated ${msg.changed} ${msg.changed === 1 ? "page" : "pages"} · ${formatBytes(msg.size)} · ${t} s`;

  document.getElementById("dl-main").addEventListener("click", () => {
    if (lastResult) downloadBlob(lastResult.blob, lastResult.name);
  });

  await logHistoryEntry({
    tool: "rotate", filename: file.name,
    inSize: file.size, outSize: msg.size,
    note: msg.note || "rotated",
  });
}