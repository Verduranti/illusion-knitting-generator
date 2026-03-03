/**
 * app.js
 * Renders the uploaded image as an illusion-knitting-style striped outline
 * clipped to a triangle at a fixed 451 × 225 px canvas.
 *
 * Pipeline
 * ────────
 * 1. Draw the zoomed/panned image to an offscreen canvas (no clip).
 * 2. Run a Sobel edge detector on those pixels → binary mask.
 * 3. Map every pixel to its vertical stripe (counted right-to-left, 1-based):
 *      odd  stripe (white bg)  → bg = white,     edge pixel = dark grey
 *      even stripe (grey bg)   → bg = grey,       edge pixel = white
 * 4. Write the result ImageData to a second offscreen canvas, then
 *    composite it through the triangle clip onto the visible result canvas.
 *    (putImageData ignores clip paths, so the two-canvas detour is required.)
 *
 * PDF chart export
 * ────────────────
 * The same stripe ImageData (no triangle clip) is rendered as a printable
 * knitting chart: each pixel becomes a CHART_CELL × CHART_CELL square,
 * with thin grid lines every stitch and thick grid lines every 10 stitches.
 * The chart is split into COLS_PER_PAGE-column pages and saved as a PDF.
 */

const OUTPUT_W     = 451;
const OUTPUT_H     = 225;
const STRIPE_W     = 1;    // width of each vertical stripe in pixels
const EDGE_THRESH  = 30;   // Sobel magnitude threshold (0–~1440)
const CHART_CELL   = 10;   // canvas px per chart stitch for PDF rendering
const COLS_PER_PAGE = 50;  // columns per PDF page (shorter axis fills each page)

// Stripe palette
const C_WHITE     = [255, 255, 255];
const C_GREY      = [200, 200, 200];
const C_DARK_GREY = [64,  64,  64 ];

