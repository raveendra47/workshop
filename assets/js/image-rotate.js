/* image-rotate.js - page layer for /image-rotate/ */
(function () {
  'use strict';

  const fmt = document.getElementById('ie-format');
  const quality = document.getElementById('ie-quality');
  const qOut = document.getElementById('ie-quality-out');

  function q() {
    const v = Number(quality && quality.value);
    return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 0.9;
  }

  function syncQ() { if (qOut) qOut.textContent = Math.round(q() * 100) + '%'; }

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

  if (quality) quality.addEventListener('input', syncQ);
  syncQ();

  const go = document.getElementById('ie-go');
  if (go) go.addEventListener('click', function () {
    ImageEngine.run({
      suffix: 'rotated',
      buildOptions: function (file) {
        const ar = document.querySelector('input[name="ie-angle"]:checked');
        return {
          op: 'rotate',
          angle: ar ? Number(ar.value) : 0,
          flipH: !!(document.getElementById('ie-fliph') && document.getElementById('ie-fliph').checked),
          flipV: !!(document.getElementById('ie-flipv') && document.getElementById('ie-flipv').checked),
          mime: pickMime(file),
          quality: q()
        };
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
