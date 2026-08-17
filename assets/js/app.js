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
  const zoomControl     = document.getElementById('zoomControl');
  const zoomSlider      = document.getElementById('zoomSlider');
  const zoomLabel       = document.getElementById('zoomLabel');
  const resetBtn        = document.getElementById('resetBtn');
  const downloadPdfBtn  = document.getElementById('downloadPdf');
  const detectionControl = document.getElementById('detectionControl');
  const detOutlineBtn    = document.getElementById('detOutline');
  const detFillBtn       = document.getElementById('detFill');
  const cropCanvas      = document.getElementById('cropCanvas');
  const cropControl     = document.getElementById('cropControl');
  const toggleCropBtn   = document.getElementById('toggleCrop');
  const applyCropBtn    = document.getElementById('applyCrop');
  const resetCropBtn    = document.getElementById('resetCrop');

  // ── Shape definitions ────────────────────────────────────────────────────────
  // Each shape carries:
  //   w, h  — canvas dimensions for this shape in pixels (stitches × rows)
  //   verts — function (W, H) → [[x,y], …] clip-path vertices in canvas pixels
  const HALF_W = Math.ceil(OUTPUT_W / 2);  // 226 — half the full shawl width
  const SHAPES = {
    tri_down:    { w: OUTPUT_W, h: OUTPUT_H, verts: (W, H) => [[0, 0], [W, 0], [W / 2, H]] },
    right_tri_l: { w: HALF_W,  h: OUTPUT_H, verts: (W, H) => [[0, 0], [W, 0], [0, H]] },
    right_tri_r: { w: HALF_W,  h: OUTPUT_H, verts: (W, H) => [[0, 0], [W, 0], [W, H]] },
    rect:        { w: OUTPUT_W, h: 101,      verts: (W, H) => [[0, 0], [W, 0], [W, H], [0, H]] },
    trapezoid:   { w: OUTPUT_W, h: OUTPUT_H, verts: (W, H) => [[0, 0], [W, 0], [W * 0.8, H], [W * 0.2, H]] },
  };

  /** Returns the canvas dimensions for the active shape. */
  function getShapeSize() {
    const s = SHAPES[currentShape];
    return { W: s.w, H: s.h };
  }

  /** Returns the vertex array for the current shape in output-canvas coordinates. */
  function getShapeVertices(W, H) {
    return SHAPES[currentShape].verts(W, H);
  }

  // ── State ───────────────────────────────────────────────────────────────────
  let loadedImage  = null;
  let currentShape = 'tri_down';
  let zoom         = 1.0;
  let panX         = 0;
  let panY         = 0;

  // ── Detection mode ('edge' | 'fill') ────────────────────────────────────────
  let detectionMode = 'edge';

  detOutlineBtn.addEventListener('click', () => {
    if (detectionMode === 'edge') return;
    detectionMode = 'edge';
    detOutlineBtn.classList.add('active');
    detFillBtn.classList.remove('active');
    render();
  });

  detFillBtn.addEventListener('click', () => {
    if (detectionMode === 'fill') return;
    detectionMode = 'fill';
    detFillBtn.classList.add('active');
    detOutlineBtn.classList.remove('active');
    render();
  });

  // ── Crop state ──────────────────────────────────────────────────────────────
  let cropMode         = false;
  let cropRect         = null;   // interactive rect in IMAGE pixels {x,y,w,h}
  let appliedCrop      = null;   // confirmed crop rect (null = full image)
  let cropIsDragging   = false;
  let cropHandle       = null;   // 'tl'|'tr'|'bl'|'br' or null (drawing new rect)
  let cropDragStart    = { x: 0, y: 0 };  // image-pixel mouse pos at drag start
  let cropRectStart    = null;             // cropRect snapshot at drag start

  // ── Shape picker ─────────────────────────────────────────────────────────────
  const shapeOptions = document.getElementById('shapeOptions');
  shapeOptions.addEventListener('click', (e) => {
    const btn = e.target.closest('.shape-option');
    if (!btn) return;
    shapeOptions.querySelectorAll('.shape-option').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentShape = btn.dataset.shape;
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
        detectionControl.classList.remove('hidden');

        // Size the crop canvas to the image (capped at 1600 px on the long side
        // so we don't allocate a huge buffer for large photos).
        const CAP   = 1600;
        const csCap = Math.min(1, CAP / Math.max(img.width, img.height));
        cropCanvas.width  = Math.round(img.width  * csCap);
        cropCanvas.height = Math.round(img.height * csCap);

        // Reset any previous crop
        appliedCrop  = null;
        cropRect     = null;
        cropMode     = false;
        cropCanvas.style.display = 'none';
        toggleCropBtn.textContent = 'Select Region';
        applyCropBtn.classList.add('hidden');
        resetCropBtn.classList.add('hidden');
        cropControl.classList.remove('hidden');

        render();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ── Shared image-positioning helper ─────────────────────────────────────────

  /**
   * Creates an offscreen canvas sized to the active shape with the loaded image
   * drawn at the current zoom/pan. The canvas is pre-filled with mid-grey so
   * uncovered areas don't generate false Sobel edges at the image boundary.
   *
   * @returns {HTMLCanvasElement}
   */
  function createSourceCanvas() {
    const { W, H } = getShapeSize();
    const c   = document.createElement('canvas');
    c.width   = W;
    c.height  = H;
    const ctx = c.getContext('2d');

    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, W, H);

    // Source region: use applied crop or the full image
    const srcX = appliedCrop ? appliedCrop.x : 0;
    const srcY = appliedCrop ? appliedCrop.y : 0;
    const srcW = appliedCrop ? appliedCrop.w : loadedImage.width;
    const srcH = appliedCrop ? appliedCrop.h : loadedImage.height;

    const imgAspect    = srcW / srcH;
    const canvasAspect = W / H;
    let baseW, baseH;
    if (imgAspect > canvasAspect) {
      baseH = H; baseW = srcW * (H / srcH);
    } else {
      baseW = W; baseH = srcH * (W / srcW);
    }
    const drawW = baseW * zoom;
    const drawH = baseH * zoom;
    ctx.drawImage(
      loadedImage,
      srcX, srcY, srcW, srcH,
      (W - drawW) / 2 + panX, (H - drawH) / 2 + panY, drawW, drawH
    );
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
   * Luminance-threshold mask for vector / flat-colour art.
   * Pixels darker than the threshold are treated as "filled" (mask = 1).
   * No neighbour look-up needed — works per-pixel.
   *
   * @param   {ImageData} imageData
   * @returns {Uint8Array}
   */
  function computeFillMask(imageData) {
    const { width: w, height: h, data } = imageData;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const lum = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) | 0;
      mask[i] = lum < 128 ? 1 : 0;
    }
    return mask;
  }

  /** Chooses the correct mask function based on the current detectionMode. */
  function computeMask(imageData) {
    return detectionMode === 'fill'
      ? computeFillMask(imageData)
      : computeEdgeMask(imageData);
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

    const { W, H } = getShapeSize();

    // ① Source canvas — zoomed/panned image, no clip
    const srcCanvas = createSourceCanvas();

    // ② Sobel edge detection
    const edgeMask = computeMask(srcCanvas.getContext('2d').getImageData(0, 0, W, H));

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

    const clipVerts = getShapeVertices(W, H);
    ctx.beginPath();
    ctx.moveTo(clipVerts[0][0], clipVerts[0][1]);
    for (let i = 1; i < clipVerts.length; i++) ctx.lineTo(clipVerts[i][0], clipVerts[i][1]);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(stripeCanvas, 0, 0);

    resultInfo.textContent = `${W} × ${H}px`;
    resultCanvas.classList.add('grabbable');
    previewArea.classList.remove('hidden');
    downloadArea.classList.remove('hidden');
  }

  // ── Crop helpers ─────────────────────────────────────────────────────────────

  /**
   * Converts a mouse event position to original image pixel coordinates.
   * @param {MouseEvent} e
   * @returns {{ x: number, y: number }}
   */
  function getImageCoords(e) {
    const r = cropCanvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(loadedImage.width,  (e.clientX - r.left) / r.width  * loadedImage.width)),
      y: Math.max(0, Math.min(loadedImage.height, (e.clientY - r.top)  / r.height * loadedImage.height)),
    };
  }

  /**
   * Returns which corner handle (if any) the given image-pixel point is near.
   * @param {number} imgX
   * @param {number} imgY
   * @returns {string|null}  'tl'|'tr'|'bl'|'br' or null
   */
  function getHitHandle(imgX, imgY) {
    if (!cropRect) return null;
    const { x, y, w, h } = cropRect;
    // Convert 14 display pixels to image pixels for the hit radius
    const r = cropCanvas.getBoundingClientRect();
    const hitR = 14 * (loadedImage.width / r.width);
    for (const [name, [hx, hy]] of [
      ['tl', [x, y]], ['tr', [x + w, y]],
      ['bl', [x, y + h]], ['br', [x + w, y + h]],
    ]) {
      if (Math.abs(imgX - hx) <= hitR && Math.abs(imgY - hy) <= hitR) return name;
    }
    return null;
  }

  /**
   * Redraws the crop rectangle overlay (darkened surround + border +
   * rule-of-thirds grid + corner handles), or clears it if no cropRect.
   */
  function drawCropOverlay() {
    const ctx = cropCanvas.getContext('2d');
    const cw = cropCanvas.width, ch = cropCanvas.height;
    ctx.clearRect(0, 0, cw, ch);
    if (!cropRect) return;

    // Helpers: image pixels → canvas pixels
    const cx = (ix) => ix * cw / loadedImage.width;
    const cy = (iy) => iy * ch / loadedImage.height;

    const { x, y, w, h } = cropRect;
    const rx = cx(x), ry = cy(y), rw = cx(w), rh = cy(h);

    // Darken outside the crop rect (even-odd fill cuts out the crop region)
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.rect(rx, ry, rw, rh);
    ctx.fill('evenodd');

    // Rule-of-thirds grid
    ctx.strokeStyle = 'rgba(233,69,96,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx + rw / 3,     ry);      ctx.lineTo(rx + rw / 3,     ry + rh);
    ctx.moveTo(rx + 2 * rw / 3, ry);      ctx.lineTo(rx + 2 * rw / 3, ry + rh);
    ctx.moveTo(rx,     ry + rh / 3);      ctx.lineTo(rx + rw, ry + rh / 3);
    ctx.moveTo(rx,     ry + 2 * rh / 3);  ctx.lineTo(rx + rw, ry + 2 * rh / 3);
    ctx.stroke();

    // Crop border
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 2;
    ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);

    // Corner handles (filled squares)
    const HS = 8;
    ctx.fillStyle = '#7c3aed';
    for (const [hx, hy] of [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]]) {
      ctx.fillRect(hx - HS, hy - HS, HS * 2, HS * 2);
    }
  }

  // ── Crop canvas mouse events ──────────────────────────────────────────────────

  cropCanvas.addEventListener('mousedown', (e) => {
    if (!cropMode) return;
    e.preventDefault();
    const { x, y } = getImageCoords(e);
    cropHandle      = getHitHandle(x, y);
    cropDragStart   = { x, y };
    cropRectStart   = cropRect ? { ...cropRect } : null;
    cropIsDragging  = true;

    if (!cropHandle) {
      // Start drawing a new crop rect from scratch
      cropRect = { x, y, w: 0, h: 0 };
    }
  });

  cropCanvas.addEventListener('mousemove', (e) => {
    if (!cropMode) return;
    const { x: mx, y: my } = getImageCoords(e);

    // Update cursor to signal which handle is hovered
    if (!cropIsDragging) {
      const handle = getHitHandle(mx, my);
      const cursors = { tl: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize', br: 'nwse-resize' };
      cropCanvas.style.cursor = handle ? cursors[handle] : 'crosshair';
      return;
    }

    if (cropHandle && cropRectStart) {
      // Resize an existing rect by dragging a corner.
      // Anchor is the opposite corner so the rect can "flip" naturally.
      const { x: sx, y: sy, w: sw, h: sh } = cropRectStart;
      const anchorX = cropHandle.includes('l') ? sx + sw : sx;
      const anchorY = cropHandle.includes('t') ? sy + sh : sy;
      const clampX  = Math.max(0, Math.min(mx, loadedImage.width));
      const clampY  = Math.max(0, Math.min(my, loadedImage.height));
      cropRect = {
        x: Math.min(clampX, anchorX),
        y: Math.min(clampY, anchorY),
        w: Math.abs(clampX - anchorX),
        h: Math.abs(clampY - anchorY),
      };
    } else {
      // Draw new rect — allow any drag direction
      const x0 = cropDragStart.x, y0 = cropDragStart.y;
      cropRect = {
        x: Math.min(x0, mx),
        y: Math.min(y0, my),
        w: Math.min(Math.abs(mx - x0), loadedImage.width),
        h: Math.min(Math.abs(my - y0), loadedImage.height),
      };
    }
    drawCropOverlay();
  });

  cropCanvas.addEventListener('mouseup', () => {
    cropIsDragging = false;
    cropHandle     = null;
    // Discard tiny accidental selections
    if (cropRect && (cropRect.w < 4 || cropRect.h < 4)) {
      cropRect = null;
      drawCropOverlay();
    }
  });

  document.addEventListener('mouseup', () => { cropIsDragging = false; });

  // ── Crop buttons ──────────────────────────────────────────────────────────────

  toggleCropBtn.addEventListener('click', () => {
    cropMode = !cropMode;
    cropCanvas.style.display = cropMode ? 'block' : 'none';

    if (cropMode) {
      toggleCropBtn.textContent = 'Cancel';
      applyCropBtn.classList.remove('hidden');
      // Initialise the overlay to the currently applied crop (or full image)
      cropRect = appliedCrop
        ? { ...appliedCrop }
        : { x: 0, y: 0, w: loadedImage.width, h: loadedImage.height };
      drawCropOverlay();
    } else {
      // Cancelled — revert overlay visuals
      toggleCropBtn.textContent = 'Select Region';
      applyCropBtn.classList.add('hidden');
      cropRect = null;
      drawCropOverlay();
    }
  });

  applyCropBtn.addEventListener('click', () => {
    if (cropRect && cropRect.w > 4 && cropRect.h > 4) {
      appliedCrop = { ...cropRect };
      // Reset zoom/pan so the newly cropped region fills the output cleanly
      zoom = 1.0; panX = 0; panY = 0;
      zoomSlider.value      = '1';
      zoomLabel.textContent = '100%';
      render();
    }
    cropMode = false;
    cropCanvas.style.display = 'none';
    toggleCropBtn.textContent = 'Select Region';
    applyCropBtn.classList.add('hidden');
    resetCropBtn.classList.toggle('hidden', !appliedCrop);
    cropRect = null;
    drawCropOverlay();
  });

  resetCropBtn.addEventListener('click', () => {
    appliedCrop = null;
    cropRect    = null;
    cropMode    = false;
    cropCanvas.style.display = 'none';
    toggleCropBtn.textContent = 'Select Region';
    applyCropBtn.classList.add('hidden');
    resetCropBtn.classList.add('hidden');
    zoom = 1.0; panX = 0; panY = 0;
    zoomSlider.value      = '1';
    zoomLabel.textContent = '100%';
    drawCropOverlay();
    render();
  });

  // ── PDF chart ────────────────────────────────────────────────────────────────

  /**
   * Renders a vertical slice of the knitting chart (columns colStart–colEnd,
   * all OUTPUT_H rows) to an offscreen canvas at CHART_CELL px per stitch.
   * Only cells whose centre lies inside the active shape are drawn, producing
   * a staircase boundary instead of a smooth clipped edge.
   *
   * Layout
   * ──────
   *  PAD_LEFT  │  chart cells (numCols × OUTPUT_H)
   *  ──────────┼──────────────────────────────────
   *  PAD_TOP   │  column-number labels on top
   *
   * Grid lines
   * ──────────
   *  Thin  (0.5 px, #bbb) — edges shared between two in-shape cells
   *  Thick (1.5 px, #444) — edges at ×10 boundaries OR adjacent to empty space
   *
   * @param   {ImageData} stripeData  Full stripe ImageData (dimensions match active shape)
   * @param   {number}    colStart    First column index (0-based, inclusive)
   * @param   {number}    colEnd      Last  column index (0-based, exclusive)
   * @returns {HTMLCanvasElement}
   */
  function drawChartPage(stripeData, colStart, colEnd) {
    const W        = stripeData.width;
    const H        = stripeData.height;
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

    // ── Shape membership test (per-cell, produces staircase boundary) ────────
    // Tests whether a point (px, py) in OUTPUT-canvas pixel space lies inside
    // the current shape (convex polygon), using the cross-product sign method.
    const shapeVertsOut = getShapeVertices(W, H);   // vertices in output-canvas space
    function inShape(col, row) {
      // Test the cell centre against the polygon using cross-product sign method.
      const ptx = col + 0.5;
      const pty = row + 0.5;
      const n   = shapeVertsOut.length;
      let sign  = 0;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = shapeVertsOut[i];
        const [bx, by] = shapeVertsOut[(i + 1) % n];
        const cross = (bx - ax) * (pty - ay) - (by - ay) * (ptx - ax);
        if (cross === 0) continue;
        const s = cross > 0 ? 1 : -1;
        if (sign === 0) { sign = s; }
        else if (s !== sign) return false;
      }
      return true;
    }

    // ── Chart cells (only draw cells inside the shape) ────────────────────────
    const px = stripeData.data;
    for (let row = 0; row < H; row++) {
      for (let col = colStart; col < colEnd; col++) {
        if (!inShape(col, row)) continue;
        const pi = (row * W + col) * 4;
        ctx.fillStyle = `rgb(${px[pi]},${px[pi + 1]},${px[pi + 2]})`;
        ctx.fillRect(PAD_LEFT + (col - colStart) * C, PAD_TOP + row * C, C, C);
      }
    }

    // ── Grid lines — drawn per-cell so they respect the staircase boundary ────
    // For every in-shape cell we draw whichever of its 4 edges need a line.
    // Edge weight rules:
    //   Thick (2 px, #444): edge aligns with a ×10 grid line OR the neighbour
    //                        in that direction is outside the shape (boundary).
    //   Thin  (0.5 px, #bbb): all other shared edges between two in-shape cells.
    //
    // We collect edges into two sets (thin / thick) to batch strokes.

    const thinPaths  = [];   // [{x1,y1,x2,y2}, …]
    const thickPaths = [];

    for (let row = 0; row < H; row++) {
      for (let col = colStart; col < colEnd; col++) {
        if (!inShape(col, row)) continue;

        const cx  = PAD_LEFT + (col - colStart) * C;
        const cy  = PAD_TOP  + row * C;
        const cx2 = cx + C;
        const cy2 = cy + C;

        // Absolute column/row for ×10 checks
        const absCol = col;          // col is already absolute (colStart-based loop)
        const absRow = row;

        // Top edge
        {
          const neighbourIn = (row > 0) && inShape(col, row - 1);
          const thick = (absRow % 10 === 0) || !neighbourIn;
          (thick ? thickPaths : thinPaths).push([cx, cy, cx2, cy]);
        }
        // Bottom edge
        {
          const neighbourIn = (row < H - 1) && inShape(col, row + 1);
          const thick = ((absRow + 1) % 10 === 0) || !neighbourIn;
          (thick ? thickPaths : thinPaths).push([cx, cy2, cx2, cy2]);
        }
        // Left edge
        {
          // Neighbour is in-shape if it exists in the full output canvas
          const neighbourIn = (col > 0) && inShape(col - 1, row);
          const thick = (absCol % 10 === 0) || !neighbourIn;
          (thick ? thickPaths : thinPaths).push([cx, cy, cx, cy2]);
        }
        // Right edge
        {
          const neighbourIn = (col < W - 1) && inShape(col + 1, row);
          const thick = ((absCol + 1) % 10 === 0) || !neighbourIn;
          (thick ? thickPaths : thinPaths).push([cx2, cy, cx2, cy2]);
        }
      }
    }

    // Draw thin lines
    ctx.strokeStyle = '#bbbbbb';
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of thinPaths) {
      ctx.moveTo(x1 + 0.5, y1 + 0.5);
      ctx.lineTo(x2 + 0.5, y2 + 0.5);
    }
    ctx.stroke();

    // Draw thick lines
    ctx.strokeStyle = '#444444';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of thickPaths) {
      ctx.moveTo(x1 + 0.5, y1 + 0.5);
      ctx.lineTo(x2 + 0.5, y2 + 0.5);
    }
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

    const { W, H } = getShapeSize();

    // Build full-rectangle stripe data (triangle clip happens per page in drawChartPage)
    const srcCanvas  = createSourceCanvas();
    const edgeMask   = computeMask(srcCanvas.getContext('2d').getImageData(0, 0, W, H));
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
