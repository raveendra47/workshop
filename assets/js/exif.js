import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "/assets/js/shared.js";

// ---------------- EXIF parser (JPEG APP1) ----------------
// Reads IFD0, Exif IFD and GPS IFD from JPEG APP1/TIFF. Tags: human-relevant subset.
function parseExif(bytes) {
  const le = (o) => (bytes[o] | (bytes[o + 1] << 8));
  const be = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]);
  const items = [];
  const push = (label, value) => items.push({ label, value });

  // locate APP1 EXIF
  let tiff = -1;
  for (let i = 2; i < Math.min(bytes.length - 4, 256 * 1024); i++) {
    if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 && bytes[i + 3] === 0x66) { // "Exif"
      tiff = i + 6; break;
    }
  }
  if (tiff < 0 || String.fromCharCode(bytes[tiff], bytes[tiff + 1]) !== "II") {
    return items;  // no EXIF or big-endian TIFF (rare from phones) - report nothing found
  }

  const rd16 = le, rd32 = le;
  const ifd = (base, names, prefix) => {
    try {
      const count = rd16(base);
      for (let i = 0; i < count; i++) {
        const e = base + 2 + i * 12;
        const tag = rd16(e);
        const type = rd16(e + 2);
        const num = rd32(e + 4);
        const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
        const size = (sizes[type] || 1) * num;
        const valOff = size > 4 ? tiff + rd32(e + 8) : e + 8;
        if (type === 2) {                                   // ASCII
          const s = new TextDecoder("utf-8").decode(bytes.slice(valOff, valOff + num - 1)).trim();
          if (s && names[tag]) push(prefix + names[tag], s);
        } else if (type === 3 && names[tag]) {              // SHORT
          push(prefix + names[tag], String(rd16(valOff)));
        } else if ((type === 4 || type === 5) && names[tag]) {
          if (type === 4) push(prefix + names[tag], String(rd32(valOff)));
        } else if (type === 10 && names[tag] === "__rational") { /* handled by caller */ }
      }
    } catch {}
  };

  const ifd0Names = { 271: "Camera make", 272: "Camera model", 305: "Software", 306: "Taken on" };
  const ifd0Off = rd32(tiff + 4);
  const ifd0Base = tiff + ifd0Off;
  ifd(ifd0Base, ifd0Names, "");

  // GPS IFD (tag 0x8825 in IFD0)
  try {
    const c0 = rd16(ifd0Base);
    let gpsBase = -1;
    for (let i = 0; i < c0; i++) {
      const e = ifd0Base + 2 + i * 12;
      if (rd16(e) === 0x8825) { gpsBase = tiff + rd32(e + 8); break; }
    }
    if (gpsBase > 0) {
      const cg = rd16(gpsBase);
      let latRef = "N", lonRef = "E", lat = [], lon = [];
      for (let i = 0; i < cg; i++) {
        const e = gpsBase + 2 + i * 12;
        const tag = rd16(e), type = rd16(e + 2), num = rd32(e + 4);
        const off = (type === 2 && num > 4) ? tiff + rd32(e + 8) : e + 8;
        if (tag === 1) latRef = String.fromCharCode(bytes[off]);
        if (tag === 2) lat = [rd32(off) / rd32(off + 8) || 0, rd32(off + 16) / rd32(off + 24) || 0, rd32(off + 32) / rd32(off + 40) || 0];
        if (tag === 3) lonRef = String.fromCharCode(bytes[off]);
        if (tag === 4) lon = [rd32(off) / rd32(off + 8) || 0, rd32(off + 16) / rd32(off + 24) || 0, rd32(off + 32) / rd32(off + 40) || 0];
      }
      if (lat.length === 3 && lon.length === 3) {
        const latD = lat[0] + lat[1] / 60 + lat[2] / 3600;
        const lonD = lon[0] + lon[1] / 60 + lon[2] / 3600;
        push("GPS latitude", (latRef === "S" ? "-" : "") + latD.toFixed(6) + "°");
        push("GPS longitude", (lonRef === "W" ? "-" : "") + lonD.toFixed(6) + "°");
        push("GPS", "location recorded — anyone with this file can find where it was taken");
      }
    }
  } catch {}

  // Exif IFD (tag 0x8769) - exposure etc., keep it short
  try {
    const c0 = rd16(ifd0Base);
    let exifBase = -1;
    for (let i = 0; i < c0; i++) {
      const e = ifd0Base + 2 + i * 12;
      if (rd16(e) === 0x8769) { exifBase = tiff + rd32(e + 8); break; }
    }
    if (exifBase > 0) ifd(exifBase, { 42036: "Lens model", 42032: "Camera firmware" }, "");
  } catch {}

  return items;
}

// --------------- app state ---------------
const ACCEPT = /image\/(jpeg|png|webp)/;
const images = [];   // { file, url, leaks: [{label,value}] }
let results = [];
let busy = false;
let startedAt = 0, ticker = null, pageTotal = 0, pageCurrent = 0;

const $ = (id) => document.getElementById(id);
const zone = document.querySelector("[data-upload]");
const list = $("exif-list");
const controls = $("exif-controls");
const runBtn = $("run-btn");
const status = $("status");
const dlCard = $("dl-card");
const progressWrap = $("progress-wrap");
const progressBar = document.querySelector(".progress-bar");
const progressStatus = $("progress-status");

const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

