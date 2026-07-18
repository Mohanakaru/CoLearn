/* ── document-service.js – CoLearn Documents with Google Drive ─────
 *
 * Replaces stub implementations with real Google Drive integration.
 * All public function signatures and HTML IDs are preserved exactly.
 *
 * Public API (module-scope, called from HTML):
 *   handleDocumentUpload()          – picks file, checks Drive, uploads
 *   renderDriveFiles(files)         – renders uploaded Drive files list
 *   renderPendingDocuments()        – renders the pending upload queue
 *   previewPendingDocument(id)      – preview a queued (not-yet-uploaded) file
 *   removePendingDocument(id)       – remove from pending queue
 *   attemptDriveUpload(id)          – upload a queued file to Drive
 *   loadSuiteDriveFiles(suiteId)    – fetch + render suite files from backend
 *   openDriveFileViewer(file)       – open Drive file in embedded viewer
 *   deleteDriveFile(fileId,suiteId) – delete a Drive file
 *   connectGoogleDrive()            – open OAuth popup
 *
 * Exposed globals:
 *   window.DocumentService   – singleton instance
 *   window.DocumentMetadata  – class
 */
'use strict';

/* ══ DocumentMetadata ════════════════════════════════════════════ */
function DocumentMetadata(opts) {
  this.id         = opts.id || ('doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  this.name       = opts.name || 'Unknown File';
  this.type       = opts.type || 'application/octet-stream';
  this.size       = opts.size || 0;
  this.selectedAt = opts.selectedAt || new Date();
  this.selectedBy = opts.selectedBy || 'Unknown';
  this.status     = opts.status || 'pending'; // 'pending' | 'uploading' | 'uploaded' | 'error'
  this.file       = opts.file || null;
  this.preview    = opts.preview || null;
  this.progress   = opts.progress || 0;
}

DocumentMetadata.prototype.icon = function () {
  var t = this.type;
  if (t.includes('pdf'))                                                        return '📄';
  if (t.includes('word') || t.includes('docx') || t.includes('doc'))           return '📝';
  if (t.includes('presentation') || t.includes('pptx') || t.includes('ppt'))  return '📊';
  if (t.includes('spreadsheet') || t.includes('xlsx') || t.includes('xls') || t.includes('csv')) return '📈';
  if (t.includes('image') || t.includes('png') || t.includes('jpg') || t.includes('jpeg') || t.includes('gif') || t.includes('webp')) return '🖼️';
  if (t.includes('video') || t.includes('mp4') || t.includes('mov'))          return '🎬';
  if (t.includes('audio') || t.includes('mp3') || t.includes('wav'))          return '🎵';
  if (t.includes('zip') || t.includes('compressed') || t.includes('rar'))     return '📦';
  if (t.includes('text') || t.includes('json') || t.includes('xml') || t.includes('html') || t.includes('css')) return '📃';
  return '📎';
};

DocumentMetadata.prototype.formattedSize = function () {
  var s = this.size;
  if (s < 1024)        return s + ' B';
  if (s < 1024 * 1024) return (s / 1024).toFixed(1) + ' KB';
  return (s / 1024 / 1024).toFixed(1) + ' MB';
};

DocumentMetadata.prototype.formattedTime = function () {
  var d   = this.selectedAt;
  var now = new Date();
  var diff = Math.floor((now - d) / 1000);
  if (diff < 60)    return 'Just now';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return d.toLocaleDateString();
};

window.DocumentMetadata = DocumentMetadata;

/* ══ UploadQueue ════════════════════════════════════════════════ */
function UploadQueue() {
  this._items    = [];
  this._onChange = null;
}
UploadQueue.prototype.add = function (doc) {
  this._items.push(doc);
  this._notify();
};
UploadQueue.prototype.remove = function (id) {
  this._items = this._items.filter(function (d) { return d.id !== id; });
  this._notify();
};
UploadQueue.prototype.get    = function (id) { return this._items.find(function (d) { return d.id === id; }) || null; };
UploadQueue.prototype.getAll = function ()   { return this._items.slice(); };
UploadQueue.prototype.clear  = function ()   { this._items = []; this._notify(); };
Object.defineProperty(UploadQueue.prototype, 'onChange', {
  set: function (fn) { this._onChange = fn; },
});
UploadQueue.prototype._notify = function () {
  if (typeof this._onChange === 'function') this._onChange(this._items);
};

/* ══ DocumentServiceClass ════════════════════════════════════════ */
function DocumentServiceClass() {
  this.queue = new UploadQueue();
  var self   = this;
  this.queue.onChange = function () { renderPendingDocuments(); };

  // Supported file types (expanded for Drive)
  this.allowedExtensions = [
    'pdf','doc','docx','ppt','pptx','xls','xlsx','csv','txt',
    'zip','rar','7z','png','jpg','jpeg','gif','webp','svg',
    'mp4','mov','avi','mkv','mp3','wav',
    'c','cpp','py','java','js','ts','json','xml','html','css','sql',
    'apk','iso','md','log',
  ];
  this.maxSizeBytes = 200 * 1024 * 1024; // 200 MB
}

DocumentServiceClass.prototype.selectFile = function () {
  return new Promise(function (resolve) {
    var input  = document.createElement('input');
    input.type = 'file';
    // Accept everything — Drive takes all file types
    input.accept = '*/*';
    input.onchange = function (e) { resolve(e.target.files[0] || null); };
    input.click();
    window.addEventListener('focus', function cb() {
      setTimeout(function () { if (!input.files.length) resolve(null); }, 400);
      window.removeEventListener('focus', cb);
    }, { once: true });
  });
};

DocumentServiceClass.prototype.validateFile = function (file) {
  if (!file) return { valid: false, error: 'No file selected.' };
  if (file.size > this.maxSizeBytes) {
    return {
      valid: false,
      error: 'File too large. Maximum: 200 MB. Selected: ' + (file.size / 1024 / 1024).toFixed(1) + ' MB',
    };
  }
  return { valid: true };
};

DocumentServiceClass.prototype.queueUpload = function (file, selectedBy) {
  var meta = new DocumentMetadata({
    name: file.name, type: file.type, size: file.size,
    selectedAt: new Date(), selectedBy: selectedBy || 'You',
    status: 'pending', file: file,
  });
  this.queue.add(meta);
  return meta;
};

DocumentServiceClass.prototype.previewDocument = function (docMeta) {
  if (!docMeta || !docMeta.file) return;
  var url = URL.createObjectURL(docMeta.file);
  window.open(url, '_blank');
  setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
};

DocumentServiceClass.prototype.initialize = function () { return this; };

/* ── Singleton ─────────────────────────────────────────────────── */
window.DocumentService = new DocumentServiceClass();

/* ══ Drive OAuth connection state ════════════════════════════════ */
var _driveConnected = null; // null=unknown, true=connected, false=not connected
var _driveEmail     = '';

async function _checkDriveStatus() {
  if (!window.AppState || !window.AppState.currentUser) return false;
  try {
    var data = await API.getDriveStatus();
    _driveConnected = data.connected === true;
    _driveEmail     = data.googleEmail || '';
    _updateDriveStatusBadge();
    return _driveConnected;
  } catch (e) {
    _driveConnected = false;
    return false;
  }
}

function _updateDriveStatusBadge() {
  var badge   = document.getElementById('drive-status-badge');
  var emailEl = document.getElementById('drive-connected-email');
  if (!badge) return;
  if (_driveConnected) {
    badge.style.display   = 'flex';
    badge.style.color     = 'var(--c-green)';
    badge.innerHTML       = '✅ Connected' + (_driveEmail ? ' · ' + escapeHtml(_driveEmail) : '');
    if (emailEl) emailEl.textContent = _driveEmail;
    var banner = document.getElementById('drive-connect-banner');
    if (banner) banner.style.display = 'none';
  } else {
    badge.style.color   = 'var(--c-slate)';
    badge.innerHTML     = '⚠️ Not connected';
    var banner = document.getElementById('drive-connect-banner');
    if (banner) banner.style.display = 'flex';
  }
}

/* ══ Connect Google Drive (OAuth popup) ══════════════════════════ */
async function connectGoogleDrive() {
  var btn = document.getElementById('btn-connect-drive');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Connecting…'; }

  try {
    var data = await API.getDriveAuthUrl();
    if (!data.success) {
      if (data.error === 'DRIVE_NOT_CONFIGURED') {
        showToast('main-toast',
          '⚙️ Google Drive not configured — add real credentials to backend/.env and restart the server.',
          'dark');
        console.error('[Drive] Server says:', data.message);
      } else {
        showToast('main-toast', '⚠️ Could not get auth URL: ' + (data.error || 'Unknown error'), 'dark');
      }
      return;
    }
    if (!data.url) {
      showToast('main-toast', '⚠️ Auth URL missing from server response.', 'dark');
      return;
    }

    // Open OAuth consent as a popup (no redirect inside main window)
    var popup = window.open(data.url, 'drive_oauth', 'width=500,height=640,scrollbars=yes,resizable=yes');

    // postMessage handler — popup sends this on success OR failure
    function handleOAuthMessage(event) {
      if (!event.data || event.data.type !== 'drive_oauth') return;
      window.removeEventListener('message', handleOAuthMessage);
      clearInterval(popupCheck); // stop the fallback checker
      if (popup && !popup.closed) popup.close();

      if (event.data.success) {
        _driveConnected = true;
        _checkDriveStatus(); // fetches email + updates badge
        showToast('main-toast', '✅ Google Drive connected! Resuming upload…', 'dark');
        _resumePendingUploads(); // ← auto-start all queued files
      } else {
        showToast('main-toast', '⚠️ Drive connection failed: ' + (event.data.message || 'Unknown error'), 'dark');
      }
    }
    window.addEventListener('message', handleOAuthMessage);

    // Fallback: user closed popup manually without postMessage
    var popupCheck = setInterval(function () {
      if (popup && popup.closed) {
        clearInterval(popupCheck);
        window.removeEventListener('message', handleOAuthMessage);
        // Re-check in case they completed auth then manually closed the window
        _checkDriveStatus().then(function (connected) {
          if (connected) {
            showToast('main-toast', '✅ Google Drive connected! Resuming upload…', 'dark');
            _resumePendingUploads(); // ← also auto-start here
          }
        });
      }
    }, 800);

  } catch (e) {
    showToast('main-toast', '⚠️ ' + e.message, 'dark');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔗 Connect Google Drive'; }
  }
}

/* ══ handleDocumentUpload – entry point from "Upload Document" btn ═ */
async function handleDocumentUpload() {
  var btn = document.getElementById('btn-upload-document');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Selecting…'; }

  try {
    var file = await window.DocumentService.selectFile();
    if (!file) return;

    var validation = window.DocumentService.validateFile(file);
    if (!validation.valid) {
      showToast('main-toast', '⚠️ ' + validation.error, 'dark');
      return;
    }

    // Check Drive connection (lazy-load status)
    if (_driveConnected === null) {
      await _checkDriveStatus();
    }

    var user = (window.AppState && window.AppState.currentUser) ? window.AppState.currentUser.name : 'You';

    if (!_driveConnected) {
      // Queue file and prompt to connect Drive
      window.DocumentService.queueUpload(file, user);
      _showDriveConnectPrompt(file.name);
      return;
    }

    // Queue it + auto-start upload
    var meta = window.DocumentService.queueUpload(file, user);
    showToast('main-toast', '☁️ Uploading "' + file.name + '" to Google Drive…', 'dark');
    // Use setTimeout so the card renders before upload starts
    setTimeout(function () { attemptDriveUpload(meta.id); }, 100);

  } catch (e) {
    console.error('[DocumentService] upload error:', e.message);
    showToast('main-toast', '⚠️ Could not open file picker.', 'dark');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '➕ Upload Document'; }
  }
}

