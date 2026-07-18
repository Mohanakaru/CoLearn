/* ── video-call.js – CoLearn Video Call ───────────────────────
 *
 * Architecture: passive-first.
 *
 * Every suite member joins the videoSignaling RTDB room immediately
 * at initVideoCall() with receiveOnly=true (no camera, no mic).
 * This means they can receive incoming offers the moment any other
 * participant starts a call — no button click required.
 *
 * When the user clicks the Video button (joinVideoCall()):
 *  1. Camera + mic stream acquired via MediaManager (progressive fallback).
 *  2. Passive room is left (removes passive presence briefly).
 *  3. Active room is joined with the real stream.
 *  4. RoomManager.onPeerJoined fires for every passive peer already in the
 *     room → connectToPeer() is called → offer + media stream sent.
 *
 * Remote video tiles appear automatically whenever onTrack fires —
 * regardless of whether the local user has clicked "Join Video".
 * The video overlay opens automatically on the first remote track.
 *
 * Public API (module-scope, called from workspace.js / index.html):
 *   initVideoCall(suiteId, userId, userName)  – passive join on suite enter
 *   joinVideoCall()                           – acquire camera, upgrade to active
 *   leaveVideoCall()                          – leave active call, keep passive
 *   toggleVideoMic()                          – mute/unmute audio
 *   toggleVideoCamera()                       – camera on/off
 *   pinParticipant(peerId)                    – fullscreen/pin tile
 *   cleanupVideoCall()                        – full teardown on suite leave
 *
 * RTDB signaling path: suites/{suiteId}/videoSignaling
 * Dependencies: webrtc-manager.js (RoomManager, MediaManager, etc.)
 */

/* ── Module state ────────────────────────────────────────────── */
let _vcSuiteId      = null;
let _vcUserId       = null;
let _vcUserName     = null;
let _vcLocalStream  = null;

// _vcPassiveRoom: receive-only room joined at suite init.
// Gives every member the ability to receive video without pressing any button.
let _vcPassiveRoom  = null;

// _vcRoom: active (sending) room, created when user clicks Video button.
let _vcRoom         = null;

let _vcParticipants = {};  // { peerId: { stream, name } }
let _vcInitialised  = false;
let _vcInCall       = false;
let _vcMicMuted     = false;
let _vcCameraOff    = false;
let _vcPinnedPeer   = null;

/* ── Public: initVideoCall ───────────────────────────────────── */
/**
 * Called from initWorkspace() immediately after entering a suite.
 * Stores identifiers and joins the signaling room passively so that
 * incoming video offers can be received without any user interaction.
 */
function initVideoCall(suiteId, userId, userName) {
  if (_vcInitialised && _vcSuiteId === suiteId) {
    console.info('[VideoCall] Already initialised for suite', suiteId);
    return;
  }
  _vcSuiteId     = suiteId;
  _vcUserId      = userId;
  _vcUserName    = userName;
  _vcInitialised = true;
  console.info(`[VideoCall] init — suite=${suiteId} user=${userId.slice(0,6)}`);

  // Passive join: receive-only, no camera. Allows receiving offers automatically.
  _joinVideoSignalingPassively();
}

/* ── Internal: passive join ──────────────────────────────────── */
async function _joinVideoSignalingPassively() {
  if (_vcPassiveRoom) {
    console.info('[VideoCall] Passive room already active — skipping duplicate join.');
    return;
  }
  if (!window.fsRtdb) {
    console.warn('[VideoCall] RTDB not available — passive join deferred.');
    return;
  }

  const path = 'suites/' + _vcSuiteId + '/videoSignaling';
  console.info(`[VideoCall] Joining videoSignaling passively (receiveOnly) — path=${path}`);

  try {
    _vcPassiveRoom = await RoomManager.join({
      roomPath:    path,
      myUid:       _vcUserId,
      myName:      _vcUserName,
      localStream: null,         // no camera yet
      receiveOnly: true,         // never initiate offers, just respond
      onTrack:     _vcOnTrackPassive,
      onPeerLeft:  _vcOnPeerLeft,
    });

    if (_vcPassiveRoom) {
      console.info('[VideoCall] ✅ Passive signaling room joined. Ready to receive video.');
    } else {
      console.warn('[VideoCall] Passive join returned null (RTDB unavailable?).');
    }
  } catch (e) {
    console.error('[VideoCall] Passive join error:', e.message);
  }
}

