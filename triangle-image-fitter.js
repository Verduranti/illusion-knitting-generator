/**
 * triangle-image-fitter.js
 * Clips an uploaded image to a triangle shape and scales it so its
 * longest side equals the requested pixel size.
 */

(function () {
  'use strict';

  // ── Element references ──────────────────────────────────────────────────────
  const dropZone        = document.getElementById('dropZone');
  const fileInput       = document.getElementById('fileInput');
  const processBtn      = document.getElementById('processBtn');
  const previewArea     = document.getElementById('previewArea');
  const downloadArea    = document.getElementById('downloadArea');
  const originalPreview = document.getElementById('originalPreview');
  const resultCanvas    = document.getElementById('resultCanvas');
  const originalInfo    = document.getElementById('originalInfo');
  const resultInfo      = document.getElementById('resultInfo');
  const triOptions      = document.getElementById('triOptions');
  const maxSizeInput    = document.getElementById('maxSize');

  // ── State ───────────────────────────────────────────────────────────────────
  let loadedImage = null;
  let currentDir  = 'up';

  // ── Triangle direction picker ───────────────────────────────────────────────
  triOptions.addEventListener('click', (e) => {
    const btn = e.target.closest('.tri-option');
    if (!btn) return;

    triOptions.querySelectorAll('.tri-option').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentDir = btn.dataset.dir;
  });

  // ── File handling ───────────────────────────────────────────────────────────
  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  /**
   * Reads an image File, populates the original preview, and enables
   * the process button.
   *
   * @param {File} file
   */
  function handleFile(file) {
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        loadedImage = img;
        originalPreview.src = e.target.result;
        originalInfo.textContent = `${img.width} × ${img.height}px`;
        processBtn.disabled = false;
        dropZone.querySelector('p').innerHTML =
          `<strong>${file.name}</strong> loaded ✓`;
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ── Processing ──────────────────────────────────────────────────────────────
  processBtn.addEventListener('click', () => {
    if (!loadedImage) return;

    const maxSize = parseInt(maxSizeInput.value, 10) || 451;
    const img     = loadedImage;

    // Scale so the longest side equals maxSize
    const scale = maxSize / Math.max(img.width, img.height);
    const w     = Math.round(img.width  * scale);
    const h     = Math.round(img.height * scale);

    resultCanvas.width  = w;
    resultCanvas.height = h;

    const ctx = resultCanvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    // Clip to the selected triangle
    ctx.beginPath();
    switch (currentDir) {
      case 'up':
        ctx.moveTo(w / 2, 0); ctx.lineTo(w, h); ctx.lineTo(0, h);
        break;
      case 'down':
        ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.lineTo(w / 2, h);
        break;
      case 'left':
        ctx.moveTo(0, h / 2); ctx.lineTo(w, 0); ctx.lineTo(w, h);
        break;
      case 'right':
        ctx.moveTo(w, h / 2); ctx.lineTo(0, 0); ctx.lineTo(0, h);
        break;
    }
    ctx.closePath();
    ctx.clip();

    ctx.drawImage(img, 0, 0, w, h);

    resultInfo.textContent = `${w} × ${h}px (long side: ${maxSize}px)`;
    previewArea.classList.remove('hidden');
    downloadArea.classList.remove('hidden');
  });

  // ── Downloads ───────────────────────────────────────────────────────────────
  document.getElementById('downloadPng').addEventListener('click',
    () => download('png'));
  document.getElementById('downloadWebp').addEventListener('click',
    () => download('webp'));

  /**
   * Exports the result canvas as the given image format.
   *
   * @param {'png'|'webp'} format
   */
  function download(format) {
    const link    = document.createElement('a');
    link.download = `triangle-image.${format}`;
    link.href     = resultCanvas.toDataURL(`image/${format}`, 0.92);
    link.click();
  }
})();
