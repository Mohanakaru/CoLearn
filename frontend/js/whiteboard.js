/* ── HTML5 Canvas Whiteboard Engine ──────────────────────────── */

let wbCanvas, wbCtx;
let isDrawing   = false;
let lastX = 0, lastY = 0;
let wbTool      = 'pen';
let wbColor     = '#212529';
let wbLineWidth = 4;
let wbPages     = [null];
let wbPageIndex = 0;

function initWhiteboard() {
  wbCanvas = document.getElementById('whiteboard-canvas');
  if (!wbCanvas) return;
  wbCtx = wbCanvas.getContext('2d');

  resizeWhiteboard();

  // Remove old listeners (in case re-init)
  wbCanvas.replaceWith(wbCanvas.cloneNode(true));
  wbCanvas = document.getElementById('whiteboard-canvas');
  wbCtx    = wbCanvas.getContext('2d');
  resizeWhiteboard();

  wbCanvas.addEventListener('pointerdown', onWBDown, { passive: false });
  wbCanvas.addEventListener('pointermove', onWBMove, { passive: false });
  wbCanvas.addEventListener('pointerup',   onWBUp);
  wbCanvas.addEventListener('pointerout',  onWBUp);

  wbPages     = [null];
  wbPageIndex = 0;
  const lbl = document.getElementById('wb-page-label');
  if (lbl) lbl.textContent = 'Page 1';
}

function resizeWhiteboard() {
  if (!wbCanvas) return;
  const container = wbCanvas.parentElement;
  if (!container) return;

  const w = container.clientWidth;
  const h = Math.max(380, window.innerHeight * 0.50);

  let saved = null;
  if (wbCtx && wbCanvas.width > 0) {
    try { saved = wbCtx.getImageData(0, 0, wbCanvas.width, wbCanvas.height); } catch (e) {}
  }
  wbCanvas.width  = w;
  wbCanvas.height = h;
  wbCanvas.style.height = h + 'px';
  wbCtx.fillStyle = '#ffffff';
  wbCtx.fillRect(0, 0, w, h);
  if (saved) { try { wbCtx.putImageData(saved, 0, 0); } catch (e) {} }
}

function getCanvasPos(e) {
  const rect = wbCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (wbCanvas.width  / rect.width),
    y: (e.clientY - rect.top)  * (wbCanvas.height / rect.height),
  };
}

function applyWBStyle() {
  if (wbTool === 'eraser') {
    wbCtx.globalCompositeOperation = 'destination-out';
    wbCtx.strokeStyle = 'rgba(0,0,0,1)';
    wbCtx.fillStyle   = 'rgba(0,0,0,1)';
    wbCtx.lineWidth   = wbLineWidth * 4;
  } else {
    wbCtx.globalCompositeOperation = 'source-over';
    wbCtx.strokeStyle = wbColor;
    wbCtx.fillStyle   = wbColor;
    wbCtx.lineWidth   = wbLineWidth;
  }
  wbCtx.lineCap  = 'round';
  wbCtx.lineJoin = 'round';
}

function onWBDown(e) {
  e.preventDefault();
  isDrawing = true;
  const pos = getCanvasPos(e);
  lastX = pos.x; lastY = pos.y;
  applyWBStyle();
  wbCtx.beginPath();
  wbCtx.arc(lastX, lastY, wbCtx.lineWidth / 2, 0, Math.PI * 2);
  wbCtx.fill();
}

function onWBMove(e) {
  if (!isDrawing) return;
  e.preventDefault();
  const pos = getCanvasPos(e);
  applyWBStyle();
  wbCtx.beginPath();
  wbCtx.moveTo(lastX, lastY);
  wbCtx.lineTo(pos.x, pos.y);
  wbCtx.stroke();
  lastX = pos.x; lastY = pos.y;
}

function onWBUp() { isDrawing = false; }

/* ─ Tool controls ────────────────────────────────────────────── */
function setWBTool(tool) {
  wbTool = tool;
  ['pen','eraser'].forEach(t => {
    document.getElementById('wb-btn-' + t)?.classList.toggle('active', t === tool);
  });
}

function updateWBColor(val) {
  wbColor = val;
  if (wbTool !== 'pen') setWBTool('pen');
}

function updateWBSize(val) {
  wbLineWidth = parseInt(val) || 4;
}

/* ─ Page management ──────────────────────────────────────────── */
function wbAction(action) {
  const lbl = document.getElementById('wb-page-label');
  switch (action) {
    case 'clear':
      wbCtx.globalCompositeOperation = 'source-over';
      wbCtx.fillStyle = '#ffffff';
      wbCtx.fillRect(0, 0, wbCanvas.width, wbCanvas.height);
      break;
    case 'new':
      wbPages[wbPageIndex] = wbCtx.getImageData(0, 0, wbCanvas.width, wbCanvas.height);
      wbPages.push(null);
      wbPageIndex = wbPages.length - 1;
      wbCtx.fillStyle = '#ffffff';
      wbCtx.fillRect(0, 0, wbCanvas.width, wbCanvas.height);
      if (lbl) lbl.textContent = `Page ${wbPageIndex + 1}`;
      break;
    case 'prev':
      if (wbPageIndex > 0) {
        // Save current page before leaving
        wbPages[wbPageIndex] = wbCtx.getImageData(0, 0, wbCanvas.width, wbCanvas.height);
        wbPageIndex--;
        loadWBPage();
        if (lbl) lbl.textContent = `Page ${wbPageIndex + 1}`;
      }
      // If already on page 1, do nothing (no page before page 1)
      break;
    case 'next':
      // Save current page before leaving
      wbPages[wbPageIndex] = wbCtx.getImageData(0, 0, wbCanvas.width, wbCanvas.height);
      if (wbPageIndex < wbPages.length - 1) {
        // Move to existing next page
        wbPageIndex++;
        loadWBPage();
      } else {
        // On the last page — create a new blank page
        wbPages.push(null);
        wbPageIndex = wbPages.length - 1;
        wbCtx.globalCompositeOperation = 'source-over';
        wbCtx.fillStyle = '#ffffff';
        wbCtx.fillRect(0, 0, wbCanvas.width, wbCanvas.height);
      }
      if (lbl) lbl.textContent = `Page ${wbPageIndex + 1}`;
      break;
    case 'save':
      const a = document.createElement('a');
      a.download = `CoLearn_WB_P${wbPageIndex + 1}.png`;
      a.href     = wbCanvas.toDataURL('image/png');
      a.click();
      break;
  }
}

function loadWBPage() {
  wbCtx.fillStyle = '#ffffff';
  wbCtx.fillRect(0, 0, wbCanvas.width, wbCanvas.height);
  if (wbPages[wbPageIndex]) {
    try { wbCtx.putImageData(wbPages[wbPageIndex], 0, 0); } catch (e) {}
  }
}

/* ─ Window resize ────────────────────────────────────────────── */
window.addEventListener('resize', () => {
  if (AppState.wsCurrentState === 'whiteboard') resizeWhiteboard();
});