/* ── Public: joinVideoCall ───────────────────────────────────── */
/**
 * Called when the user explicitly clicks the Video button.
 * Acquires camera + mic, then upgrades from passive to active mode.
 * Sends offers (with video stream) to all peers currently in the room.
 */
async function joinVideoCall() {
  if (!_vcInitialised) {
    showToast('main-toast', '⚠️ Video call not ready yet.', 'dark');
    return;
  }

  // If already in an active call, just show the overlay
  if (_vcInCall) {
    _showVCOverlay(true);
    return;
  }

  const btn = document.getElementById('btn-cam');
  if (btn) btn.classList.add('active-tool');
  _setVCStatus('Requesting camera…');
  _showVCOverlay(true);

  // Acquire camera stream (with progressive constraint fallback)
  _vcLocalStream = await MediaManager.getCameraAndMic();
  if (!_vcLocalStream) {
    _setVCStatus('Camera unavailable');
    if (btn) btn.classList.remove('active-tool');
    _showVCOverlay(false);
    return;
  }

  console.info('[VideoCall] Camera stream acquired. Upgrading to active signaling.');
  _vcMicMuted  = false;
  _vcCameraOff = false;
  _vcInCall    = true;

  // Render local tile immediately
  _renderVCLocalTile();

  // ── Leave passive room → join active room ─────────────────
  // We leave the passive room first so that our re-join (with stream)
  // causes onPeerJoined to fire on all existing passive peers.
  // They are already in the room (passive) and will receive our offer.
  if (_vcPassiveRoom) {
    console.info('[VideoCall] Leaving passive room to upgrade to active…');
    try { await _vcPassiveRoom.leave(); } catch (_) {}
    _vcPassiveRoom = null;
  }

  const path = 'suites/' + _vcSuiteId + '/videoSignaling';
  console.info(`[VideoCall] Joining videoSignaling as ACTIVE sender — path=${path}`);

  _vcRoom = await RoomManager.join({
    roomPath:    path,
    myUid:       _vcUserId,
    myName:      _vcUserName,
    localStream: _vcLocalStream,
    receiveOnly: false,          // active sender: will initiate offers
    onTrack:     _vcOnTrack,
    onPeerLeft:  _vcOnPeerLeft,
  });

  if (!_vcRoom) {
    showToast('main-toast', '❌ Could not join video room.', 'dark');
    await _doLeaveVideoCall();
    return;
  }

  _setVCStatus('In call');
  window.addEventListener('beforeunload', cleanupVideoCall);
  console.info('[VideoCall] ✅ Active video call started.');
}

/* ── Public: leaveVideoCall ──────────────────────────────────── */
async function leaveVideoCall() {
  if (!_vcInCall) {
    _showVCOverlay(false);
    return;
  }
  await _doLeaveVideoCall();

  // Re-join passively so we can still receive future video from others
  _joinVideoSignalingPassively();
}

/* ── Internal: full active-call teardown ─────────────────────── */
async function _doLeaveVideoCall() {
  _vcInCall = false;

  if (_vcRoom) {
    try { await _vcRoom.leave(); } catch (_) {}
    _vcRoom = null;
  }

  MediaManager.stopStream(_vcLocalStream);
  _vcLocalStream = null;

  // Remove all tiles except keep the grid ready for passive reception
  const grid = document.getElementById('vc-grid');
  if (grid) grid.innerHTML = '';
  _vcParticipants = {};
  _vcPinnedPeer   = null;

  _showVCOverlay(false);

  const btn = document.getElementById('btn-cam');
  if (btn) btn.classList.remove('active-tool');

  window.removeEventListener('beforeunload', cleanupVideoCall);
  console.info('[VideoCall] Active call ended.');
}

/* ── Public: toggleVideoMic ──────────────────────────────────── */
function toggleVideoMic() {
  _vcMicMuted = !_vcMicMuted;
  if (_vcLocalStream) {
    _vcLocalStream.getAudioTracks().forEach(t => { t.enabled = !_vcMicMuted; });
  }
  const btn = document.getElementById('vc-btn-mic');
  if (btn) {
    btn.classList.toggle('muted', _vcMicMuted);
    btn.querySelector('span').textContent = _vcMicMuted ? '🔇' : '🎤';
  }
  console.info(`[VideoCall] Mic ${_vcMicMuted ? 'muted' : 'unmuted'}`);
}

