import { initUpload, downloadBlob, formatBytes, logHistoryEntry } from "/assets/js/shared.js";

const images = [];            // { file, name, bytesPromise } — order = page order
const seen = new Set();
let lastResult = null;

let pageTotal = 0, pageCurrent = 0;
let startedAt = 0, ticker = null;

const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);

const zone = document.querySelector("[data-upload]");
const list = document.getElementById("img-list");
const btn = document.getElementById("run-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.querySelector(".progress-bar");
const progressStatus = document.getElementById("progress-status");
const dlCard = document.getElementById("dl-card");
const status = document.getElementById("status");

initUpload(zone, (picked) => {
    const ok = picked.filter((f) => /image\/(jpeg|png)/.test(f.type));
    const bad = picked.length - ok.length;
    if (bad) status.textContent = `Skipped ${bad} file${bad === 1 ? "" : "s"} — only JPG/PNG images are accepted.`;
    for (const f of ok) {
        const key = `${f.name}|${f.size}|${f.lastModified}`;
        if (seen.has(key)) continue;
        seen.add(key);
        images.push({ file: f });
    }
    render();
});

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

function render() {
    list.textContent = "";
    images.forEach((it, i) => {
        const row = document.createElement("div");
        row.className = "file-row img-row";

        const thumbWrap = document.createElement("span");
        thumbWrap.className = "img-thumb";
        const img = document.createElement("img");
        img.alt = "";
        img.src = URL.createObjectURL(it.file);           // revoked on remove/reset below
        it._thumbUrl = img.src;
        thumbWrap.append(img);

        const label = document.createElement("span");
        label.textContent = `${i + 1}. ${it.file.name} — ${formatBytes(it.file.size)}`;

        const controls = document.createElement("span");
        controls.className = "row-controls";
        const up = mkBtn("↑", "Move earlier", null, () => move(i, -1));
        const down = mkBtn("↓", "Move later", null, () => move(i, +1));
        const rm = mkBtn("✕", "Remove", "row-remove", () => {
            URL.revokeObjectURL(it._thumbUrl);
            images.splice(i, 1);
            render();
        });
        up.disabled = i === 0;
        down.disabled = i === images.length - 1;
        controls.append(up, down, rm);

        row.append(thumbWrap, label, controls);
        list.append(row);
    });

    btn.disabled = images.length === 0;
    if (!images.length) {
        dlCard.hidden = true;
        lastResult = null;
    }
}

function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= images.length) return;
    [images[i], images[j]] = [images[j], images[i]];
    render();
    list.children[i]?.classList.add("settle");
    list.children[j]?.classList.add("settle");
}

if (window.Sortable) {
    new Sortable(list, {
        animation: 150,
        ghostClass: "drag-ghost",
        handle: ".img-thumb",        // drag by thumbnail
        onEnd: (evt) => {
            const [moved] = images.splice(evt.oldIndex, 1);
            images.splice(evt.newIndex, 0, moved);
            render();
        },
    });
}

function renderProgress() {
    progressStatus.textContent = `Creating — page ${pageCurrent || 1} of ${pageTotal || "?"} · ${elapsed()} s`;
    if (pageTotal > 0) {
        progressBar.style.width = `${Math.min(100, (pageCurrent / pageTotal) * 100)}%`;
    }
}

btn.addEventListener("click", async () => {
    if (!images.length || btn.disabled) return;
    btn.disabled = true;
    dlCard.hidden = true;
    status.textContent = "";
    pageTotal = images.length;
    pageCurrent = 0;
    progressBar.style.width = "0%";
    startedAt = performance.now();
    progressWrap.hidden = false;
    renderProgress();
    ticker = setInterval(renderProgress, 100);

    const payload = [];
    for (const it of images) {
        payload.push({ name: it.file.name, mime: it.file.type, bytes: await it.file.arrayBuffer() });
    }

    const worker = new Worker("/assets/js/workers/img2pdf-worker.js");
    worker.onmessage = (e) => handle(e.data);
    worker.onerror = (e) => {
        finish();
        status.textContent = `Failed: ${e.message || "worker error (see console)"}`;
    };
    worker.postMessage({ type: "run", id: 1, images: payload });   // clone, don't transfer
    worker.postMessage({ type: "run", id: 1, images: payload }, payload.map((p) => p.bytes));
});

function finish() {
    clearInterval(ticker);
    progressWrap.hidden = true;
    btn.disabled = images.length === 0;
}

async function handle(msg, count) {
    if (msg.type === "start") { pageTotal = msg.total; pageCurrent = 0; renderProgress(); return; }
    if (msg.type === "progress") { pageCurrent = msg.page; renderProgress(); return; }
    if (msg.type === "error") {
        finish();
        status.textContent = `Failed: ${msg.message}`;
        return;
    }
    if (msg.type !== "done") return;
    const t = elapsed();
    finish();

    const name = "images.pdf";
    lastResult = { blob: new Blob([msg.data], { type: "application/pdf" }), name };

    dlCard.innerHTML = `
    <p class="result-line">${name} · ${msg.count} pages · ${formatBytes(msg.size)} · ${t} s</p>
    <div class="dl-row"><button class="btn" id="dl-main">Download</button></div>`;
    dlCard.hidden = false;
    status.textContent = "";

    document.getElementById("dl-main").addEventListener("click", () => {
        if (lastResult) downloadBlob(lastResult.blob, lastResult.name);
    });

    await logHistoryEntry({
        tool: "img2pdf",
        filename: images.map((it) => it.file.name).join(", "),
        inSize: images.reduce((s, it) => s + it.file.size, 0),
        outSize: msg.size,
        note: `${msg.count} pages`,
    });
}