function _showDriveConnectPrompt(fileName) {
  showToast('main-toast', '🔗 Connect Google Drive to upload "' + fileName + '"', 'dark');
  var banner = document.getElementById('drive-connect-banner');
  if (banner) {
    banner.style.display = 'flex';
    banner.style.animation = 'pulse 0.6s ease 3';
  }
}

/* ══ _resumePendingUploads – auto-start all queued files after OAuth ═══ */
// Called immediately after connectGoogleDrive() succeeds.
// Finds every pending card (status='pending' or 'error') and starts them.
function _resumePendingUploads() {
  var pending = window.DocumentService.queue.getAll().filter(function (d) {
    return d.status === 'pending' || d.status === 'error';
  });

  if (!pending.length) return;

  // Stagger uploads slightly so progress bars don't conflict visually
  pending.forEach(function (doc, i) {
    setTimeout(function () {
      if (doc.status === 'pending' || doc.status === 'error') {
        showToast('main-toast', '☁️ Uploading "' + doc.name + '" to Google Drive…', 'dark');
        attemptDriveUpload(doc.id);
      }
    }, i * 400); // 400ms between each upload start
  });
}

/* ══ attemptDriveUpload – upload a queued file to Google Drive ════ */
async function attemptDriveUpload(id) {
  var doc = window.DocumentService.queue.get(id);
  if (!doc) {
    showToast('main-toast', '⚠️ File not found in queue.', 'dark');
    return;
  }

  if (!window.AppState || !window.AppState.currentSuite || !window.AppState.currentSuite.id) {
    showToast('main-toast', '⚠️ No active suite. Please join a suite first.', 'dark');
    return;
  }

  // Check Drive connection
  if (!_driveConnected) {
    _showDriveConnectPrompt(doc.name);
    return;
  }

  var suiteId = window.AppState.currentSuite.id;
  var uid     = window.AppState.currentUser ? window.AppState.currentUser.uid : '';

  // Update card status to uploading
  doc.status   = 'uploading';
  doc.progress = 0;
  _updatePendingCard(id, 'uploading', 0);

  // Build FormData
  var formData = new FormData();
  formData.append('file',    doc.file);
  formData.append('suiteId', suiteId);

  // Use XHR for upload progress
  var xhr = new XMLHttpRequest();

  xhr.upload.onprogress = function (e) {
    if (e.lengthComputable) {
      var pct = Math.round((e.loaded / e.total) * 100);
      doc.progress = pct;
      _updatePendingCard(id, 'uploading', pct);
    }
  };

  xhr.onload = function () {
    var result;
    try { result = JSON.parse(xhr.responseText); } catch (e) { result = {}; }

    if (xhr.status === 201 && result.success) {
      doc.status   = 'uploaded';
      doc.progress = 100;
      _updatePendingCard(id, 'uploaded', 100);
      showToast('main-toast', '✅ "' + doc.name + '" uploaded to Google Drive!', 'dark');
      // Remove from queue after a short delay
      setTimeout(function () {
        window.DocumentService.queue.remove(id);
      }, 2000);
      // Refresh the Drive files list (SSE will also update, but refresh for immediate display)
      if (result.file) {
        addDriveFileToList(result.file);
      } else {
        loadSuiteDriveFiles(suiteId);
      }
    } else if (result.error === 'DRIVE_NOT_CONNECTED') {
      doc.status = 'error';
      _updatePendingCard(id, 'error', 0, 'Drive not connected');
      _driveConnected = false;
      _updateDriveStatusBadge();
      _showDriveConnectPrompt(doc.name);
    } else {
      doc.status = 'error';
      var errMsg = (result && result.error) ? result.error : 'Upload failed';
      _updatePendingCard(id, 'error', 0, errMsg);
      showToast('main-toast', '⚠️ Upload failed: ' + errMsg, 'dark');
    }
  };

  xhr.onerror = function () {
    doc.status = 'error';
    _updatePendingCard(id, 'error', 0, 'Network error');
    showToast('main-toast', '⚠️ Upload failed: Network error. Please check your connection.', 'dark');
  };

  xhr.ontimeout = function () {
    doc.status = 'error';
    _updatePendingCard(id, 'error', 0, 'Timed out');
    showToast('main-toast', '⚠️ Upload timed out. Please try again.', 'dark');
  };

  var apiBase = (typeof CONFIG !== 'undefined' && CONFIG.API_BASE) ? CONFIG.API_BASE : '';
  xhr.open('POST', apiBase + '/api/drive/upload');
  xhr.setRequestHeader('X-FS-UID', uid);
  xhr.timeout = 5 * 60 * 1000; // 5 min timeout for large files
  xhr.send(formData);
}

