/* image-convert.js - page layer for /image-convert/ */
(function () {
  'use strict';

  const fmt = document.getElementById('ie-format');
  const quality = document.getElementById('ie-quality');
  const qOut = document.getElementById('ie-quality-out');

  function q() {
    const v = Number(quality && quality.value);
    return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 0.85;
  }

  function syncQ() { if (qOut) qOut.textContent = Math.round(q() * 100) + '%'; }

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
      suffix: 'converted',
      buildOptions: function (file) {
        if (fmt && fmt.value === 'image/png') {
          ImageEngine.log(file.name + ': PNG is lossless - quality slider ignored', 'warn');
        }
        return {
          op: 'convert',
          mime: fmt ? fmt.value : 'image/jpeg',
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
