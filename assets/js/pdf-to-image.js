import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "/assets/js/shared.js";

// pdf.js setup — identical to reorder.js (single source of truth for these settings)
pdfjsLib.GlobalWorkerOptions.workerSrc = "/assets/vendor/pdf.worker.min.js";
const PDF_OPTS = {
  isEvalSupported: false,
  cMapUrl: "/assets/vendor/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/assets/vendor/standard_fonts/",
};

// Memory guard: A4 @ 288 DPI ≈ 2380×3360 px ≈ 32MB per canvas — fine one at a
// time, fatal if we kept them all. So: render → encode → release, per page.
const MAX_PIXELS_PER_SIDE = 5000;

let file = null;
let busy = false;
let lastResult = null;
let lastFiles = [];

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
  if (!f || busy) return;
  if (!f.name.toLowerCase().endsWith(".pdf")) {
    status.textContent = "That's not a PDF.";
    return;
  }
  file = f;
  lastResult = null;
  lastFiles = [];
  controls.hidden = false;
  dlCard.hidden = true;
  summary.textContent = `${file.name} — ${formatBytes(file.size)}`;
  status.textContent = "";
  btn.disabled = false;
});

btn.addEventListener("click", async () => {
  if (busy || !file) return;
  busy = true;
  btn.disabled = true;
  dlCard.hidden = true;
  status.textContent = "";

  const scale = Number(document.querySelector("input[name=dpi]:checked").value);
  const fmt = document.querySelector("input[name=fmt]:checked").value;
  const base = file.name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 60) || "pages";

  startedAt = performance.now();
  progressWrap.hidden = false;
  renderProgress();
  ticker = setInterval(renderProgress, 100);

  try {
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf, ...PDF_OPTS }).promise;
    pageTotal = doc.numPages;

    const files = [];   // { name, bytes }
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      // Clamp to the pixel guard (absurd page sizes / DPI combos)
      let s = scale;
      if (vp1.width * s > MAX_PIXELS_PER_SIDE) s = MAX_PIXELS_PER_SIDE / vp1.width;
      if (vp1.height * s > MAX_PIXELS_PER_SIDE) s = Math.min(s, MAX_PIXELS_PER_SIDE / vp1.height);
      const vp = page.getViewport({ scale: s });

      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d", { alpha: fmt === "png" });
      ctx.fillStyle = "#ffffff";                 // JPEG has no alpha — flatten onto white
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      const mime = fmt === "png" ? "image/png" : "image/jpeg";
      const blob = await new Promise((res) =>
        canvas.toBlob(res, mime, fmt === "jpeg" ? 0.85 : undefined));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      files.push({
        name: `${base}_${String(i).padStart(3, "0")}.${fmt === "png" ? "png" : "jpg"}`,
        bytes,
      });

      canvas.width = 0; canvas.height = 0;      // release the canvas memory now
      page.cleanup();                            // pdf.js per-page resource release
      pageCurrent = i;
      renderProgress();
      await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
    }

    await doc.destroy();

    const t = elapsed();
    let outBlob, outName, count = files.length;
    if (count === 1) {
      outBlob = new Blob([files[0].bytes], { type: files[0].name.endsWith(".png") ? "image/png" : "image/jpeg" });
      outName = files[0].name;
    } else {
      const entries = {};
      for (const f of files) entries[f.name] = f.bytes;
      const zipped = fflate.zipSync(entries, { level: 0 }); // JPEG/PNG already compressed
      outBlob = new Blob([zipped], { type: "application/zip" });
      outName = `${base}_images.zip`;
    }

    lastResult = { blob: outBlob, name: outName };
    lastFiles = count > 1 && count <= 6
      ? files.map((f) => ({ blob: new Blob([f.bytes], { type: f.name.endsWith(".png") ? "image/png" : "image/jpeg" }), name: f.name }))
      : [];

    dlCard.innerHTML = `
      <p class="result-line">${outName} · ${count} ${count === 1 ? "image" : "images"} · ${formatBytes(outBlob.size)} · ${t} s</p>
      <div class="dl-row">
        <button class="btn" id="dl-main">Download</button>
        ${lastFiles.map((f, i) => `<button class="btn btn-secondary dl-one" data-i="${i}">${f.name}</button>`).join("")}
      </div>`;
    dlCard.hidden = false;
    status.textContent = "";

    document.getElementById("dl-main").addEventListener("click", () => {
      if (lastResult) downloadBlob(lastResult.blob, lastResult.name);
    });
    dlCard.querySelectorAll(".dl-one").forEach((b) => {
      b.addEventListener("click", () => {
        const f = lastFiles[Number(b.dataset.i)];
        if (f) downloadBlob(f.blob, f.name);
      });
    });

    await logHistoryEntry({
      tool: "pdf2img", filename: file.name,
      inSize: file.size, outSize: outBlob.size,
      note: `${count} × ${fmt} @ ${scale * 96} DPI`,
    });

  } catch (err) {
    const enc = err?.name === "EncryptedPDFError" || /encrypt/i.test(String(err?.message || err));
    fail(enc ? "This PDF is password-protected — unlock it first."
             : (err?.message || String(err)));
  } finally {
    busy = false;
    btn.disabled = false;
    clearInterval(ticker);
    progressWrap.hidden = true;
  }
});