import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "./shared.js";

export function initStampTool({ tool, specBuilder, outSuffix, note }) {
  let file = null;
  let fontBytes = null;
  let busy = false;
  let lastResult = null;
  let worker = null;

  let pageTotal = 0, pageCurrent = 0;
  let startedAt = 0, ticker = null;

  const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

  const zone = document.querySelector("[data-upload]");
  const controls = document.getElementById("tool-controls");
  const summary = document.getElementById("file-summary");
  const btn = document.getElementById("run-btn");
  const progressWrap = document.getElementById("progress-wrap");
  const progressBar = document.querySelector(".progress-bar");
  const progressStatus = document.getElementById("progress-status");
  const dlCard = document.getElementById("dl-card");
  const status = document.getElementById("status");

  fetch(new URL("../fonts/dejavu-sans.ttf", import.meta.url).href)
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
    .then((b) => { fontBytes = b; })
    .catch(() => { status.textContent = "Font failed to load — text stamping disabled."; });

  function renderProgress() {
    progressStatus.textContent = `Stamping — page ${pageCurrent || 1} of ${pageTotal || "?"} · ${elapsed()} s`;
    if (pageTotal > 0) progressBar.style.width = `${Math.min(100, (pageCurrent / pageTotal) * 100)}%`;
  }

  function fail(msg) {
    clearInterval(ticker);
    progressWrap.hidden = true;
    busy = false;
    btn.disabled = false;
    status.textContent = `${tool} failed: ${msg}`;
  }

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

  btn.addEventListener("click", async () => {
    if (busy || !file) return;
    let spec;
    try {
      spec = specBuilder();
    } catch (err) {
      status.textContent = err.message;
      return;
    }
    if (!spec) return;

    busy = true;
    btn.disabled = true;
    dlCard.hidden = true;
    status.textContent = "";
    pageTotal = 0;
    pageCurrent = 0;
    progressBar.style.width = "0%";
    startedAt = performance.now();
    progressWrap.hidden = false;
    renderProgress();
    ticker = setInterval(renderProgress, 100);

    const buf = await file.arrayBuffer();
    if (!worker) {
      worker = new Worker(new URL("./workers/stamp-worker.js", import.meta.url).href);
      worker.onmessage = (e) => handle(e.data);
      worker.onerror = (e) => {
        worker = null;
        fail(`Worker error: ${e.message || "see console"}`);
      };
    }
    worker.postMessage(
      { type: "run", id: 1, data: buf, spec, fontBytes, imageBytes: spec.imageBytes },
      [buf]
    );
  });

  async function handle(msg) {
    if (msg.type === "start") { pageTotal = msg.total; pageCurrent = 0; renderProgress(); return; }
    if (msg.type === "progress") { pageCurrent = msg.page; renderProgress(); return; }
    if (msg.type === "error") { fail(msg.message); return; }

    if (msg.type !== "done") return;
    const t = elapsed();
    clearInterval(ticker);
    progressWrap.hidden = true;
    busy = false;
    btn.disabled = false;

    const base = file.name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "document";
    const name = `${base}${outSuffix}`;
    lastResult = { blob: new Blob([msg.data], { type: "application/pdf" }), name };

    dlCard.innerHTML = `
      <p class="result-line">${name} · ${formatBytes(msg.size)} · ${msg.stamped} pages · ${t} s</p>
      <div class="dl-row"><button class="btn" id="dl-main">Download</button></div>`;
    dlCard.hidden = false;
    status.textContent = `Stamped ${msg.stamped} pages · ${t} s`;

    document.getElementById("dl-main").addEventListener("click", () => {
      if (lastResult) downloadBlob(lastResult.blob, lastResult.name);
    });

    await logHistoryEntry({
      tool, filename: file.name,
      inSize: file.size, outSize: msg.size,
      note: note ? note() : "",
    });
  }
}