/* ── Public: toggleVideoCamera ───────────────────────────────── */
async function toggleVideoCamera() {
  _vcCameraOff = !_vcCameraOff;
  if (_vcLocalStream) {
    _vcLocalStream.getVideoTracks().forEach(t => { t.enabled = !_vcCameraOff; });
  }
  const btn = document.getElementById('vc-btn-camera');
  if (btn) {
    btn.classList.toggle('muted', _vcCameraOff);
    btn.querySelector('span').textContent = _vcCameraOff ? '📷' : '📹';
  }
  _updateVCLocalTile();
  console.info(`[VideoCall] Camera ${_vcCameraOff ? 'off' : 'on'}`);
}

/* ── Public: pinParticipant ──────────────────────────────────── */
function pinParticipant(peerId) {
  if (_vcPinnedPeer === peerId) {
    _vcPinnedPeer = null;
    document.querySelectorAll('.vc-tile').forEach(t => t.classList.remove('pinned'));
    console.info('[VideoCall] Unpinned', peerId.slice(0,6));
  } else {
    _vcPinnedPeer = peerId;
    document.querySelectorAll('.vc-tile').forEach(t => t.classList.remove('pinned'));
    const tile = document.getElementById('vc-tile-' + _vcSafeId(peerId));
    if (tile) tile.classList.add('pinned');
    console.info('[VideoCall] Pinned', peerId.slice(0,6));
  }
}

/* ── Public: cleanupVideoCall ────────────────────────────────── */
async function cleanupVideoCall() {
  console.info('[VideoCall] Full cleanup (suite leave).');

  if (_vcInCall) await _doLeaveVideoCall();

  if (_vcPassiveRoom) {
    try { await _vcPassiveRoom.leave(); } catch (_) {}
    _vcPassiveRoom = null;
  }

  _vcInitialised = false;
  _vcParticipants = {};
}

/* ══════════════════════════════════════════════════════════════
   TRACK HANDLERS
   ══════════════════════════════════════════════════════════════ */

/**
 * Called when a remote video track arrives while we are in PASSIVE mode
 * (i.e. we haven't clicked the Video button yet).
 * Automatically opens the overlay and renders the remote tile — no
 * user interaction required.
 */
function _vcOnTrackPassive(peerId, stream) {
  console.info(`[VideoCall] 📹 PASSIVE onTrack ← ${peerId.slice(0,6)} — auto-showing overlay`);

  if (!_vcParticipants[peerId]) {
    _vcParticipants[peerId] = { stream: null, name: peerId };
  }
  _vcParticipants[peerId].stream = stream;

  // Auto-show the video overlay (viewer mode — no local camera shown)
  _showVCOverlay(true);
  _setVCStatus('Receiving video…');

  const existing = document.getElementById('vc-tile-' + _vcSafeId(peerId));
  if (existing) {
    const v = existing.querySelector('video');
    if (v) { v.srcObject = stream; v.play().catch(() => {}); }
  } else {
    _addVCRemoteTile(peerId, stream);
  }
  _updateVCGridLayout();
}

/**
 * Called when a remote video track arrives while we are in ACTIVE mode
 * (we are already in the call with our own camera).
 */
function _vcOnTrack(peerId, stream) {
  console.info(`[VideoCall] 📹 ACTIVE onTrack ← ${peerId.slice(0,6)}`);

  if (!_vcParticipants[peerId]) {
    _vcParticipants[peerId] = { stream: null, name: peerId };
  }
  _vcParticipants[peerId].stream = stream;

  const existing = document.getElementById('vc-tile-' + _vcSafeId(peerId));
  if (existing) {
    const v = existing.querySelector('video');
    if (v) { v.srcObject = stream; v.play().catch(() => {}); }
  } else {
    _addVCRemoteTile(peerId, stream);
  }
  _updateVCGridLayout();
}

/**
 * Called when any peer leaves (works for both passive and active rooms).
 */
function _vcOnPeerLeft(peerId) {
  console.info(`[VideoCall] Peer left: ${peerId.slice(0,6)}`);
  delete _vcParticipants[peerId];

  const tile = document.getElementById('vc-tile-' + _vcSafeId(peerId));
  if (tile) {
    tile.style.opacity = '0';
    setTimeout(() => {
      tile.remove();
      _updateVCGridLayout();

      // If no remote participants remain and we're just a passive viewer,
      // close the overlay since there's nothing to show.
      const grid = document.getElementById('vc-grid');
      if (grid && grid.querySelectorAll('.vc-tile').length === 0 && !_vcInCall) {
        _showVCOverlay(false);
        _setVCStatus('');
      }
    }, 300);
  }

  if (_vcPinnedPeer === peerId) _vcPinnedPeer = null;
}

