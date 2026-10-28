import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "./shared.js";

let file = null;
let busy = false;
let lastResult = null;
let startedAt = 0;
const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

const zone = document.querySelector("[data-upload]");
const controls = document.getElementById("tool-controls");
const summary = document.getElementById("file-summary");
const pw = document.getElementById("pw");
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
  summary.textContent = `${file.name} — ${formatBytes(file.size)}`;
  status.textContent = "";
  btn.disabled = false;
});

pw.addEventListener("input", () => { btn.disabled = !file || busy || !pw.value; });

btn.addEventListener("click", async () => {
  if (busy || !file || !pw.value) return;
  busy = true;
  btn.disabled = true;
  dlCard.hidden = true;
  status.textContent = "";
  startedAt = performance.now();
  progressWrap.hidden = false;
  progressStatus.textContent = `Decrypting · ${elapsed()} s`;
  const ticker = setInterval(() => {
    progressStatus.textContent = `Decrypting · ${elapsed()} s`;
  }, 100);

  const buf = await file.arrayBuffer();
  const worker = new Worker(new URL("./workers/qpdf-worker.js", import.meta.url).href, { type: "module" });
  worker.onmessage = async (e) => {
    const msg = e.data;
    if (msg.type === "error") {
      clearInterval(ticker);
      progressWrap.hidden = true;
      busy = false;
      btn.disabled = false;
      status.textContent = `Unlock failed: ${msg.message}`;
      return;
    }
    if (msg.type !== "done") return;
    const t = elapsed();
    clearInterval(ticker);
    progressWrap.hidden = true;
    busy = false;

    const base = file.name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80);
    const name = `${base}_unlocked.pdf`;
    lastResult = { blob: new Blob([msg.data], { type: "application/pdf" }), name };

    dlCard.innerHTML = `
      <p class="result-line">${name} · ${formatBytes(msg.size)} · ${t} s</p>
      <p class="csp-sub">The output has no password — treat it accordingly.</p>
      <div class="dl-row"><button class="btn" id="dl-main">Download</button></div>`;
    dlCard.hidden = false;

    document.getElementById("dl-main").addEventListener("click", () => {
      if (lastResult) downloadBlob(lastResult.blob, lastResult.name);
    });

    await logHistoryEntry({
      tool: "unlock", filename: file.name,
      inSize: file.size, outSize: msg.size, note: "password removed",
    });
  };
  worker.onerror = (e) => {
    clearInterval(ticker);
    progressWrap.hidden = true;
    busy = false;
    btn.disabled = false;
    status.textContent = `Failed: ${e.message || "worker error (see console)"}`;
  };

  worker.postMessage({ type: "run", id: 1, data: buf, op: "unlock", password: pw.value }, [buf]);
});