/* ── Update a pending card's visual state ───────────────────────── */
function _updatePendingCard(id, status, progress, errorMsg) {
  var card = document.getElementById('doc-card-' + id);
  if (!card) return;

  var badgeEl    = card.querySelector('.doc-pending-badge');
  var progressEl = card.querySelector('.doc-progress-bar');
  var fillEl     = card.querySelector('.doc-progress-fill');
  var actionBtns = card.querySelectorAll('.doc-action-btn');

  if (status === 'uploading') {
    if (badgeEl)    badgeEl.innerHTML  = '⬆️ Uploading… ' + progress + '%';
    if (progressEl) progressEl.style.display = 'block';
    if (fillEl)     fillEl.style.width = progress + '%';
    // Disable actions while uploading
    actionBtns.forEach(function (b) { b.disabled = true; });

  } else if (status === 'uploaded') {
    if (badgeEl)    { badgeEl.innerHTML = '✅ Uploaded to Drive'; badgeEl.style.background = '#d4edda'; badgeEl.style.color = '#155724'; }
    if (progressEl) progressEl.style.display = 'none';
    if (fillEl)     fillEl.style.width = '100%';
    actionBtns.forEach(function (b) { b.disabled = false; });

  } else if (status === 'error') {
    if (badgeEl)    { badgeEl.innerHTML = '❌ ' + (errorMsg || 'Upload failed'); badgeEl.style.background = '#f8d7da'; badgeEl.style.color = '#721c24'; }
    if (progressEl) progressEl.style.display = 'none';
    // Re-enable retry
    var uploadBtn = card.querySelector('.doc-action-upload');
    if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.textContent = '🔄 Retry'; }
  }
}