/* ══════════════════════════════════════════════════════════════
   TILE RENDERING
   ══════════════════════════════════════════════════════════════ */

function _renderVCLocalTile() {
  const grid = document.getElementById('vc-grid');
  if (!grid) return;
  const existing = document.getElementById('vc-tile-local');
  if (existing) existing.remove();

  const tile = document.createElement('div');
  tile.className = 'vc-tile';
  tile.id = 'vc-tile-local';
  tile.onclick = () => pinParticipant('local');

  if (!_vcCameraOff && _vcLocalStream) {
    const v = document.createElement('video');
    v.autoplay = true;
    v.muted    = true;   // mute local to prevent echo
    v.playsInline = true;
    v.srcObject = _vcLocalStream;
    tile.appendChild(v);
  } else {
    tile.appendChild(_vcMakeAvatar(_vcUserName, 'Camera Off'));
  }

  const lbl = document.createElement('div');
  lbl.className = 'vc-tile-label';
  lbl.textContent = (_vcUserName || 'You') + ' (You)';
  tile.appendChild(lbl);
  grid.appendChild(tile);
  _updateVCGridLayout();
}

function _addVCRemoteTile(peerId, stream) {
  const grid = document.getElementById('vc-grid');
  if (!grid) return;

  const name = (_vcParticipants[peerId] || {}).name || peerId;
  const tile = document.createElement('div');
  tile.className = 'vc-tile';
  tile.id = 'vc-tile-' + _vcSafeId(peerId);
  tile.onclick = () => pinParticipant(peerId);

  const v = document.createElement('video');
  v.autoplay    = true;
  v.playsInline = true;
  v.srcObject   = stream;
  v.play().catch(err => {
    console.warn(`[VideoCall] Autoplay blocked for ${peerId.slice(0,6)}:`, err.name);
  });
  tile.appendChild(v);

  const lbl = document.createElement('div');
  lbl.className = 'vc-tile-label';
  lbl.textContent = name;
  tile.appendChild(lbl);
  grid.appendChild(tile);
  _updateVCGridLayout();
}

function _updateVCLocalTile() {
  const tile = document.getElementById('vc-tile-local');
  if (!tile) return;
  tile.innerHTML = '';

  if (!_vcCameraOff && _vcLocalStream) {
    const v = document.createElement('video');
    v.autoplay = true; v.muted = true; v.playsInline = true;
    v.srcObject = _vcLocalStream;
    tile.appendChild(v);
  } else {
    tile.appendChild(_vcMakeAvatar(_vcUserName, 'Camera Off'));
  }

  const lbl = document.createElement('div');
  lbl.className = 'vc-tile-label';
  lbl.textContent = (_vcUserName || 'You') + ' (You)';
  tile.appendChild(lbl);
}

function _updateVCGridLayout() {
  const grid = document.getElementById('vc-grid');
  if (!grid) return;
  const count = grid.querySelectorAll('.vc-tile').length;
  grid.dataset.count = String(Math.min(count, 9));
  if (_vcInCall) {
    _setVCStatus(count > 1 ? count + ' participants' : 'Just you');
  }
}

/* ── Avatar fallback ─────────────────────────────────────────── */
function _vcMakeAvatar(name, sub) {
  const wrap = document.createElement('div');
  wrap.className = 'vc-avatar-tile';

  const av = document.createElement('div');
  av.className = 'member-avatar';
  av.textContent = (name || '?')[0].toUpperCase();
  wrap.appendChild(av);

  const n = document.createElement('div');
  n.textContent = name || 'Unknown';
  wrap.appendChild(n);

  if (sub) {
    const s = document.createElement('div');
    s.style.cssText = 'font-size:0.7rem;opacity:0.6;';
    s.textContent = sub;
    wrap.appendChild(s);
  }
  return wrap;
}

/* ── UI helpers ──────────────────────────────────────────────── */
function _showVCOverlay(show) {
  const el = document.getElementById('video-call-overlay');
  if (el) el.classList.toggle('hidden', !show);
}

function _setVCStatus(text) {
  const el = document.getElementById('vc-status');
  if (el) el.textContent = text;
}

function _vcSafeId(id) {
  return (id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}
