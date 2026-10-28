import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "./shared.js";

const ACCEPT = /image\/(jpeg|png|webp)/;
const EXTS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const SUFFIX = { compress: "_compressed", convert: "_converted", resize: "_resized", rotate: "_edited" };

const images = [];   // { file, url, w, h, rot, flipH, flipV }
let selected = -1;
let busy = false;
let previewToken = 0;
let debounceTimer = null;
let startedAt = 0, ticker = null, pageTotal = 0, pageCurrent = 0;
let results = [];

const $ = (id) => document.getElementById(id);
const zone = document.querySelector("[data-upload]");
const list = $("img-list");
const workshop = $("workshop");
const runBtn = $("run-btn");
const status = $("status");
const dlCard = $("dl-card");
const progressWrap = $("progress-wrap");
const progressBar = document.querySelector(".progress-bar");
const progressStatus = $("progress-status");
const quality = $("quality");
const qVal = $("q-val");
const previewName = $("preview-name");
const beforeImg = $("preview-before");
const afterImg = $("preview-after");
const sizesEl = $("preview-sizes");

const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);
const currentOp = () => document.querySelector("input[name=op]:checked").value;

async function decode(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { return createImageBitmap(file); }
}

function targetFormatFor(it) {
  const fmt = document.querySelector("input[name=ofmt]:checked").value;
  if (fmt === "keep") return ACCEPT.test(it.file.type) ? it.file.type : "image/jpeg";
  return fmt;
}

function transformedCanvas(bitmap, it, op) {
  const rot = ((it.rot % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const effW = swap ? bitmap.height : bitmap.width;
  const effH = swap ? bitmap.width : bitmap.height;

  let outW = effW, outH = effH, sx = 1, sy = 1;
  if (op === "resize") {
    const wIn = Math.floor(Number($("rz-w").value) || 0);
    const hIn = Math.floor(Number($("rz-h").value) || 0);
    if (wIn > 0 && hIn > 0) {
      const mode = document.querySelector("input[name=rmode]:checked").value;
      if (mode === "fit") {
        const s = Math.min(wIn / effW, hIn / effH);
        sx = sy = s;
        outW = Math.max(1, Math.round(effW * s));
        outH = Math.max(1, Math.round(effH * s));
      } else {
        sx = wIn / effW; sy = hIn / effH;
        outW = wIn; outH = hIn;
      }
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (targetFormatFor(it) === "image/jpeg") {   // JPEG has no alpha - flatten onto white
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);
  }
  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.scale((it.flipH ? -1 : 1) * sx, (it.flipV ? -1 : 1) * sy);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  ctx.restore();
  return canvas;
}

function encode(canvas, fmt, q) {
  return new Promise((res) => canvas.toBlob(res, fmt, fmt === "image/png" ? undefined : q));
}

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

function applyThumbTransform(img, it) {
  img.style.transform = "rotate(" + it.rot + "deg) scaleX(" + (it.flipH ? -1 : 1) + ") scaleY(" + (it.flipV ? -1 : 1) + ")";
}

function rowLabel(it, i) {
  const edited = it.rot || it.flipH || it.flipV ? " · edited" : "";
  return (i + 1) + ". " + it.file.name + " - " + formatBytes(it.file.size) + edited;
}

function render() {
  list.textContent = "";
  images.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "file-row img-row" + (i === selected ? " sel" : "");
    row.addEventListener("click", () => selectImage(i));

    const thumb = document.createElement("span");
    thumb.className = "img-thumb";
    const img = document.createElement("img");
    img.alt = "";
    img.src = it.url;
    applyThumbTransform(img, it);
    thumb.append(img);

    const label = document.createElement("span");
    label.textContent = rowLabel(it, i);

    const controls = document.createElement("span");
    controls.className = "row-controls";
    controls.append(mkBtn("⤢", "View full size", null, (e) => { e.stopPropagation(); openLightbox(i); }));

    if (currentOp() === "rotate") {
      controls.append(
        mkBtn("↻", "Rotate 90 degrees clockwise", null, (e) => { e.stopPropagation(); it.rot += 90; refreshRow(i); }),
        mkBtn("⇋", "Flip horizontal", null, (e) => { e.stopPropagation(); it.flipH = !it.flipH; refreshRow(i); }),
        mkBtn("⇵", "Flip vertical", null, (e) => { e.stopPropagation(); it.flipV = !it.flipV; refreshRow(i); })
      );
    }

    controls.append(mkBtn("✕", "Remove", "row-remove", (e) => {
      e.stopPropagation();
      URL.revokeObjectURL(it.url);
      images.splice(i, 1);
      if (selected >= images.length) selected = images.length - 1;
      render();
      renderPreview();
    }));

    row.append(thumb, label, controls);
    list.append(row);
  });
  workshop.hidden = images.length === 0;
  runBtn.disabled = images.length === 0 || busy;
  if (!images.length) { dlCard.hidden = true; results = []; }
}

function refreshRow(i) {
  const it = images[i];
  const row = list.children[i];
  if (!row) return;
  applyThumbTransform(row.querySelector("img"), it);
  row.children[1].textContent = rowLabel(it, i);
  if (i === selected) renderPreview();
}

function selectImage(i) {
  selected = i;
  [...list.children].forEach((row, j) => row.classList.toggle("sel", j === selected));
  renderPreview();
}

// ---- upload ----
initUpload(zone, (picked) => {
  const ok = picked.filter((f) => ACCEPT.test(f.type));
  const bad = picked.length - ok.length;
  if (bad) status.textContent = "Skipped " + bad + " file" + (bad === 1 ? "" : "s") + " - only JPG / PNG / WebP images are accepted.";
  for (const f of ok) {
    images.push({ file: f, url: URL.createObjectURL(f), w: 0, h: 0, rot: 0, flipH: false, flipV: false });
    const i = images.length - 1;
    const probe = new Image();
    probe.onload = () => {
      images[i].w = probe.naturalWidth;
      images[i].h = probe.naturalHeight;
      if (i === selected) renderPreview();
    };
    probe.src = images[i].url;
  }
  if (selected < 0 && images.length) selected = 0;
  render();
  renderPreview();
});

// ---- preview (debounced) ----
function renderPreview() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doPreview, 200);
}