/* ══ renderPendingDocuments – renders the upload queue ══════════ */
function renderPendingDocuments() {
  var list    = document.getElementById('pending-docs-list');
  var emptyEl = document.getElementById('pending-docs-empty');
  if (!list) return;

  var docs = window.DocumentService.queue.getAll();

  // Remove existing pending cards only (not Drive file cards)
  var pendingCards = list.querySelectorAll('.doc-pending-card');
  pendingCards.forEach(function (c) { c.remove(); });

  if (!docs.length) {
    // Only show empty state if there are also no Drive files
    var driveCards = list.querySelectorAll('.drive-file-card');
    if (emptyEl) emptyEl.style.display = driveCards.length ? 'none' : 'block';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';

  docs.forEach(function (doc) {
    var card = document.createElement('div');
    card.className = 'doc-pending-card';
    card.id        = 'doc-card-' + doc.id;

    var statusBadge   = '⏳ Pending Google Drive Upload';
    var progressHtml  = '<div class="doc-progress-bar" style="display:none;"><div class="doc-progress-fill"></div></div>';
    var uploadDisabled = '';

    if (doc.status === 'uploading') {
      statusBadge  = '⬆️ Uploading… ' + doc.progress + '%';
      progressHtml = '<div class="doc-progress-bar"><div class="doc-progress-fill" style="width:' + doc.progress + '%;"></div></div>';
      uploadDisabled = ' disabled';
    } else if (doc.status === 'uploaded') {
      statusBadge  = '✅ Uploaded to Drive';
    } else if (doc.status === 'error') {
      statusBadge  = '❌ Upload failed – click Retry';
    }

    card.innerHTML =
      '<div class="doc-pending-icon">' + doc.icon() + '</div>' +
      '<div class="doc-pending-info">' +
        '<div class="doc-pending-name" title="' + escapeHtml(doc.name) + '">' + escapeHtml(doc.name) + '</div>' +
        '<div class="doc-pending-meta">' + doc.formattedSize() + ' · ' + doc.formattedTime() + '</div>' +
        '<div class="doc-pending-meta">Selected by: ' + escapeHtml(doc.selectedBy) + '</div>' +
        progressHtml +
        '<div class="doc-pending-badge">' + statusBadge + '</div>' +
      '</div>' +
      '<div class="doc-pending-actions">' +
        '<button class="doc-action-btn primary" onclick="previewPendingDocument(\'' + doc.id + '\')" title="Preview locally">👁️</button>' +
        '<button class="doc-action-btn doc-action-upload" onclick="attemptDriveUpload(\'' + doc.id + '\')" title="Upload to Drive"' + uploadDisabled + '>☁️</button>' +
        '<button class="doc-action-btn danger" onclick="removePendingDocument(\'' + doc.id + '\')" title="Remove">🗑️</button>' +
      '</div>';

    list.appendChild(card);
  });
}

function previewPendingDocument(id) {
  var doc = window.DocumentService.queue.get(id);
  if (doc) window.DocumentService.previewDocument(doc);
  else showToast('main-toast', '⚠️ Document not found.', 'dark');
}

function removePendingDocument(id) {
  var card = document.getElementById('doc-card-' + id);
  if (card) {
    card.style.transition = 'opacity 0.25s, transform 0.25s';
    card.style.opacity    = '0';
    card.style.transform  = 'translateX(-12px)';
    setTimeout(function () { window.DocumentService.queue.remove(id); }, 250);
  } else {
    window.DocumentService.queue.remove(id);
  }
}

/* ══ Drive Files List – per-suite isolated storage ═══════════════
   ARCHITECTURE: Every cached file list is keyed by suiteId.
   Switching suites clears ALL global state immediately.
   ════════════════════════════════════════════════════════════════ */

// Per-suite caches — keyed by suiteId
var _driveFilesBySuite    = {};  // suiteId → [file, ...]
var _driveRegistryBySuite = {};  // suiteId → { id: file, ... }
var _activeSuiteId        = null; // currently displayed suite

// Convenience getters for the active suite
function _activeCache()    { return _driveFilesBySuite[_activeSuiteId]    || []; }
function _activeRegistry() { return _driveRegistryBySuite[_activeSuiteId] || {}; }

/**
 * Call this IMMEDIATELY when switching suites (before loading new files).
 * Clears all Drive state: cache, registry, rendered cards, upload queue, viewer.
 */
function clearSuiteDocState() {
  // Update active suite tracker
  _activeSuiteId = (window.AppState && window.AppState.currentSuite)
    ? window.AppState.currentSuite.id
    : null;

  // Clear rendered Drive file cards immediately (no stale data flicker)
  renderDriveFiles([]);

  // Clear upload queue (pending uploads belong to old suite)
  if (window.DocumentService && window.DocumentService.queue) {
    window.DocumentService.queue.clear();
  }

  // Reset viewer to placeholder
  _resetDocViewer();
}

/** Wipe the document viewer back to its default placeholder state */
function _resetDocViewer() {
  ['drive-embed-viewer','drive-img-viewer','drive-video-viewer','drive-audio-viewer','drive-file-actions']
    .forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
  var placeholder = document.getElementById('doc-viewer-placeholder');
  if (placeholder) { placeholder.style.display = 'block'; placeholder.innerHTML = ''; }
  var iconEl = document.getElementById('doc-type-icon');
  var nameEl = document.getElementById('doc-file-name');
  var metaEl = document.getElementById('doc-file-meta');
  if (iconEl) iconEl.textContent = '📄';
  if (nameEl) nameEl.textContent = 'Select a document';
  if (metaEl) metaEl.textContent = '';
}

/**
 * Fetch Drive files for a specific suite and render them.
 * Includes race-condition protection: if the suite changes while the
 * fetch is in-flight, the stale response is silently discarded.
 */
async function loadSuiteDriveFiles(suiteId) {
  if (!suiteId) return;

  // Mark this suite as active and immediately clear old data
  _activeSuiteId = suiteId;
  if (!_driveFilesBySuite[suiteId])    _driveFilesBySuite[suiteId]    = [];
  if (!_driveRegistryBySuite[suiteId]) _driveRegistryBySuite[suiteId] = {};
  renderDriveFiles([]); // clear stale cards instantly

  try {
    var data = await API.getDriveFiles(suiteId);

    // Race-condition guard: ignore if the user switched suites during the fetch
    if (_activeSuiteId !== suiteId) {
      console.log('[DocumentService] Suite changed during fetch, discarding stale response for', suiteId);
      return;
    }

    if (data && data.success && Array.isArray(data.files)) {
      _driveFilesBySuite[suiteId] = data.files;
      // Build registry for this suite
      var reg = {};
      data.files.forEach(function (f) { reg[f.id] = f; });
      _driveRegistryBySuite[suiteId] = reg;
      renderDriveFiles(data.files);
    }
  } catch (e) {
    console.warn('[DocumentService] loadSuiteDriveFiles error:', e.message);
  }
}

/* Render Drive files into #pending-docs-list alongside pending cards */
function renderDriveFiles(files) {
  var list    = document.getElementById('pending-docs-list');
  var emptyEl = document.getElementById('pending-docs-empty');
  if (!list) return;

  // Remove existing drive file cards (will re-render fresh)
  var existing = list.querySelectorAll('.drive-file-card');
  existing.forEach(function (c) { c.remove(); });

  if (!files || !files.length) {
    var pendingCards = list.querySelectorAll('.doc-pending-card');
    if (emptyEl) emptyEl.style.display = pendingCards.length ? 'none' : 'block';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';

  var suiteId  = (window.AppState && window.AppState.currentSuite) ? window.AppState.currentSuite.id : '';
  var uid      = (window.AppState && window.AppState.currentUser)  ? window.AppState.currentUser.uid : '';
  var ownerUid = (window.AppState && window.AppState.currentSuite) ? window.AppState.currentSuite.ownerUid : '';

  files.forEach(function (file) {
    // Register file in the per-suite registry (not a global registry)
    if (suiteId) {
      if (!_driveRegistryBySuite[suiteId]) _driveRegistryBySuite[suiteId] = {};
      _driveRegistryBySuite[suiteId][file.id] = file;
    }

    var card = document.createElement('div');
    card.className       = 'drive-file-card doc-pending-card';
    card.id              = 'drive-file-' + file.id;
    card.dataset.fileId  = file.id;
    card.dataset.driveId = file.driveFileId || '';

    var icon      = _getDriveFileIcon(file.mimeType, file.fileName);
    var sizeStr   = _formatFileSize(file.fileSize);
    var dateStr   = _formatDate(file.uploadedAt);
    var canDelete = (file.ownerUid === uid || uid === ownerUid);
    var mimeLabel = file.mimeType ? (file.mimeType.split('/')[1] || file.mimeType) : 'file';

    card.innerHTML =
      '<div class="doc-pending-icon">' + icon + '</div>' +
      '<div class="doc-pending-info">' +
        '<div class="doc-pending-name" title="' + escapeHtml(file.fileName || '') + '">' + escapeHtml(file.fileName || 'Untitled') + '</div>' +
        '<div class="doc-pending-meta">' + sizeStr + ' · ' + escapeHtml(mimeLabel) + ' · ' + dateStr + '</div>' +
        '<div class="doc-pending-meta">Uploaded by: ' + escapeHtml(file.uploadedByName || 'Unknown') + '</div>' +
        '<div class="doc-pending-badge" style="background:#d4edda;color:#155724;">☁️ Google Drive</div>' +
      '</div>' +
      '<div class="doc-pending-actions">' +
        '<button class="doc-action-btn primary" onclick="openDriveFileById(\'' + escapeHtml(file.id) + '\')" title="View">👁️</button>' +
        '<a class="doc-action-btn" href="' + escapeHtml(file.driveDownloadLink || file.driveWebViewLink || '#') + '" target="_blank" title="Download" style="display:flex;align-items:center;justify-content:center;text-decoration:none;">⬇️</a>' +
        (canDelete ? '<button class="doc-action-btn danger" onclick="deleteDriveFile(\'' + escapeHtml(file.id) + '\',\'' + escapeHtml(suiteId) + '\')" title="Delete">🗑️</button>' : '') +
      '</div>';

    list.appendChild(card);
  });
}

/* Add a single new Drive file to the list (from SSE event)
   ISOLATION: only adds the file if its suiteId matches the ACTIVE suite.
   Prevents files from Suite A appearing in Suite B's view. */
function addDriveFileToList(file) {
  if (!file || !file.id) return;

  // ── Suite isolation guard ──────────────────────────────────────────
  var activeSuite = window.AppState && window.AppState.currentSuite;
  if (!activeSuite || !activeSuite.id) return; // no active suite
  if (file.suiteId && file.suiteId !== activeSuite.id) {
    // File belongs to a different suite — silently ignore
    console.log('[DocumentService] SSE file_added ignored: belongs to suite', file.suiteId, 'not active', activeSuite.id);
    return;
  }
  // ──────────────────────────────────────────────────────────────────

  // Avoid duplicates
  var existing = document.getElementById('drive-file-' + file.id);
  if (existing) return;

  // Add to the per-suite cache
  var suiteId = activeSuite.id;
  if (!_driveFilesBySuite[suiteId])    _driveFilesBySuite[suiteId]    = [];
  if (!_driveRegistryBySuite[suiteId]) _driveRegistryBySuite[suiteId] = {};
  _driveFilesBySuite[suiteId].unshift(file);
  _driveRegistryBySuite[suiteId][file.id] = file;

  renderDriveFiles(_driveFilesBySuite[suiteId]);

  // Flash new-file highlight
  setTimeout(function () {
    var card = document.getElementById('drive-file-' + file.id);
    if (card) {
      card.style.animation = 'slideInUp 0.4s ease';
      card.style.border    = '1.5px solid var(--c-green)';
      setTimeout(function () { card.style.border = ''; }, 3000);
    }
  }, 100);
}

/* Remove a Drive file card from the list (from SSE event)
   ISOLATION: only removes from the active suite's cache. */
function removeDriveFileFromList(fileId) {
  // ── Suite isolation guard ──────────────────────────────────────────
  var activeSuite = window.AppState && window.AppState.currentSuite;
  if (!activeSuite || !activeSuite.id) return;
  var suiteId = activeSuite.id;
  // ──────────────────────────────────────────────────────────────────

  if (_driveFilesBySuite[suiteId]) {
    _driveFilesBySuite[suiteId] = _driveFilesBySuite[suiteId].filter(function (f) { return f.id !== fileId; });
  }
  if (_driveRegistryBySuite[suiteId]) {
    delete _driveRegistryBySuite[suiteId][fileId];
  }

  var card = document.getElementById('drive-file-' + fileId);
  if (card) {
    card.style.transition = 'opacity 0.3s, transform 0.3s';
    card.style.opacity    = '0';
    card.style.transform  = 'translateX(-20px)';
    setTimeout(function () {
      card.remove();
      var list = document.getElementById('pending-docs-list');
      if (list && !list.querySelector('.drive-file-card, .doc-pending-card')) {
        var emptyEl = document.getElementById('pending-docs-empty');
        if (emptyEl) emptyEl.style.display = 'block';
      }
    }, 320);
  }
}

/* ══ openDriveFileById – safe entry-point called by onclick ════════ */
// Looks up the file from the active suite's registry.
function openDriveFileById(fileId) {
  var registry = _activeRegistry();
  var file = registry[fileId];
  if (!file) {
    showToast('main-toast', '⚠️ File not found. Try refreshing.', 'dark');
    return;
  }
  openDriveFileViewer(file);
}

/* ══ openDriveFileViewer – embedded viewer in existing doc-viewer ═ */
function openDriveFileViewer(file) {
  // Accept both plain objects and JSON strings
  if (typeof file === 'string') {
    try { file = JSON.parse(file); } catch (e) {
      showToast('main-toast', '⚠️ Could not open file.', 'dark');
      return;
    }
  }
  if (!file) { showToast('main-toast', '⚠️ File data missing.', 'dark'); return; }

  // Switch to docs state to show the viewer
  if (typeof setWSState === 'function') setWSState('docs');

  var iconEl        = document.getElementById('doc-type-icon');
  var nameEl        = document.getElementById('doc-file-name');
  var metaEl        = document.getElementById('doc-file-meta');
  var placeholder   = document.getElementById('doc-viewer-placeholder');
  var docViewer     = document.getElementById('doc-viewer-container');

  var mimeType = (file.mimeType || '').toLowerCase();
  var icon     = _getDriveFileIcon(mimeType, file.fileName);

  if (iconEl) iconEl.textContent = icon;
  if (nameEl) nameEl.textContent = file.fileName || 'Document';
  if (metaEl) metaEl.textContent =
    _formatFileSize(file.fileSize) +
    ' · Uploaded by ' + (file.uploadedByName || 'Unknown') +
    ' · ' + _formatDate(file.uploadedAt);

  // Hide placeholder
  if (placeholder) placeholder.style.display = 'none';

  // Remove any previously injected viewer elements
  ['drive-embed-viewer','drive-img-viewer','drive-video-viewer','drive-audio-viewer','drive-file-actions']
    .forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.remove();
    });

  if (!docViewer) return;

  // Determine viewer type
  var embedUrl = file.driveEmbedUrl || '';

  if (mimeType.includes('image') || ['png','jpg','jpeg','gif','webp','svg','bmp'].some(function (e) { return (file.fileName || '').toLowerCase().endsWith('.' + e); })) {
    // Image: display directly
    var img = document.createElement('img');
    img.id               = 'drive-img-viewer';
    img.src              = file.driveDownloadLink || file.driveWebViewLink || '';
    img.alt              = file.fileName || '';
    img.style.cssText    = 'max-width:100%;max-height:400px;object-fit:contain;border-radius:8px;margin:1rem auto;display:block;';
    docViewer.appendChild(img);

  } else if (mimeType.includes('video')) {
    // Video: native player
    var video = document.createElement('video');
    video.id           = 'drive-video-viewer';
    video.controls     = true;
    video.src          = file.driveDownloadLink || '';
    video.style.cssText = 'width:100%;border-radius:8px;margin:1rem 0;';
    docViewer.appendChild(video);

  } else if (mimeType.includes('audio')) {
    // Audio: native player
    var audio = document.createElement('audio');
    audio.id           = 'drive-audio-viewer';
    audio.controls     = true;
    audio.src          = file.driveDownloadLink || '';
    audio.style.cssText = 'width:100%;margin:1rem 0;';
    docViewer.appendChild(audio);

  } else if (embedUrl) {
    // All other supported types: Google Docs/Drive iframe
    var iframe = document.createElement('iframe');
    iframe.id             = 'drive-embed-viewer';
    iframe.src            = embedUrl;
    iframe.frameBorder    = '0';
    iframe.allowFullscreen = true;
    iframe.style.cssText  = 'width:100%;height:480px;border-radius:8px;border:1.5px solid var(--c-divider);margin:1rem 0;';
    iframe.title          = file.fileName || 'Document';
    docViewer.appendChild(iframe);

  } else {
    // Unsupported embed — restore placeholder with a download prompt
    if (placeholder) {
      placeholder.style.display = 'block';
      placeholder.innerHTML =
        '<div style="font-size:2rem;margin-bottom:0.5rem;">' + icon + '</div>' +
        '<div style="font-weight:600;color:var(--c-charcoal);margin-bottom:0.4rem;">' + escapeHtml(file.fileName || 'File') + '</div>' +
        '<div style="font-size:0.82rem;color:var(--c-slate);margin-bottom:0.8rem;">Preview not available for this file type.</div>' +
        '<a href="' + escapeHtml(file.driveDownloadLink || file.driveWebViewLink || '#') + '" target="_blank" class="btn-primary" style="font-size:0.85rem;text-decoration:none;">⬇️ Download File</a>';
    }
  }

  // Always show action buttons below the viewer
  var actions = document.createElement('div');
  actions.id            = 'drive-file-actions';
  actions.style.cssText = 'display:flex;gap:0.6rem;margin-top:0.8rem;justify-content:center;flex-wrap:wrap;';
  actions.innerHTML =
    '<a href="' + escapeHtml(file.driveWebViewLink || '#') + '" target="_blank" class="btn-outline" style="font-size:0.82rem;">🔗 Open in Drive</a>' +
    '<a href="' + escapeHtml(file.driveDownloadLink || file.driveWebViewLink || '#') + '" target="_blank" download class="btn-outline" style="font-size:0.82rem;">⬇️ Download</a>';
  docViewer.appendChild(actions);
}

