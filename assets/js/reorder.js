import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "./shared.js";

// pdf.js setup — local worker, CVE mitigation, local cmaps + standard fonts
// (all vendored since the sync step).
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.js", import.meta.url).href;
const PDF_OPTS = {
  isEvalSupported: false,           // mitigates the pdf.js v3 font-matrix CVE; CSP also blocks it
  cMapUrl: new URL("../vendor/cmaps/", import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL("../vendor/standard_fonts/", import.meta.url).href,
};

const THUMB_W = 124;                // px — small on purpose (memory rule, blueprint §6)

let file = null;
let originalBuf = null;             // kept intact for the rebuild worker
let pdfDoc = null;                  // pdf.js handle — destroyed after thumbnails
let pageCount = 0;
let busy = false;
let lastResult = null;
let originalCards = [];
let sortable = null;
let worker = null;

let phase = "render";               // "render" | "rebuild"
let pageTotal = 0, pageCurrent = 0;
let startedAt = 0, ticker = null;

const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

const zone = document.querySelector("[data-upload]");
const controls = document.getElementById("tool-controls");
const summary = document.getElementById("file-summary");
const thumbWrap = document.getElementById("thumb-wrap");
const grid = document.getElementById("thumb-grid");
const applyBtn = document.getElementById("apply-btn");
const resetBtn = document.getElementById("reset-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.querySelector(".progress-bar");
const progressStatus = document.getElementById("progress-status");
const dlCard = document.getElementById("dl-card");
const status = document.getElementById("status");

function renderProgress() {
  const verb = phase === "render" ? "Rendering preview" : "Rebuilding";
  progressStatus.textContent = `${verb} — page ${pageCurrent || 1} of ${pageTotal || "?"} · ${elapsed()} s`;
  if (pageTotal > 0) {
    progressBar.style.width = `${Math.min(100, (pageCurrent / pageTotal) * 100)}%`;
  }
}

function startProgress(ph) {
  phase = ph;
  pageCurrent = 0;
  progressWrap.hidden = false;
  progressBar.style.width = "0%";
  startedAt = performance.now();
  renderProgress();
  ticker = setInterval(renderProgress, 100);
}

function stopProgress() {
  clearInterval(ticker);
  progressWrap.hidden = true;
}

function fail(msg) {
  stopProgress();
  busy = false;
  status.textContent = `Reorder failed: ${msg}`;
}

// ---------- thumbnail cards ----------
function makeCard(pageNo, canvas) {
  const card = document.createElement("div");
  card.className = "thumb-card";
  card.dataset.page = pageNo;

  const badge = document.createElement("span");
  badge.className = "thumb-badge";
  badge.textContent = pageNo;

  const ctl = document.createElement("div");
  ctl.className = "thumb-controls";
  const up = mkBtn("↑", `Move page ${pageNo} earlier`, () => moveCard(card, -1));
  const down = mkBtn("↓", `Move page ${pageNo} later`, () => moveCard(card, +1));
  ctl.append(up, down);

  card.append(canvas, badge, ctl);
  return card;
}

function mkBtn(text, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  return b;
}

function moveCard(card, dir) {
  const sib = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
  if (!sib) return;
  if (dir < 0) grid.insertBefore(card, sib);
  else grid.insertBefore(sib, card);
  const btn = card.querySelector(dir < 0 ? ".thumb-controls button:first-child"
                                         : ".thumb-controls button:last-child");
  btn?.focus();
  syncButtons();
}

function syncButtons() {
  const cards = [...grid.children];
  cards.forEach((c, i) => {
    c.querySelector(".thumb-controls button:first-child").disabled = i === 0;
    c.querySelector(".thumb-controls button:last-child").disabled = i === cards.length - 1;
  });
  const current = cards.map((c) => Number(c.dataset.page));
  const original = current.every((p, i) => p === i + 1);
  applyBtn.disabled = busy || cards.length < 2 || original;
  applyBtn.textContent = original ? "Apply new order" : "Apply new order ✓";
  resetBtn.hidden = original;
}

// ---------- upload + thumbnails ----------
initUpload(zone, async (picked) => {
  const f = picked[picked.length - 1];
  if (!f || busy) return;
  if (!f.name.toLowerCase().endsWith(".pdf")) {
    status.textContent = "That's not a PDF.";
    return;
  }

  file = f;
  lastResult = null;
  dlCard.hidden = true;
  grid.textContent = "";
  thumbWrap.hidden = true;
  controls.hidden = true;
  busy = true;
  status.textContent = "";

  try {
    originalBuf = await f.arrayBuffer();
    const pdfBuf = originalBuf.slice(0);   // pdf.js may detach its copy — keep ours intact

    startProgress("render");
    pdfDoc = await pdfjsLib.getDocument({ data: pdfBuf, ...PDF_OPTS }).promise;
    pageCount = pdfDoc.numPages;
    pageTotal = pageCount;
    summary.textContent = `${file.name} — ${formatBytes(file.size)} · ${pageCount} pages`;
    controls.hidden = false;

    for (let i = 1; i <= pageCount; i++) {
      const page = await pdfDoc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: THUMB_W / base.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;

      grid.append(makeCard(i, canvas));
      pageCurrent = i;
      renderProgress();
      if (i % 6 === 0) await new Promise((r) => setTimeout(r, 0));   // keep UI alive
    }

    await pdfDoc.destroy();               // memory hygiene — pdf.js is done here
    pdfDoc = null;

    originalCards = [...grid.children];
    if (!sortable) {
      sortable = new Sortable(grid, {
        animation: 150,
        ghostClass: "drag-ghost",
        chosenClass: "drag-chosen",
        onEnd: syncButtons,
      });
    }
    thumbWrap.hidden = false;
    stopProgress();
    syncButtons();
    status.textContent = pageCount < 2
      ? "This PDF has one page — nothing to reorder."
      : "";
    busy = false;
  } catch (err) {
    busy = false;
    stopProgress();
    const enc = err?.name === "EncryptedPDFError" || /encrypt/i.test(String(err?.message || err));
    status.textContent = enc ? "This PDF is password-protected — unlock it first."
                             : `Couldn't read the PDF: ${err?.message || err}`;
  }
});

resetBtn.addEventListener("click", () => {
  originalCards.forEach((c) => grid.append(c));
  syncButtons();
});

// ---------- apply ----------
applyBtn.addEventListener("click", async () => {
  if (busy || !originalBuf) return;
  const order = [...grid.children].map((c) => Number(c.dataset.page));

  busy = true;
  applyBtn.disabled = true;
  dlCard.hidden = true;
  status.textContent = "";
  startProgress("rebuild");

  const buf = originalBuf.slice(0);
  getWorker().postMessage({ type: "run", id: 1, data: buf, order }, [buf]);
});

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./workers/reorder-worker.js", import.meta.url).href);
  worker.onmessage = (e) => handle(e.data);
  worker.onerror = (e) => {
    worker = null;
    fail(`Worker error: ${e.message || "see console"}`);
  };
  return worker;
}

async function handle(msg) {
  if (msg.type === "start") { pageTotal = msg.total; pageCurrent = 0; renderProgress(); return; }
  if (msg.type === "progress") { pageCurrent = msg.page; renderProgress(); return; }
  if (msg.type === "error") { fail(msg.message); return; }

  if (msg.type !== "done") return;
  const t = elapsed();
  stopProgress();
  busy = false;

  const base = file.name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "document";
  const name = `${base}_reordered.pdf`;
  lastResult = { blob: new Blob([msg.data], { type: "application/pdf" }), name };

  dlCard.innerHTML = `
    <p class="result-line">${name} · ${formatBytes(msg.size)} · ${t} s</p>
    <div class="dl-row"><button class="btn" id="dl-main">Download</button></div>`;
  dlCard.hidden = false;
  status.textContent = `Reordered ${pageCount} pages · ${formatBytes(msg.size)} · ${t} s`;

  document.getElementById("dl-main").addEventListener("click", () => {
    if (lastResult) downloadBlob(lastResult.blob, lastResult.name);
  });

  await logHistoryEntry({
    tool: "reorder", filename: file.name,
    inSize: file.size, outSize: msg.size, note: "pages reordered",
  });
}