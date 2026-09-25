import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "/assets/js/shared.js";

let file = null;
let busy = false;
let lastResult = null;

let startedAt = 0;
const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

const zone = document.querySelector("[data-upload]");
const controls = document.getElementById("tool-controls");
const summary = document.getElementById("file-summary");
const notesEl = document.getElementById("notes");
const btn = document.getElementById("run-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressStatus = document.getElementById("progress-status");
const dlCard = document.getElementById("dl-card");
const status = document.getElementById("status");

initUpload(zone, (picked) => {
  const f = picked[picked.length - 1];
  if (!f || !f.name.toLowerCase().endsWith(".pdf")) {
    if (f) status.textContent = "That's not a PDF.";
    return;
  }
  file = f;
  lastResult = null;
  dlCard.hidden = true;
  controls.hidden = false;
  notesEl.textContent = "";
  summary.textContent = `${file.name} — ${formatBytes(file.size)}`;
  status.textContent = "";
  btn.disabled = false;
});

function addNote(text) {
  const p = document.createElement("p");
  p.className = "csp-sub";
  p.textContent = "› " + text;
  notesEl.append(p);
}

btn.addEventListener("click", async () => {
  if (busy || !file) return;
  busy = true;
  btn.disabled = true;
  dlCard.hidden = true;
  notesEl.textContent = "";
  status.textContent = "";
  startedAt = performance.now();
  progressWrap.hidden = false;
  progressStatus.textContent = `Repairing · ${elapsed()} s`;
  const ticker = setInterval(() => {
    progressStatus.textContent = `Repairing · ${elapsed()} s`;
  }, 100);

  const buf = await file.arrayBuffer();
  const worker = new Worker("/assets/js/workers/repair-worker.js");
  worker.onmessage = async (e) => {
    const msg = e.data;
    if (msg.type === "note") { addNote(msg.text); return; }
    if (msg.type === "error") {
      clearInterval(ticker);
      progressWrap.hidden = true;
      busy = false;
      btn.disabled = false;
      status.textContent = `Repair failed: ${msg.message}`;
      return;
    }
    if (msg.type !== "done") return;
    const t = elapsed();
    clearInterval(ticker);
    progressWrap.hidden = true;
    busy = false;

    const base = file.name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80);
    const name = `${base}_repaired.pdf`;
    lastResult = { blob: new Blob([msg.data], { type: "application/pdf" }), name };

    dlCard.innerHTML = `
      <p class="result-line">${name} · ${formatBytes(msg.size)} · ${t} s · via ${msg.method}</p>
      <p class="csp-sub">Check the output before deleting the original — repairs recover structure, not lost content.</p>
      <div class="dl-row"><button class="btn" id="dl-main">Download</button></div>`;
    dlCard.hidden = false;
    status.textContent = `Repaired via ${msg.method} · ${t} s`;

    document.getElementById("dl-main").addEventListener("click", () => {
      if (lastResult) downloadBlob(lastResult.blob, lastResult.name);
    });

    await logHistoryEntry({
      tool: "repair", filename: file.name,
      inSize: file.size, outSize: msg.size, note: msg.method,
    });
  };
  worker.onerror = (e) => {
    clearInterval(ticker);
    progressWrap.hidden = true;
    busy = false;
    btn.disabled = false;
    status.textContent = `Failed: ${e.message || "worker error (see console)"}`;
  };

  worker.postMessage({ type: "run", id: 1, data: buf }, [buf]);
});