async function doPreview() {
  if (selected < 0 || !images[selected]) {
    previewName.textContent = "";
    sizesEl.textContent = "";
    return;
  }
  const it = images[selected];
  const op = currentOp();
  const token = ++previewToken;
  previewName.textContent = it.file.name;
  beforeImg.src = it.url;
  try {
    const bitmap = await decode(it.file);
    if (token !== previewToken) { bitmap.close?.(); return; }
    const canvas = transformedCanvas(bitmap, it, op);
    bitmap.close?.();
    const fmt = targetFormatFor(it);
    const q = Math.min(1, Math.max(0.05, Number(quality.value) / 100));
    const blob = await encode(canvas, fmt, q);
    if (token !== previewToken) return;
    const url = URL.createObjectURL(blob);
    if (afterImg._url) URL.revokeObjectURL(afterImg._url);
    afterImg._url = url;
    afterImg.src = url;
    sizesEl.textContent = "-> " + formatBytes(blob.size) + " · " + canvas.width + "x" + canvas.height + "px · " + EXTS[fmt].toUpperCase();
  } catch (e) {
    sizesEl.textContent = "preview failed: " + (e?.message || e);
  }
}

// ---- controls ----
document.querySelectorAll("input[name=op]").forEach((r) => r.addEventListener("change", () => {
  const op = currentOp();
  $("ctl-compress").hidden = op !== "compress";
  $("ctl-convert").hidden = op !== "convert";
  $("ctl-resize").hidden = op !== "resize";
  $("ctl-rotate").hidden = op !== "rotate";
  render();
  renderPreview();
}));

document.querySelectorAll("input[name=ofmt]").forEach((r) => r.addEventListener("change", () => {
  quality.disabled = document.querySelector("input[name=ofmt]:checked").value === "image/png";
  renderPreview();
}));

quality.addEventListener("input", () => { qVal.textContent = quality.value; renderPreview(); });

 $("rz-w").addEventListener("input", () => {
  if (!$("rz-lock").checked || selected < 0 || !images[selected].w) return;
  $("rz-h").value = Math.max(1, Math.round(Number($("rz-w").value) * images[selected].h / images[selected].w));
  renderPreview();
});
 $("rz-h").addEventListener("input", () => {
  if (!$("rz-lock").checked || selected < 0 || !images[selected].w) return;
  $("rz-w").value = Math.max(1, Math.round(Number($("rz-h").value) * images[selected].w / images[selected].h));
  renderPreview();
});
document.querySelectorAll("input[name=rmode]").forEach((r) => r.addEventListener("change", renderPreview));

// ---- lightbox ----
const lb = document.createElement("div");
lb.className = "lightbox";
lb.hidden = true;
lb.innerHTML =
  '<button class="lb-btn lb-x" aria-label="Close">✕</button>' +
  '<button class="lb-btn lb-prev" aria-label="Previous">‹</button>' +
  '<img alt="full size preview">' +
  '<button class="lb-btn lb-next" aria-label="Next">›</button>' +
  '<p class="lb-cap"></p>';
