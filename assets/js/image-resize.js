/* image-resize.js - page layer for /image-resize/ */
(function () {
  'use strict';

  const mode = document.getElementById('ie-mode');
  const fmt = document.getElementById('ie-format');
  const quality = document.getElementById('ie-quality');
  const qOut = document.getElementById('ie-quality-out');
  const FIELDS = { width: 'ie-f-width', height: 'ie-f-height', percent: 'ie-f-percent', exact: 'ie-f-exact' };

  function num(id, dflt) {
    const el = document.getElementById(id);
    const v = el ? Number(el.value) : NaN;
    return Number.isFinite(v) && v > 0 ? Math.round(v) : dflt;
  }

  function q() {
    const v = Number(quality && quality.value);
    return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 0.85;
  }

  function syncQ() { if (qOut) qOut.textContent = Math.round(q() * 100) + '%'; }

  function syncMode() {
    if (!mode) return;
    for (const key in FIELDS) {
      const f = document.getElementById(FIELDS[key]);
      if (f) f.hidden = (key !== mode.value);
    }
  }

  function pickMime(file) {
    const v = fmt ? fmt.value : 'auto';
    if (v !== 'auto') return v;
    return ['image/jpeg', 'image/png', 'image/webp'].indexOf(file.type) >= 0 ? file.type : 'image/jpeg';
  }

  ImageEngine.initDrop({
    input: 'ie-input',
    zone: 'ie-zone',
    onFiles: function (files) { ImageEngine.setFiles(files); }
  });

  if (mode) mode.addEventListener('change', syncMode);
  if (quality) quality.addEventListener('input', syncQ);
  syncMode();
  syncQ();

  const go = document.getElementById('ie-go');
  if (go) go.addEventListener('click', function () {
    ImageEngine.run({
      suffix: 'resized',
      buildOptions: function (file) {
        const m = mode ? mode.value : 'width';
        const o = { op: 'resize', mode: m, mime: pickMime(file), quality: q() };
        if (m === 'width') o.value = num('ie-v-width', 1920);
        else if (m === 'height') o.value = num('ie-v-height', 1080);
        else if (m === 'percent') o.value = num('ie-v-percent', 50);
        else { o.width = num('ie-v-exact-w', 1280); o.height = num('ie-v-exact-h', 960); }
        return o;
      }
    });
  });

  const clear = document.getElementById('ie-clear');
  if (clear) clear.addEventListener('click', function () { ImageEngine.clearAll(); });

  const zip = document.getElementById('ie-zip');
  if (zip) {
    zip.addEventListener('click', function () { ImageEngine.zipResults(); });
    if (!ImageEngine.hasZip()) zip.disabled = true;
  }
}());