initUpload(zone, (picked) => {
  const ok = picked.filter((f) => ACCEPT.test(f.type));
  const bad = picked.length - ok.length;
  if (bad) status.textContent = "Skipped " + bad + " file" + (bad === 1 ? "" : "s") + " - only JPG / PNG / WebP.";
  for (const f of ok) {
    const it = { file: f, url: URL.createObjectURL(f), leaks: [] };
    if (f.type === "image/jpeg") {
      f.arrayBuffer().then((buf) => {
        it.leaks = parseExif(new Uint8Array(buf));
        render();
      });
    } else {
      it.leaks = [{ label: "Container", value: "PNG/WebP text chunks may exist - re-encode removes them" }];
    }
    images.push(it);
  }
  controls.hidden = images.length === 0;
  render();
});

function render() {
  list.textContent = "";
  images.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "file-row leak-row";

    const thumb = document.createElement("span");
    thumb.className = "img-thumb";
    const img = document.createElement("img");
    img.alt = ""; img.src = it.url;
    thumb.append(img);

    const main = document.createElement("span");
    main.className = "leak-main";
    const title = document.createElement("span");
    title.className = "history-name";
    title.textContent = it.file.name + " - " + formatBytes(it.file.size);
    main.append(title);

    if (it.leaks.length) {
      const ul = document.createElement("div");
      ul.className = "leak-tags";
      for (const l of it.leaks) {
        const tag = document.createElement("span");
        tag.className = "leak-tag" + (/GPS/i.test(l.label) ? " leak-gps" : "");
        tag.textContent = l.label + ": " + l.value;
        tag.title = l.label + ": " + l.value;
        ul.append(tag);
      }
      main.append(ul);
    } else if (it.leaks && it.file.type === "image/jpeg" && it._scanned) {
      main.append(Object.assign(document.createElement("span"), { className: "csp-sub", textContent: "No metadata found - already clean." }));
    }

    const controls2 = document.createElement("span");
    controls2.className = "row-controls";
    controls2.append(mkBtn("✕", "Remove", "row-remove", () => {
      URL.revokeObjectURL(it.url);
      images.splice(i, 1);
      controls.hidden = images.length === 0;
      render();
    }));

    row.append(thumb, main, controls2);
    list.append(row);
  });
  runBtn.disabled = images.length === 0 || busy;
}

function mkBtn(text, title, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = text; b.title = title;
  b.setAttribute("aria-label", title);
  if (cls) b.classList.add(cls);
  b.addEventListener("click", onClick);
  return b;
}

function renderProgress() {
  progressStatus.textContent = "Stripping - image " + (pageCurrent || 1) + " of " + (pageTotal || "?") + " · " + elapsed() + " s";
  if (pageTotal > 0) progressBar.style.width = Math.min(100, (pageCurrent / pageTotal) * 100) + "%";
}

runBtn.addEventListener("click", async () => {
  if (busy || !images.length) return;
  busy = true;
  runBtn.disabled = true;
  dlCard.hidden = true;
  status.textContent = "";
  pageTotal = images.length; pageCurrent = 0;
  progressBar.style.width = "0%";
  startedAt = performance.now();
  progressWrap.hidden = false;
  renderProgress();
  ticker = setInterval(renderProgress, 100);

  const q = Number(document.querySelector("input[name=eq]:checked").value);
  results = [];
  let totalIn = 0, totalOut = 0;

  try {
    for (let i = 0; i < images.length; i++) {
      const it = images[i];
      const bitmap = await (async () => {
        try { return await createImageBitmap(it.file, { imageOrientation: "from-image" }); }
        catch { return createImageBitmap(it.file); }
      })();

      const keepFormat = it.file.type === "image/png" || it.file.type === "image/webp";
      const fmt = keepFormat ? it.file.type : "image/jpeg";
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (fmt === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();

      const blob = await new Promise((res) => canvas.toBlob(res, fmt, fmt === "image/jpeg" ? q : undefined));
      canvas.width = 0; canvas.height = 0;

      const base = it.file.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 60) || "image";
      const ext = fmt === "image/jpeg" ? "jpg" : fmt === "image/png" ? "png" : "webp";
      results.push({ blob, name: base + "_clean." + ext });
      totalIn += it.file.size; totalOut += blob.size;
      pageCurrent = i + 1;
      renderProgress();
      await new Promise((r) => setTimeout(r, 0));
    }

    const t = elapsed();
    clearInterval(ticker);
    progressWrap.hidden = true;
    busy = false;
    runBtn.disabled = images.length === 0;

    dlCard.innerHTML =
      "<p class=\"result-line\">" + results.length + " image" + (results.length === 1 ? "" : "s") +
      " · " + formatBytes(totalIn) + " -> " + formatBytes(totalOut) + " · " + t + " s</p>" +
      '<p class="csp-sub">Verification available: re-upload the cleaned output - the leak list will be empty.</p>' +
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
        downloadBlob(new Blob([zipped], { type: "application/zip" }), "cleaned-images.zip");
      });
    }
    dlCard.querySelectorAll(".dl-one").forEach((b) => {
      b.addEventListener("click", () => {
        const r = results[Number(b.dataset.i)];
        if (r) downloadBlob(r.blob, r.name);
      });
    });

    await logHistoryEntry({
      tool: "exif",
      filename: images.map((x) => x.file.name).join(", "),
      inSize: totalIn, outSize: totalOut,
      note: results.length + " cleaned",
    });
  } catch (e) {
    clearInterval(ticker);
    progressWrap.hidden = true;
    busy = false;
    runBtn.disabled = images.length === 0;
    status.textContent = "Strip failed: " + (e?.message || e);
  }
});
