import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "./shared.js";

let file = null;
let busy = false;
let lastResult = null;

let startedAt = 0;
const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

const zone = document.querySelector("[data-upload]");
const controls = document.getElementById("tool-controls");
const summary = document.getElementById("file-summary");
const pw1 = document.getElementById("pw1");
const pw2 = document.getElementById("pw2");
const pwNote = document.getElementById("pw-note");
const btn = document.getElementById("run-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressStatus = document.getElementById("progress-status");
const dlCard = document.getElementById("dl-card");
const status = document.getElementById("status");

const strength = (p) => {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 14) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return ["very weak", "weak", "fair", "good", "strong", "very strong"][s];
};

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
  updateBtn();
});

function updateBtn() {
  const match = pw1.value.length >= 4 && pw1.value === pw2.value;
  btn.disabled = !file || !match || busy;
  if (!pw1.value) pwNote.textContent = "";
  else if (pw1.value.length < 4) pwNote.textContent = "At least 4 characters.";
  else if (pw1.value !== pw2.value) pwNote.textContent = "Passwords don't match.";
  else pwNote.textContent = `Password strength: ${strength(pw1.value)}.`;
}

[pw1, pw2].forEach((el) => el.addEventListener("input", updateBtn));

btn.addEventListener("click", async () => {
  if (busy || !file) return;
  busy = true;
  btn.disabled = true;
  dlCard.hidden = true;
  status.textContent = "";
  startedAt = performance.now();
  progressWrap.hidden = false;
  progressStatus.textContent = `Encrypting · ${elapsed()} s`;
  const ticker = setInterval(() => {
    progressStatus.textContent = `Encrypting · ${elapsed()} s`;
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
      status.textContent = `Encryption failed: ${msg.message}`;
      return;
    }
    if (msg.type !== "done") return;
    const t = elapsed();
    clearInterval(ticker);
    progressWrap.hidden = true;
    busy = false;

    const base = file.name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80);
    const name = `${base}_encrypted.pdf`;
    lastResult = { blob: new Blob([msg.data], { type: "application/pdf" }), name };

    dlCard.innerHTML = `
      <p class="result-line">${name} · ${formatBytes(msg.size)} · ${t} s</p>
      <p class="csp-sub">Verify before trusting it: open the download and confirm it demands the password.</p>
      <div class="dl-row"><button class="btn" id="dl-main">Download</button></div>`;
    dlCard.hidden = false;

    document.getElementById("dl-main").addEventListener("click", () => {
      if (lastResult) downloadBlob(lastResult.blob, lastResult.name);
    });

    await logHistoryEntry({
      tool: "encrypt", filename: file.name,
      inSize: file.size, outSize: msg.size, note: "AES-256",
    });
  };
  worker.onerror = (e) => {
    clearInterval(ticker);
    progressWrap.hidden = true;
    busy = false;
    btn.disabled = false;
    status.textContent = `Failed: ${e.message || "worker error (see console)"}`;
  };

  worker.postMessage({ type: "run", id: 1, data: buf, op: "encrypt", password: pw1.value }, [buf]);
});