(function () {
  'use strict';

  // ── Element references ──────────────────────────────────────────────────────
  const dropZone        = document.getElementById('dropZone');
  const fileInput       = document.getElementById('fileInput');
  const previewArea     = document.getElementById('previewArea');
  const downloadArea    = document.getElementById('downloadArea');
  const originalPreview = document.getElementById('originalPreview');
  const resultCanvas    = document.getElementById('resultCanvas');
  const originalInfo    = document.getElementById('originalInfo');
  const resultInfo      = document.getElementById('resultInfo');
  const triOptions      = document.getElementById('triOptions');
  const zoomControl     = document.getElementById('zoomControl');
  const zoomSlider      = document.getElementById('zoomSlider');
  const zoomLabel       = document.getElementById('zoomLabel');
  const resetBtn        = document.getElementById('resetBtn');
  const downloadPdfBtn  = document.getElementById('downloadPdf');

  // ── State ───────────────────────────────────────────────────────────────────
  let loadedImage = null;
  let currentDir  = 'up';
  let zoom        = 1.0;
  let panX        = 0;
  let panY        = 0;

  // ── Triangle direction picker ───────────────────────────────────────────────
  triOptions.addEventListener('click', (e) => {
    const btn = e.target.closest('.tri-option');
    if (!btn) return;
    triOptions.querySelectorAll('.tri-option').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentDir = btn.dataset.dir;
    render();
  });

  // ── Zoom slider ─────────────────────────────────────────────────────────────
  zoomSlider.addEventListener('input', () => {
    zoom = parseFloat(zoomSlider.value);
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    render();
  });

  // ── Reset ───────────────────────────────────────────────────────────────────
  resetBtn.addEventListener('click', () => {
    zoom = 1.0;
    panX = 0;
    panY = 0;
    zoomSlider.value      = '1';
    zoomLabel.textContent = '100%';
    render();
  });

  // ── Drag to pan (mouse) ─────────────────────────────────────────────────────
  let isDragging = false;
  let lastX = 0, lastY = 0;

  resultCanvas.addEventListener('mousedown', (e) => {
    if (!loadedImage) return;
    isDragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    resultCanvas.classList.add('dragging');
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panX += e.clientX - lastX;
    panY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    render();
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    resultCanvas.classList.remove('dragging');
  });

  // ── Drag to pan (touch) ─────────────────────────────────────────────────────
  resultCanvas.addEventListener('touchstart', (e) => {
    if (!loadedImage || e.touches.length !== 1) return;
    e.preventDefault();
    isDragging = true;
    lastX = e.touches[0].clientX;
    lastY = e.touches[0].clientY;
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!isDragging || e.touches.length !== 1) return;
    e.preventDefault();
    panX += e.touches[0].clientX - lastX;
    panY += e.touches[0].clientY - lastY;
    lastX = e.touches[0].clientX;
    lastY = e.touches[0].clientY;
    render();
  }, { passive: false });

  document.addEventListener('touchend', () => { isDragging = false; });

  // ── File handling ───────────────────────────────────────────────────────────
  // Note: no click handler needed — dropZone is a <label for="fileInput">,
  // so the browser opens the file picker natively on click.

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
   * Reads an image File, populates the original preview, resets pan/zoom,
   * and triggers an initial render.
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
        dropZone.querySelector('p').innerHTML =
          `<strong>${file.name}</strong> loaded ✓`;
        zoom = 1.0; panX = 0; panY = 0;
        zoomSlider.value      = '1';
        zoomLabel.textContent = '100%';
        zoomControl.classList.remove('hidden');
        render();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ── Shared image-positioning helper ─────────────────────────────────────────

  /**
   * Creates an offscreen canvas (OUTPUT_W × OUTPUT_H) with the loaded image
   * drawn at the current zoom/pan. The canvas is pre-filled with mid-grey so
   * uncovered areas don't generate false Sobel edges at the image boundary.
   *
   * @returns {HTMLCanvasElement}
   */
  function createSourceCanvas() {
    const W = OUTPUT_W, H = OUTPUT_H;
    const c   = document.createElement('canvas');
    c.width   = W;
    c.height  = H;
    const ctx = c.getContext('2d');

    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, W, H);

    const imgAspect    = loadedImage.width  / loadedImage.height;
    const canvasAspect = W / H;
    let baseW, baseH;
    if (imgAspect > canvasAspect) {
      baseH = H; baseW = loadedImage.width * (H / loadedImage.height);
    } else {
      baseW = W; baseH = loadedImage.height * (W / loadedImage.width);
    }
    const drawW = baseW * zoom;
    const drawH = baseH * zoom;
    ctx.drawImage(loadedImage, (W - drawW) / 2 + panX, (H - drawH) / 2 + panY, drawW, drawH);
    return c;
  }

  // ── Image processing ────────────────────────────────────────────────────────

  /**
   * Runs Sobel edge detection over ImageData and returns a binary mask.
   * 1 = edge pixel, 0 = background.
   *
   * @param   {ImageData} imageData
   * @returns {Uint8Array}
   */
  function computeEdgeMask(imageData) {
    const { width: w, height: h, data } = imageData;

    // Luminance-weighted greyscale
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) | 0;
    }

    // Sobel 3×3 — border pixels stay 0
    const mask = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const tl = gray[(y - 1) * w + (x - 1)], tm = gray[(y - 1) * w + x], tr = gray[(y - 1) * w + (x + 1)];
        const ml = gray[      y * w + (x - 1)],                               mr = gray[      y * w + (x + 1)];
        const bl = gray[(y + 1) * w + (x - 1)], bm = gray[(y + 1) * w + x], br = gray[(y + 1) * w + (x + 1)];

        const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
        const gy = -tl - 2 * tm - tr + bl + 2 * bm + br;

        if (Math.sqrt(gx * gx + gy * gy) > EDGE_THRESH) mask[y * w + x] = 1;
      }
    }
    return mask;
  }

  /**
   * Builds an ImageData with the striped-outline effect.
   *
   * Stripes are 1-indexed right-to-left (stripe 1 = rightmost column group).
   *   Odd  stripe: white background, dark-grey on edge pixels.
   *   Even stripe: grey  background, white      on edge pixels.
   *
   * @param   {Uint8Array} edgeMask
   * @param   {number}     w
   * @param   {number}     h
   * @returns {ImageData}
   */
  function buildStripeImageData(edgeMask, w, h) {
    const out  = new ImageData(w, h);
    const data = out.data;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const stripeIdx = Math.floor((w - 1 - x) / STRIPE_W) + 1; // 1-based from right
        const isOdd     = (stripeIdx & 1) === 1;
        const isEdge    = edgeMask[y * w + x] === 1;

        const [r, g, b] =
          isOdd
            ? (isEdge ? C_DARK_GREY : C_WHITE)
            : (isEdge ? C_WHITE     : C_GREY);

        const i    = (y * w + x) * 4;
        data[i]     = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
    return out;
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function render() {
    if (!loadedImage) return;

    const W = OUTPUT_W, H = OUTPUT_H;

    // ① Source canvas — zoomed/panned image, no clip
    const srcCanvas = createSourceCanvas();

    // ② Sobel edge detection
    const edgeMask = computeEdgeMask(srcCanvas.getContext('2d').getImageData(0, 0, W, H));

    // ③ Stripe ImageData
    const stripeData = buildStripeImageData(edgeMask, W, H);

    // ④ Stripe offscreen canvas
    //   (putImageData ignores clip regions, so we drawImage this into the
    //    clipped result canvas rather than calling putImageData directly)
    const stripeCanvas = document.createElement('canvas');
    stripeCanvas.width  = W;
    stripeCanvas.height = H;
    stripeCanvas.getContext('2d').putImageData(stripeData, 0, 0);

    // ⑤ Apply triangle clip, composite stripe canvas
    resultCanvas.width  = W;
    resultCanvas.height = H;
    const ctx = resultCanvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    ctx.beginPath();
    switch (currentDir) {
      case 'up':    ctx.moveTo(W / 2, 0); ctx.lineTo(W, H);     ctx.lineTo(0, H);     break;
      case 'down':  ctx.moveTo(0, 0);     ctx.lineTo(W, 0);     ctx.lineTo(W / 2, H); break;
      case 'left':  ctx.moveTo(0, H / 2); ctx.lineTo(W, 0);     ctx.lineTo(W, H);     break;
      case 'right': ctx.moveTo(W, H / 2); ctx.lineTo(0, 0);     ctx.lineTo(0, H);     break;
    }
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(stripeCanvas, 0, 0);

    resultInfo.textContent = `${W} × ${H}px`;
    resultCanvas.classList.add('grabbable');
    previewArea.classList.remove('hidden');
    downloadArea.classList.remove('hidden');
  }

  // ── PDF chart ────────────────────────────────────────────────────────────────

  /**
   * Renders a vertical slice of the knitting chart (columns colStart–colEnd,
   * all OUTPUT_H rows) to an offscreen canvas at CHART_CELL px per stitch.
   * Cells and grid lines are clipped to the triangle so nothing is drawn
   * outside the triangle boundary.  The triangle border is then drawn on top.
   *
   * Layout
   * ──────
   *  PAD_LEFT  │  chart cells (numCols × OUTPUT_H)
   *  ──────────┼──────────────────────────────────
   *  PAD_TOP   │  column-number labels on top
   *
   * Grid lines
   * ──────────
   *  Thin  (0.5 px, #bbb) — every stitch  (clipped to triangle)
   *  Thick (2 px,   #444) — every 10 stitches + outer border  (clipped)
   *
   * @param   {ImageData} stripeData  Full 451×225 stripe ImageData
   * @param   {number}    colStart    First column index (0-based, inclusive)
   * @param   {number}    colEnd      Last  column index (0-based, exclusive)
   * @returns {HTMLCanvasElement}
   */
  function drawChartPage(stripeData, colStart, colEnd) {
    const W        = OUTPUT_W;
    const H        = OUTPUT_H;
    const numCols  = colEnd - colStart;
    const C        = CHART_CELL;
    const PAD_LEFT = 44;   // px — wide enough for 3-digit row labels
    const PAD_TOP  = 28;   // px — column number labels

    const cw = PAD_LEFT + numCols * C + 1;
    const ch = PAD_TOP  + H * C + 1;

    const canvas = document.createElement('canvas');
    canvas.width  = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');

    // ── Background ───────────────────────────────────────────────────────────
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);

    // ── Triangle clip path in chart-canvas coordinates ───────────────────────
    // Image space (col, row) → canvas (PAD_LEFT + (col-colStart)*C, PAD_TOP + row*C)
    const toX = (col) => PAD_LEFT + (col - colStart) * C;
    const toY = (row) => PAD_TOP  + row * C;
    const verts = {
      up:    [[toX(W / 2), toY(0)],     [toX(W), toY(H)], [toX(0),     toY(H)]],
      down:  [[toX(0),     toY(0)],     [toX(W), toY(0)], [toX(W / 2), toY(H)]],
      left:  [[toX(0),     toY(H / 2)], [toX(W), toY(0)], [toX(W),     toY(H)]],
      right: [[toX(W),     toY(H / 2)], [toX(0), toY(0)], [toX(0),     toY(H)]],
    }[currentDir];

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(verts[0][0], verts[0][1]);
    ctx.lineTo(verts[1][0], verts[1][1]);
    ctx.lineTo(verts[2][0], verts[2][1]);
    ctx.closePath();
    ctx.clip();  // everything below is clipped to the triangle

    // ── Chart cells ──────────────────────────────────────────────────────────
    const px = stripeData.data;
    for (let row = 0; row < H; row++) {
      for (let col = colStart; col < colEnd; col++) {
        const pi = (row * W + col) * 4;
        ctx.fillStyle = `rgb(${px[pi]},${px[pi + 1]},${px[pi + 2]})`;
        ctx.fillRect(PAD_LEFT + (col - colStart) * C, PAD_TOP + row * C, C, C);
      }
    }

    // ── Thin grid lines (every stitch) ───────────────────────────────────────
    ctx.strokeStyle = '#bbbbbb';
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    for (let c = 0; c <= numCols; c++) {
      const x = PAD_LEFT + c * C + 0.5;
      ctx.moveTo(x, PAD_TOP);
      ctx.lineTo(x, PAD_TOP + H * C);
    }
    for (let r = 0; r <= H; r++) {
      const y = PAD_TOP + r * C + 0.5;
      ctx.moveTo(PAD_LEFT,               y);
      ctx.lineTo(PAD_LEFT + numCols * C, y);
    }
    ctx.stroke();

    // ── Thick grid lines (every 10 stitches + outer border) ─────────────────
    ctx.strokeStyle = '#444444';
    ctx.lineWidth   = 2;
    ctx.beginPath();

    // Vertical — every 10 absolute columns, plus left and right edges
    for (let c = 0; c <= numCols; c++) {
      const absCol = colStart + c;
      if (absCol % 10 === 0 || c === 0 || c === numCols) {
        const x = PAD_LEFT + c * C + 0.5;
        ctx.moveTo(x, PAD_TOP);
        ctx.lineTo(x, PAD_TOP + H * C);
      }
    }

    // Horizontal — every 10 rows + top and bottom edges
    for (let r = 0; r <= H; r++) {
      if (r % 10 === 0 || r === H) {
        const y = PAD_TOP + r * C + 0.5;
        ctx.moveTo(PAD_LEFT,               y);
        ctx.lineTo(PAD_LEFT + numCols * C, y);
      }
    }
    ctx.stroke();

    ctx.restore();  // lift triangle clip

    // ── Triangle border (drawn after restore — always visible) ───────────────
    ctx.strokeStyle = '#000000';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(verts[0][0], verts[0][1]);
    ctx.lineTo(verts[1][0], verts[1][1]);
    ctx.lineTo(verts[2][0], verts[2][1]);
    ctx.closePath();
    ctx.stroke();

    // ── Row numbers (left margin, every 10) ──────────────────────────────────
    ctx.fillStyle    = '#333333';
    ctx.font         = `${C}px monospace`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    for (let r = 0; r <= H; r++) {
      if (r % 10 === 0) {
        ctx.fillText(String(r), PAD_LEFT - 4, PAD_TOP + r * C);
      }
    }

    // ── Column numbers (top margin, absolute, every 10) ──────────────────────
    ctx.font         = `${Math.round(C * 0.85)}px monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    for (let c = 0; c <= numCols; c++) {
      const absCol = colStart + c;
      if (absCol % 10 === 0) {
        ctx.fillText(String(absCol), PAD_LEFT + c * C, PAD_TOP - 3);
      }
    }

    // ── Page heading (column range) ──────────────────────────────────────────
    ctx.fillStyle    = '#555555';
    ctx.font         = `bold ${C * 1.2}px sans-serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`Cols ${colStart + 1}–${colEnd}`, 2, PAD_TOP - 3);

    return canvas;
  }

  /**
   * Generates a multi-page A4-portrait PDF of the full knitting chart,
   * sliced vertically in COLS_PER_PAGE-column increments.
   * Each page shows all OUTPUT_H rows and COLS_PER_PAGE stitches wide.
   * Cells and grid lines are clipped to the triangle on every page.
   * The PDF opens with fit-width zoom.
   */
  function downloadChartPdf() {
    if (!loadedImage) return;

    const W = OUTPUT_W, H = OUTPUT_H;

    // Build full-rectangle stripe data (triangle clip happens per page in drawChartPage)
    const srcCanvas  = createSourceCanvas();
    const edgeMask   = computeEdgeMask(srcCanvas.getContext('2d').getImageData(0, 0, W, H));
    const stripeData = buildStripeImageData(edgeMask, W, H);

    const { jsPDF }  = window.jspdf;
    const doc        = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    // Open at fit-width zoom so the chart fills the screen immediately
    doc.setDisplayMode('fullwidth');

    const PAGE_W      = 210;   // A4 portrait mm
    const PAGE_H      = 297;
    const MARGIN      = 10;    // mm all sides
    const FOOTER_H    = 8;     // mm reserved at bottom for page label
    const availW      = PAGE_W - MARGIN * 2;
    const availH      = PAGE_H - MARGIN * 2 - FOOTER_H;
    const totalPages  = Math.ceil(W / COLS_PER_PAGE);

    for (let page = 0; page < totalPages; page++) {
      if (page > 0) doc.addPage();

      const colStart    = page * COLS_PER_PAGE;
      const colEnd      = Math.min(colStart + COLS_PER_PAGE, W);

      // Render this column slice (all rows, triangle-clipped) to a high-res canvas
      const chartCanvas = drawChartPage(stripeData, colStart, colEnd);

      // Scale to fit available area (height-constrained for tall narrow strips)
      const scale  = Math.min(availW / chartCanvas.width, availH / chartCanvas.height);
      const imgW   = chartCanvas.width  * scale;
      const imgH   = chartCanvas.height * scale;

      // Centre horizontally; pin to top margin vertically
      const imgX = MARGIN + (availW - imgW) / 2;
      const imgY = MARGIN;

      doc.addImage(chartCanvas.toDataURL('image/png'), 'PNG', imgX, imgY, imgW, imgH);

      // Footer
      doc.setFontSize(7);
      doc.setTextColor(120, 120, 120);
      doc.text(
        `Knitting Chart  ·  Cols ${colStart + 1}–${colEnd}  ·  Page ${page + 1} of ${totalPages}  ·  ${H} rows tall`,
        PAGE_W / 2,
        PAGE_H - MARGIN + 2,
        { align: 'center' }
      );
    }

    doc.save('knitting-chart.pdf');
  }

  // ── PDF button with loading state ────────────────────────────────────────────
  downloadPdfBtn.addEventListener('click', () => {
    downloadPdfBtn.disabled    = true;
    downloadPdfBtn.textContent = 'Generating…';
    // Allow the DOM to repaint before the synchronous heavy computation
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        downloadChartPdf();
      } finally {
        downloadPdfBtn.disabled    = false;
        downloadPdfBtn.textContent = 'Download Chart PDF';
      }
    }));
  });

  // ── Image downloads ──────────────────────────────────────────────────────────
  document.getElementById('downloadPng').addEventListener('click',
    () => download('png'));
  document.getElementById('downloadWebp').addEventListener('click',
    () => download('webp'));

  /**
   * @param {'png'|'webp'} format
   */
  function download(format) {
    const link    = document.createElement('a');
    link.download = `triangle-image.${format}`;
    link.href     = resultCanvas.toDataURL(`image/${format}`, 0.92);
    link.click();
  }
})();
