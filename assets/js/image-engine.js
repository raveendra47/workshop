/* ============================================================
   image-engine.js — shared engine for the single-tool image pages
   compress / convert / resize / rotate & flip
   Zero upload: every byte stays in this tab. Main-thread canvas,
   sequential queue, manual downloads only, optional fflate ZIP.
   Exposes: window.ImageEngine
   ============================================================ */
(function () {
  'use strict';

  const VERSION = '1.0.0';
  const $ = function (id) { return document.getElementById(id); };

  const state = {
    files: [],
    results: [],
    urls: [],
    running: false
  };

  /* ---------- formatting ---------- */
  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '- B';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
  }

  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- mono machine log ---------- */
  function log(msg, cls) {
    const box = $('ie-log');
    if (!box) return;
    const line = document.createElement('div');
    line.className = 'ie-log-line' + (cls ? ' ie-log-' + cls : '');
    const t = new Date();
    const p = function (x) { return String(x).padStart(2, '0'); };
    line.textContent = '[' + p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds()) + '] ' + msg;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  /* ---------- decode (createImageBitmap with <img> fallback) ---------- */
  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file).catch(function () { return decodeViaImg(file); });
    }
    return decodeViaImg(file);
  }

  function decodeViaImg(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('cannot decode ' + file.name)); };
      img.src = url;
    });
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return { c: c, ctx: ctx };
  }

  /* progressive halving keeps big downscales sharp */
  function canvasScaled(bmp, outW, outH, flatten) {
    let src = bmp;
    let sw = bmp.width;
    let sh = bmp.height;
    let guard = 0;
    while (sw > outW * 2 && sh > outH * 2 && guard < 4) {
      const half = makeCanvas(sw / 2, sh / 2);
      half.ctx.drawImage(src, 0, 0, half.c.width, half.c.height);
      src = half.c;
      sw = half.c.width;
      sh = half.c.height;
      guard++;
    }
    const out = makeCanvas(outW, outH);
    if (flatten) { out.ctx.fillStyle = '#ffffff'; out.ctx.fillRect(0, 0, out.c.width, out.c.height); }
    out.ctx.drawImage(src, 0, 0, out.c.width, out.c.height);
    return out.c;
  }

  function canvasRotated(bmp, deg, flipH, flipV, flatten) {
    const swap = (deg === 90 || deg === 270);
    const out = makeCanvas(swap ? bmp.height : bmp.width, swap ? bmp.width : bmp.height);
    if (flatten) { out.ctx.fillStyle = '#ffffff'; out.ctx.fillRect(0, 0, out.c.width, out.c.height); }
    out.ctx.translate(out.c.width / 2, out.c.height / 2);
    if (deg) out.ctx.rotate(deg * Math.PI / 180);
    out.ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    out.ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    return out.c;
  }

  function toBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b);
        else reject(new Error('this browser cannot encode ' + mime));
      }, mime, quality);
    });
  }

  /* ---------- core op ---------- */
  async function processFile(file, o) {
    const bmp = await decode(file);
    const srcW = bmp.width;
    const srcH = bmp.height;
    const flatten = (o.mime === 'image/jpeg');
    let canvas;
    try {
      if (o.op === 'compress') {
        let w = srcW, h = srcH;
        if (o.maxDim && Math.max(srcW, srcH) > o.maxDim) {
          const k = o.maxDim / Math.max(srcW, srcH);
          w = Math.round(srcW * k);
          h = Math.round(srcH * k);
        }
        canvas = canvasScaled(bmp, w, h, flatten);
      } else if (o.op === 'convert') {
        canvas = canvasScaled(bmp, srcW, srcH, flatten);
      } else if (o.op === 'resize') {
        let w = srcW, h = srcH;
        if (o.mode === 'width') { w = o.value; h = Math.max(1, Math.round(srcH * o.value / srcW)); }
        else if (o.mode === 'height') { h = o.value; w = Math.max(1, Math.round(srcW * o.value / srcH)); }
        else if (o.mode === 'percent') {
          const k = o.value / 100;
          w = Math.max(1, Math.round(srcW * k));
          h = Math.max(1, Math.round(srcH * k));
        }
        else { w = o.width; h = o.height; }
        canvas = canvasScaled(bmp, w, h, flatten);
      } else if (o.op === 'rotate') {
        canvas = canvasRotated(bmp, o.angle || 0, !!o.flipH, !!o.flipV, flatten);
      } else {
        throw new Error('unknown op: ' + o.op);
      }
    } finally {
      if (bmp.close) bmp.close();
    }
    const blob = await toBlob(canvas, o.mime, o.quality);
    return { blob: blob, w: canvas.width, h: canvas.height, srcW: srcW, srcH: srcH };
  }

  /* ---------- naming ---------- */
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  function outName(file, suffix, mime) {
    const base = file.name.replace(/\.[^.]+$/, '') || 'image';
    return base + '-' + suffix + '.' + (EXT[mime] || 'img');
  }

  function isImage(f) { return /^image\//.test(f.type); }
  function hasZip() { return !!(window.fflate && typeof fflate.zipSync === 'function'); }

  /* ---------- queue ---------- */
  function setFiles(files) {
    if (state.running) { log('busy - wait for the current run to finish', 'warn'); return; }
    const imgs = files.filter(isImage);
    const skipped = files.length - imgs.length;
    state.files = state.files.concat(imgs);
    if (skipped) log(skipped + ' non-image file(s) skipped', 'warn');
    let total = 0;
    for (const f of state.files) total += f.size;
    log(imgs.length + ' image(s) added · queue: ' + state.files.length + ' file(s) · ' + fmtBytes(total));
    const s = $('ie-status');
    if (s) s.textContent = state.files.length + ' file(s) ready';
    setButtons();
  }

  function setButtons() {
    const go = $('ie-go');
    if (go) go.disabled = state.running || !state.files.length;
    const clr = $('ie-clear');
    if (clr) clr.disabled = state.running || (!state.files.length && !state.results.length);
  }

  async function run(opts) {
    if (state.running) return;
    if (!state.files.length) { log('no files - drop some images first', 'warn'); return; }
    state.running = true;
    setButtons();
    const t0 = performance.now();
    const total = state.files.length;
    let done = 0;
    let ok = 0;
    const status = $('ie-status');
    const tick = setInterval(function () {
      if (status) status.textContent = done + ' / ' + total + ' files · ' + fmtElapsed(performance.now() - t0);
    }, 500);
    for (const file of state.files) {
      if (!isImage(file)) { done++; continue; }
      try {
        const o = opts.buildOptions(file);
        if (o.op === 'rotate' && !o.angle && !o.flipH && !o.flipV) {
          log(file.name + ': no rotation or flip selected - re-encode only', 'warn');
        }
        if (file.type === 'image/gif') {
          log(file.name + ': GIF - first frame only', 'warn');
        }
        const r = await processFile(file, o);
        r.file = file;
        r.outName = outName(file, opts.suffix, o.mime);
        r.url = URL.createObjectURL(r.blob);
        state.urls.push(r.url);
        state.results.push(r);
        addCard(r);
        const pct = r.file.size ? Math.round((1 - r.blob.size / r.file.size) * 100) : 0;
        log(r.outName + ' · ' + fmtBytes(r.file.size) + ' -> ' + fmtBytes(r.blob.size) + ' (' + (pct >= 0 ? '-' : '+') + Math.abs(pct) + '%)');
        ok++;
      } catch (err) {
        log(file.name + ' failed: ' + err.message, 'err');
      }
      done++;
      await new Promise(function (res) { setTimeout(res, 0); });
    }
    clearInterval(tick);
    const ms = performance.now() - t0;
    state.files = [];
    if (status) status.textContent = ok + ' / ' + total + ' done · ' + fmtElapsed(ms);
    state.running = false;
    setButtons();
    log('done · ' + ok + ' of ' + total + ' file(s) in ' + fmtElapsed(ms));
  }

  /* ---------- result cards ---------- */
  function addCard(r) {
    const wrap = $('ie-results');
    if (!wrap) return;
    const pct = r.file.size ? Math.round((1 - r.blob.size / r.file.size) * 100) : 0;
    const card = document.createElement('figure');
    card.className = 'ie-card';
    card.innerHTML =
      '<div class="ie-thumbwrap"><img class="ie-thumb" src="' + r.url + '" alt="' + esc(r.outName) + '" loading="lazy"></div>' +
      '<figcaption class="ie-meta">' +
        '<strong class="ie-name" title="' + esc(r.outName) + '">' + esc(r.outName) + '</strong>' +
        '<span class="ie-dims">' + r.srcW + ' x ' + r.srcH + ' -> ' + r.w + ' x ' + r.h + '</span>' +
        '<span class="ie-size">' + fmtBytes(r.file.size) + ' -> ' + fmtBytes(r.blob.size) + '</span>' +
        '<span class="ie-delta ' + (pct >= 0 ? 'ie-good' : 'ie-bad') + '">' + (pct >= 0 ? '-' : '+') + Math.abs(pct) + '%</span>' +
      '</figcaption>' +
      '<div class="ie-actions"><a class="ie-dl" href="' + r.url + '" download="' + esc(r.outName) + '">Download</a></div>';
    card.querySelector('.ie-thumbwrap').addEventListener('click', function () {
      openLightbox(r.url);
    });
    wrap.appendChild(card);
    const zipBtn = $('ie-zip');
    if (zipBtn && state.results.length > 1) zipBtn.hidden = false;
  }

  /* ---------- lightbox ---------- */
  function ensureLightbox() {
    if ($('ie-lightbox')) return;
    const lb = document.createElement('div');
    lb.id = 'ie-lightbox';
    lb.hidden = true;
    lb.innerHTML = '<img id="ie-lightbox-img" alt="preview">' +
      '<button type="button" id="ie-lightbox-close" aria-label="Close preview">x</button>';
    lb.addEventListener('click', function (e) {
      if (e.target === lb || e.target.id === 'ie-lightbox-close') closeLightbox();
    });
    document.body.appendChild(lb);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeLightbox();
    });
  }

  function openLightbox(url) {
    ensureLightbox();
    $('ie-lightbox-img').src = url;
    $('ie-lightbox').hidden = false;
    document.body.classList.add('ie-noscroll');
  }

  function closeLightbox() {
    const lb = $('ie-lightbox');
    if (lb) lb.hidden = true;
    document.body.classList.remove('ie-noscroll');
  }

  /* ---------- zip (manual download - never automatic) ---------- */
  async function zipResults() {
    if (!hasZip()) { log('fflate is not loaded on this page - use the individual Download buttons', 'warn'); return; }
    if (!state.results.length) return;
    log('packing ' + state.results.length + ' file(s) into a zip...');
    const files = {};
    const seen = {};
    for (const r of state.results) {
      let n = r.outName;
      if (seen[n]) { seen[n]++; n = n.replace(/(\.[^.]+)$/, '-' + seen[n] + '$1'); }
      else seen[n] = 1;
      files[n] = new Uint8Array(await r.blob.arrayBuffer());
    }
    const zipped = fflate.zipSync(files, { level: 6 });
    const t = new Date();
    const p = function (x) { return String(x).padStart(2, '0'); };
    const name = 'images-' + t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) +
      '-' + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds()) + '.zip';
    const url = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }));
    state.urls.push(url);
    const row = $('ie-ziprow');
    if (row) {
      row.hidden = false;
      row.innerHTML = '<a href="' + url + '" download="' + name + '">Download ' + name +
        ' · ' + fmtBytes(zipped.length) + '</a>';
    }
    log('zip ready · ' + fmtBytes(zipped.length) + ' · manual download link added');
  }

  /* ---------- reset ---------- */
  function clearAll() {
    if (state.running) return;
    const n = state.urls.length;
    for (const u of state.urls) { try { URL.revokeObjectURL(u); } catch (e) { /* noop */ } }
    state.urls.length = 0;
    state.files = [];
    state.results = [];
    const wrap = $('ie-results');
    if (wrap) wrap.innerHTML = '';
    const row = $('ie-ziprow');
    if (row) { row.hidden = true; row.innerHTML = ''; }
    const zipBtn = $('ie-zip');
    if (zipBtn) zipBtn.hidden = true;
    const s = $('ie-status');
    if (s) s.textContent = '';
    log('cleared · ' + n + ' object url(s) revoked');
    setButtons();
  }

  /* ---------- drop zone ---------- */
  function initDrop(opts) {
    const input = typeof opts.input === 'string' ? $(opts.input) : opts.input;
    const zone = typeof opts.zone === 'string' ? $(opts.zone) : opts.zone;
    if (!input) return;
    input.addEventListener('change', function () {
      if (input.files && input.files.length) {
        opts.onFiles(Array.prototype.slice.call(input.files));
      }
      input.value = '';
    });
    if (!zone) return;
    zone.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      input.click();
    });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('ie-drag'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('ie-drag'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('ie-drag');
      const fs = e.dataTransfer && e.dataTransfer.files;
      if (fs && fs.length) opts.onFiles(Array.prototype.slice.call(fs));
    });
    log('image engine ' + VERSION + ' ready · zero upload · everything stays in this tab');
  }

  window.ImageEngine = {
    version: VERSION,
    state: state,
    isImage: isImage,
    hasZip: hasZip,
    initDrop: initDrop,
    setFiles: setFiles,
    run: run,
    clearAll: clearAll,
    zipResults: zipResults,
    log: log,
    fmtBytes: fmtBytes
  };
})();
