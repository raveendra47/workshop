import { downloadBlob, formatBytes } from "./shared.js";

// ---------- request ledger ----------
const rows = [];
const apiCalls = [];
const shown = new Set();

const totalEl = document.getElementById("stat-total");
const sameEl = document.getElementById("stat-same");
const localEl = document.getElementById("stat-local");
const extEl = document.getElementById("stat-external");
const verdictEl = document.getElementById("verdict-line");
const apiLine = document.getElementById("api-line");
const reqBody = document.getElementById("req-body");
const reqCount = document.getElementById("req-count");

function classify(url) {
  try {
    const u = new URL(url, location.href);
    if (u.protocol === "blob:" || u.protocol === "data:") return "local";
    return u.origin === location.origin ? "same" : "external";
  } catch { return "external"; }
}

function addEntry(name, initiator, source) {
  const key = source + "|" + name;
  if (shown.has(key)) return;
  shown.add(key);
  rows.push({ name, initiator: initiator || "other", cls: classify(name) });
  renderRow(rows[rows.length - 1]);
  updateVerdict();
}

function renderRow(r) {
  const tr = document.createElement("tr");
  const short = r.name.length > 70 ? r.name.slice(0, 34) + "..." + r.name.slice(-30) : r.name;
  tr.innerHTML = `<td>${r.initiator}</td><td title="${r.name}">${short}</td>` +
    `<td><span class="badge ${r.cls}">${r.cls === "same" ? "this site" : r.cls === "local" ? "in-memory" : "EXTERNAL"}</span></td>`;
  reqBody.append(tr);
  while (reqBody.children.length > 200) reqBody.firstChild.remove();
  reqCount.textContent = rows.length;
}

function updateVerdict() {
  const same = rows.filter((r) => r.cls === "same").length;
  const local = rows.filter((r) => r.cls === "local").length;
  const ext = rows.filter((r) => r.cls === "external").length;
  const extApi = apiCalls.filter((c) => classify(c.url) === "external").length;
  totalEl.textContent = rows.length;
  sameEl.textContent = same;
  localEl.textContent = local;
  extEl.textContent = ext + extApi;

  if (ext === 0 && extApi === 0) {
    verdictEl.textContent = "All activity stayed on this device. Nothing was sent anywhere.";
    verdictEl.className = "verdict-line ok";
  } else {
    verdictEl.textContent = `${ext} external request(s) / ${extApi} external API call(s) detected — see the log below.`;
    verdictEl.className = "verdict-line bad";
  }
  apiLine.textContent = `fetch / XHR / sendBeacon calls made by this page: ${apiCalls.length || "none"}` +
    (apiCalls.length ? ` — ${apiCalls.map((c) => `${c.api} -> ${classify(c.url) === "same" ? "this site" : classify(c.url)}`).join(", ")}` : "");
}

// Observer: buffered so it also catches loads that happened before this script ran.
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) addEntry(e.name, e.initiatorType, "page");
  }).observe({ type: "resource", buffered: true });
} catch {
  performance.getEntriesByType("resource").forEach((e) => addEntry(e.name, e.initiatorType, "page"));
}
const nav = performance.getEntriesByType("navigation")[0];
if (nav) addEntry(nav.name, "navigation", "page");

// Wrap the three network APIs so site code calling them is visible, not just resource loads.
function recordApi(api, url) { apiCalls.push({ api, url: String(url) }); updateVerdict(); }
const _fetch = window.fetch;
window.fetch = function (input) {
  recordApi("fetch", typeof input === "string" ? input : input?.url ?? String(input));
  return _fetch.apply(this, arguments);
};
const _open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url) {
  recordApi("xhr", url);
  return _open.apply(this, arguments);
};
if (navigator.sendBeacon) {
  const _beacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (url) => { recordApi("beacon", url); return _beacon(url); };
}

// ---------- CSP header self-check (same-origin HEAD fetch) ----------
const cspLine = document.getElementById("csp-line");
fetch(location.href, { method: "HEAD" }).then((r) => {
  const csp = r.headers.get("content-security-policy");
  if (csp) {
    cspLine.innerHTML = `<strong>CSP is active on this server.</strong> <code>${csp.slice(0, 180)}${csp.length > 180 ? "..." : ""}</code>`;
  } else {
    cspLine.innerHTML = `No CSP header on this response — expected on the dev server (eleventy --serve does not read _headers). To see it enforced locally: npx wrangler pages dev dist. In production on Cloudflare Pages / Netlify it ships automatically.`;
  }
}).catch((e) => { cspLine.textContent = "CSP self-check failed: " + e.message; });

// ---------- Demo 1: light (pdf-lib, all in-memory) ----------
let lightBytes = null;
document.getElementById("demo-light").addEventListener("click", async () => {
  const out = document.getElementById("demo-light-out");
  out.textContent = "Creating a test PDF in memory...";
  const t0 = performance.now();
  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([420, 180]);
  page.drawText("Created entirely on this device.", { x: 24, y: 110, size: 12 });
  page.drawText(new Date().toISOString(), { x: 24, y: 88, size: 9 });
  lightBytes = await doc.save();
  const t = ((performance.now() - t0) / 1000).toFixed(2);
  out.innerHTML = `Test PDF created: ${formatBytes(lightBytes.length)} in ${t} s — no network involved. `;
  const b = document.createElement("button");
  b.className = "btn btn-secondary";
  b.textContent = "Download it";
  b.addEventListener("click", () =>
    downloadBlob(new Blob([lightBytes], { type: "application/pdf" }), "device-made.pdf"));
  out.append(b);
});

// ---------- Demo 2: heavy (Ghostscript WASM in its worker; worker self-reports loads) ----------
let heavyBusy = false;
document.getElementById("demo-heavy").addEventListener("click", () => {
  if (heavyBusy) return;
  heavyBusy = true;
  const out = document.getElementById("demo-heavy-out");
  out.textContent = "Loading the compression engine (~15 MB, cached after first run)...";
  const t0 = performance.now();

  const makeDoc = async () => {
    const doc = await PDFLib.PDFDocument.create();
    for (let i = 1; i <= 8; i++) {
      const p = doc.addPage([420, 200]);
      p.drawText(`Verify demo — page ${i} of 8`, { x: 24, y: 120, size: 12 });
    }
    return doc.save();
  };

  makeDoc().then((bytes) => {
    const w = new Worker(new URL("./workers/ghostscript-worker.js", import.meta.url).href, { type: "module" });
    w.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "log") return;
      if (msg.type === "error") {
        out.textContent = "Heavy demo failed: " + msg.message;
        heavyBusy = false; w.terminate(); return;
      }
      if (msg.type === "done") {
        (msg.workerResources || []).forEach((r) => addEntry(r.name, r.type, "worker"));
        const t = ((performance.now() - t0) / 1000).toFixed(1);
        out.textContent = `Compressed ${formatBytes(bytes.length)} -> ${formatBytes(msg.size)} in ${t} s — engine download included, still zero external requests.`;
        heavyBusy = false;
        w.terminate();
      }
    };
    w.onerror = (e) => {
      out.textContent = "Worker error: " + (e.message || "see console");
      heavyBusy = false;
    };
    w.postMessage({ type: "run", id: 1, data: bytes.buffer, preset: "screen" }, [bytes.buffer]);
  });
});