/* ══ deleteDriveFile ════════════════════════════════════════════ */
async function deleteDriveFile(fileId, suiteId) {
  if (!confirm('Delete this file? It will be removed from Drive and the suite.')) return;

  var card = document.getElementById('drive-file-' + fileId);
  if (card) { card.style.opacity = '0.5'; }

  try {
    var data = await API.deleteDriveFile(fileId, suiteId);
    if (data && data.success) {
      showToast('main-toast', '✅ File deleted.', 'dark');
      removeDriveFileFromList(fileId);
    } else {
      if (card) card.style.opacity = '1';
      showToast('main-toast', '⚠️ ' + (data && data.error ? data.error : 'Could not delete file.'), 'dark');
    }
  } catch (e) {
    if (card) card.style.opacity = '1';
    showToast('main-toast', '⚠️ Delete failed: ' + e.message, 'dark');
  }
}

/* ══ Helper: file icon from MIME ════════════════════════════════ */
function _getDriveFileIcon(mimeType, fileName) {
  var m = (mimeType || '').toLowerCase();
  var n = (fileName  || '').toLowerCase();
  if (m.includes('pdf') || n.endsWith('.pdf'))                                 return '📄';
  if (m.includes('word') || n.match(/\.(doc|docx)$/))                          return '📝';
  if (m.includes('presentation') || n.match(/\.(ppt|pptx)$/))                 return '📊';
  if (m.includes('spreadsheet') || m.includes('csv') || n.match(/\.(xls|xlsx|csv)$/)) return '📈';
  if (m.includes('image') || n.match(/\.(png|jpg|jpeg|gif|webp|svg|bmp)$/))   return '🖼️';
  if (m.includes('video') || n.match(/\.(mp4|mov|avi|mkv)$/))                 return '🎬';
  if (m.includes('audio') || n.match(/\.(mp3|wav|ogg|flac)$/))                return '🎵';
  if (m.includes('zip') || n.match(/\.(zip|rar|7z|tar|gz)$/))                 return '📦';
  if (m.includes('text') || n.match(/\.(txt|md|log|py|js|ts|java|c|cpp|html|css|json|xml|sql)$/)) return '📃';
  return '📎';
}

function _formatFileSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function _formatDate(isoStr) {
  if (!isoStr) return '';
  try {
    return new Date(isoStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return isoStr.slice(0, 10); }
}