document.body.append(lb);
let lbIndex = 0;

function updateLb() {
  const it = images[lbIndex];
  if (!it) return;
  lb.querySelector("img").src = it.url;
  lb.querySelector(".lb-cap").textContent = (lbIndex + 1) + " / " + images.length + " · " + it.file.name;
}
function openLightbox(i) {
  if (!images.length) return;
  lbIndex = i; lb.hidden = false; updateLb();
}
lb.querySelector(".lb-x").addEventListener("click", () => { lb.hidden = true; });
lb.querySelector(".lb-prev").addEventListener("click", () => { lbIndex = (lbIndex - 1 + images.length) % images.length; updateLb(); });
lb.querySelector(".lb-next").addEventListener("click", () => { lbIndex = (lbIndex + 1) % images.length; updateLb(); });
lb.addEventListener("click", (e) => { if (e.target === lb) lb.hidden = true; });
document.addEventListener("keydown", (e) => {
  if (lb.hidden) return;
  if (e.key === "Escape") lb.hidden = true;
  if (e.key === "ArrowLeft") lb.querySelector(".lb-prev").click();
  if (e.key === "ArrowRight") lb.querySelector(".lb-next").click();
});

// ---- process ----
function renderProgress() {
  progressStatus.textContent = "Processing - image " + (pageCurrent || 1) + " of " + (pageTotal || "?") + " · " + elapsed() + " s";
  if (pageTotal > 0) progressBar.style.width = Math.min(100, (pageCurrent / pageTotal) * 100) + "%";
}

runBtn.addEventListener("click", async () => {
  if (busy || !images.length) return;
  busy = true;
  runBtn.disabled = true;
  dlCard.hidden = true;
  status.textContent = "";
  const op = currentOp();
  pageTotal = images.length; pageCurrent = 0;
  progressBar.style.width = "0%";
  startedAt = performance.now();
  progressWrap.hidden = false;
  renderProgress();
  ticker = setInterval(renderProgress, 100);

  results = [];
  let totalIn = 0, totalOut = 0;
  try {
    const q = Math.min(1, Math.max(0.05, Number(quality.value) / 100));
    for (let i = 0; i < images.length; i++) {
      const it = images[i];
      const bitmap = await decode(it.file);
      const canvas = transformedCanvas(bitmap, it, op);
      bitmap.close?.();
      const fmt = targetFormatFor(it);
      const blob = await encode(canvas, fmt, q);
      canvas.width = 0; canvas.height = 0;
      const base = it.file.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 60) || "image";
      let name = base + SUFFIX[op] + "." + EXTS[fmt];
      let k = 2;
      while (results.some((r) => r.name === name)) name = base + SUFFIX[op] + "_" + (k++) + "." + EXTS[fmt];
      results.push({ blob, name });
      totalIn += it.file.size; totalOut += blob.size;
      pageCurrent = i + 1;
      renderProgress();
      await new Promise((r2) => setTimeout(r2, 0));
    }
    const t = elapsed();
    dlCard.innerHTML =
      "<p class=\"result-line\">" + results.length + " image" + (results.length === 1 ? "" : "s") +
      " · " + formatBytes(totalIn) + " -> " + formatBytes(totalOut) + " · " + t + " s</p>" +
      '<div class="dl-row">' +
      (results.length > 1 ? '<button class="btn" id="dl-zip">Download ZIP</button>' : "") +
      results.slice(0, 6).map((r, i) =>
        '<button class="btn btn-secondary dl-one" data-i="' + i + '">' + r.name + "</button>").join("") +
      "</div>";
    dlCard.hidden = false;

    if (results.length > 1) {
      document.getElementById("dl-zip").addEventListener("click", async () => {
        const entries = {};
        for (const r of results) entries[r.name] = new Uint8Array(await r.blob.arrayBuffer());
        const zipped = fflate.zipSync(entries, { level: 0 });
        downloadBlob(new Blob([zipped], { type: "application/zip" }), "images.zip");
      });
    }
    dlCard.querySelectorAll(".dl-one").forEach((b) => {
      b.addEventListener("click", () => {
        const r = results[Number(b.dataset.i)];
        if (r) downloadBlob(r.blob, r.name);
      });
    });
    status.textContent = "";

    await logHistoryEntry({
      tool: "images",
      filename: images.map((x) => x.file.name).join(", "),
      inSize: totalIn, outSize: totalOut, note: op,
    });
  } catch (e) {
    status.textContent = "Processing failed: " + (e?.message || e);
  } finally {
    clearInterval(ticker);
    progressWrap.hidden = true;
    busy = false;
    runBtn.disabled = images.length === 0;
  }
});
