/* image-compress.js - page layer for /image-compress/ */
(function () {
  'use strict';

  const fmt = document.getElementById('ie-format');
  const quality = document.getElementById('ie-quality');
  const qOut = document.getElementById('ie-quality-out');
  const maxdim = document.getElementById('ie-maxdim');

  function q() {
    const v = Number(quality && quality.value);
    return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 0.8;
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
      suffix: 'compressed',
      buildOptions: function () {
        return {
          op: 'compress',
          mime: fmt ? fmt.value : 'image/jpeg',
          quality: q(),
          maxDim: maxdim && maxdim.value ? Number(maxdim.value) : 0
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
