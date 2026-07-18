/* ── screen-share.js – CoLearn Screen Sharing ─────────────────
 *
 * Architecture: event-driven, no polling, no timers.
 *
 * PRESENTER PATH:
 *   startScreenShare() → MediaManager.getDisplayMedia() → Firestore + RTDB write
 *   → RoomManager.join(receiveOnly:false, localStream:screenStream)
 *   → onPeerJoined fires for EVERY viewer that joins later (via RTDB child_added)
 *   → connectToPeer(viewer) → offer with screen tracks → stream flows to viewer.
 *
 * VIEWER PATH (event-driven, no race condition):
 *   _listenForActiveSS() watches RTDB screenShare/active.
 *   When presenter is detected → RoomManager.join(receiveOnly:TRUE, localStream:null)
 *   → viewer announces presence in screenSignaling.
 *   → presenter's onPeerJoined fires (persistent child_added listener) → connectToPeer(viewer).
 *   → offer with screen stream sent → viewer answers → _ssOnTrack fires → video shown.
 *
 * WHY receiveOnly:TRUE for viewers:
 *   Without this flag, both presenter AND viewer call connectToPeer() on each other
 *   simultaneously → offer collision → non-deterministic result. With receiveOnly,
 *   only the presenter (who has the stream) initiates — the viewer just responds.
 *
 * LATE JOIN: A user who enters the suite while sharing is active goes through the
 *   same viewer path above. No special handling needed.
 *
 * BROWSER REFRESH: initScreenShare() → _listenForActiveSS() → RTDB has value →
 *   viewer join → offer from presenter → stream restored automatically.
 *
 * Public API (module-scope):
 *   initScreenShare(suiteId, userId, userName)  – called from initWorkspace
 *   startScreenShare()                          – called from taskbar button
 *   stopScreenShare()                           – called from Stop button / stream end
 *   cleanupScreenShare()                        – called from leaveSuite
 *
 * Dependencies: webrtc-manager.js (RoomManager, MediaManager), firebase-client.js
 */

/* ── Module state ────────────────────────────────────────────── */
var _ssSuiteId      = null;
var _ssUserId       = null;
var _ssUserName     = null;
var _ssStream       = null;   // presenter's MediaStream
var _ssRoom         = null;   // RoomManager room handle (presenter OR viewer)
var _ssRtdbRef      = null;   // RTDB ref for onDisconnect cleanup
var _ssRtdbListener = null;   // the 'value' listener ref for cleanup
var _ssInitialised  = false;
var _ssIsPresenting = false;

/* ── Public: initScreenShare ─────────────────────────────────── */
function initScreenShare(suiteId, userId, userName) {
  _ssSuiteId     = suiteId;
  _ssUserId      = userId;
  _ssUserName    = userName;
  _ssInitialised = true;
  _listenForActiveSS();
  console.info('[ScreenShare] Initialised — suite=' + suiteId + ' user=' + userId.slice(0,6));
}

/* ── Public: startScreenShare ────────────────────────────────── */
async function startScreenShare() {
  if (!_ssInitialised) {
    showToast('main-toast', '⚠️ Screen share not ready.', 'dark');
    return;
  }
  if (_ssIsPresenting) {
    showToast('main-toast', '📺 You are already sharing.', 'dark');
    return;
  }

  // ── Check if another presenter is active (Firestore) ──────
  if (window.fsDb) {
    try {
      var doc = await window.fsDb.collection('screenSharing').doc(_ssSuiteId).get();
      if (doc.exists && doc.data().isSharing && doc.data().presenterUid !== _ssUserId) {
        var pName = doc.data().presenterName || 'Someone';
        console.info('[ScreenShare] Suite busy — presenter:', pName);
        var busyEl = document.getElementById('ss-busy-presenter');
        if (busyEl) busyEl.textContent = pName;
        if (typeof openModal === 'function') openModal('modal-screen-share-busy');
        return;
      }
    } catch (e) {
      console.warn('[ScreenShare] Firestore busy-check error:', e.message);
    }
  }

  // ── Acquire screen stream ──────────────────────────────────
  console.info('[ScreenShare] Requesting display media…');
  _ssStream = await MediaManager.getDisplayMedia();
  if (!_ssStream) {
    console.info('[ScreenShare] Display media cancelled or denied.');
    return;
  }
  console.info('[ScreenShare] ✅ Screen stream acquired.');

  _ssIsPresenting = true;
  _ssUpdateBtn(true);

  // ── Write to Firestore (single-presenter enforcement) ──────
  if (window.fsDb) {
    try {
      await window.fsDb.collection('screenSharing').doc(_ssSuiteId).set({
        isSharing:     true,
        presenterUid:  _ssUserId,
        presenterName: _ssUserName,
        startedAt:     firebase.firestore.FieldValue.serverTimestamp(),
        suiteId:       _ssSuiteId,
      });
      console.info('[ScreenShare] Firestore screenSharing doc written.');
    } catch (e) {
      console.warn('[ScreenShare] Firestore write error:', e.message);
    }
  }

  // ── Write to RTDB (viewers listen to this path) ────────────
  if (window.fsRtdb) {
    try {
      _ssRtdbRef = window.fsRtdb.ref('suites/' + _ssSuiteId + '/screenShare/active');
      await _ssRtdbRef.set({
        presenterUid:  _ssUserId,
        presenterName: _ssUserName,
        startedAt:     Date.now(),
      });
      _ssRtdbRef.onDisconnect().remove();
      console.info('[ScreenShare] RTDB active node written.');
    } catch (e) {
      console.warn('[ScreenShare] RTDB write error:', e.message);
    }
  }

  // ── Join signaling room as ACTIVE presenter ────────────────
  // receiveOnly:false → this peer WILL call connectToPeer() for every viewer
  // that joins via onPeerJoined (which uses a persistent child_added listener).
  // Late-joining viewers are handled automatically — no delays, no polling.
  console.info('[ScreenShare] Joining screenSignaling as presenter (active, will initiate offers)…');
  _ssRoom = await RoomManager.join({
    roomPath:    'suites/' + _ssSuiteId + '/screenSignaling',
    myUid:       _ssUserId,
    myName:      _ssUserName,
    localStream: _ssStream,
    receiveOnly: false,    // presenter always initiates
    onTrack:     function(peerId, stream) {
      // Presenter doesn't need to display received tracks
      console.info('[ScreenShare] Presenter received track from', peerId.slice(0,6), '(ignored)');
    },
    onPeerLeft: function(peerId) {
      console.info('[ScreenShare] Viewer left:', peerId.slice(0,6));
    },
  });

  if (!_ssRoom) {
    console.warn('[ScreenShare] RoomManager.join returned null.');
  } else {
    console.info('[ScreenShare] ✅ Presenter joined screenSignaling. Waiting for viewers…');
  }

  // ── Show presenter overlay ─────────────────────────────────
  _ssShowOverlay(true, _ssUserName, true);

  // ── Auto-stop when stream ends (user clicks Stop Sharing in browser UI) ──
  var vt = _ssStream.getVideoTracks()[0];
  if (vt) {
    vt.onended = function() {
      console.info('[ScreenShare] Stream track ended — stopping share.');
      stopScreenShare();
    };
  }

  document.addEventListener('visibilitychange', _ssOnVisibilityChange);
  console.info('[ScreenShare] ✅ Screen sharing started.');
}

/* ── Public: stopScreenShare ─────────────────────────────────── */
async function stopScreenShare() {
  if (!_ssIsPresenting && !_ssStream) {
    _ssShowOverlay(false);
    return;
  }

  console.info('[ScreenShare] Stopping screen share…');
  _ssIsPresenting = false;
  _ssUpdateBtn(false);

  MediaManager.stopStream(_ssStream);
  _ssStream = null;

  // Remove RTDB active node → all viewers' 'value' listeners fire with null
  if (_ssRtdbRef) {
    try { await _ssRtdbRef.remove(); } catch (_) {}
    _ssRtdbRef = null;
  }

  // Remove Firestore doc
  if (window.fsDb) {
    try { await window.fsDb.collection('screenSharing').doc(_ssSuiteId).delete(); } catch (_) {}
  }

  // Leave signaling room
  if (_ssRoom) {
    try { await _ssRoom.leave(); } catch (_) {}
    _ssRoom = null;
  }

  _ssShowOverlay(false);
  document.removeEventListener('visibilitychange', _ssOnVisibilityChange);
  console.info('[ScreenShare] ✅ Screen sharing stopped.');
}

/* ── Public: cleanupScreenShare ──────────────────────────────── */
async function cleanupScreenShare() {
  console.info('[ScreenShare] Cleanup (suite leave).');

  // Stop RTDB listener
  if (_ssRtdbListener && window.fsRtdb && _ssSuiteId) {
    try {
      window.fsRtdb.ref('suites/' + _ssSuiteId + '/screenShare/active').off('value', _ssRtdbListener);
    } catch (_) {}
    _ssRtdbListener = null;
  }

  if (_ssIsPresenting) await stopScreenShare();
  else if (_ssRoom) {
    // Viewer room cleanup
    try { await _ssRoom.leave(); } catch (_) {}
    _ssRoom = null;
  }

  _ssShowOverlay(false);
  _ssInitialised = false;
}

/* ── Internal: RTDB listener for active screen share ────────── */
function _listenForActiveSS() {
  if (!window.fsRtdb) {
    console.warn('[ScreenShare] RTDB not available — viewer listening disabled.');
    return;
  }

  var ref = window.fsRtdb.ref('suites/' + _ssSuiteId + '/screenShare/active');

  _ssRtdbListener = ref.on('value', function(snap) {
    var data = snap.val();

    if (data && data.presenterUid && data.presenterUid !== _ssUserId) {
      // ── A different user is presenting ──────────────────────
      console.info('[ScreenShare] Active presenter detected:', data.presenterName, '(' + data.presenterUid.slice(0,6) + ')');
      _ssShowOverlay(true, data.presenterName, false);

      if (!_ssRoom) {
        // Join signaling room as VIEWER (receiveOnly:true).
        //
        // KEY FIX: receiveOnly prevents the viewer from calling connectToPeer()
        // when it sees the presenter in the room. Only the presenter (not receiveOnly)
        // calls connectToPeer() via its persistent onPeerJoined listener.
        //
        // Flow:
        //   viewer announces presence in screenSignaling
        //   → presenter's onPeerJoined(viewer) fires (child_added, already listening)
        //   → presenter calls connectToPeer(viewer)
        //   → offer with screen stream sent to viewer
        //   → viewer handles offer, creates answer, sends it
        //   → ICE exchange completes
        //   → _ssOnTrack fires on viewer → screen shown.
        console.info('[ScreenShare] Joining screenSignaling as viewer (receiveOnly:true)…');
        RoomManager.join({
          roomPath:    'suites/' + _ssSuiteId + '/screenSignaling',
          myUid:       _ssUserId,
          myName:      _ssUserName,
          localStream: null,
          receiveOnly: true,   // ← THE FIX: viewers never initiate
          onTrack:     _ssOnTrack,
          onPeerLeft:  function(peerId) {
            console.info('[ScreenShare] Presenter left:', peerId.slice(0,6));
          },
        }).then(function(r) {
          _ssRoom = r;
          if (r) {
            console.info('[ScreenShare] ✅ Viewer joined screenSignaling. Waiting for presenter offer…');
          } else {
            console.warn('[ScreenShare] Viewer join returned null.');
          }
        }).catch(function(e) {
          console.error('[ScreenShare] Viewer join error:', e.message);
        });
      } else {
        console.info('[ScreenShare] Viewer already in signaling room — skipping re-join.');
      }

    } else if (!data && !_ssIsPresenting) {
      // ── Screen share ended (presenter left or stopped) ──────
      console.info('[ScreenShare] Active share ended — hiding overlay.');
      _ssShowOverlay(false);
      if (_ssRoom) {
        _ssRoom.leave().catch(function() {});
        _ssRoom = null;
      }
    }
  });
}

/* ── Track received (viewer side) ────────────────────────────── */
function _ssOnTrack(peerId, stream) {
  console.info('[ScreenShare] ✅ Screen stream received from', peerId.slice(0,6));
  var video = document.getElementById('screen-share-video');
  if (video) {
    video.srcObject = stream;
    video.play().catch(function(e) {
      console.warn('[ScreenShare] Autoplay blocked:', e.name, '— waiting for user gesture.');
    });
  }
  var track = stream.getVideoTracks()[0];
  if (track) {
    var s = track.getSettings();
    var resEl = document.getElementById('ss-resolution');
    if (resEl && s.width) resEl.textContent = s.width + 'x' + s.height;
    console.info('[ScreenShare] Screen resolution:', s.width + 'x' + s.height);
  }
}

/* ── Overlay UI ──────────────────────────────────────────────── */
function _ssShowOverlay(show, presenterName, isOwner) {
  var overlay = document.getElementById('screen-share-overlay');
  if (!overlay) return;
  overlay.classList.toggle('hidden', !show);

  if (show) {
    var nameEl = document.getElementById('ss-presenter-name');
    if (nameEl) nameEl.textContent = presenterName || 'Screen Share';
    var stopBtn = document.getElementById('btn-stop-screen-share');
    if (stopBtn) stopBtn.style.display = isOwner ? 'flex' : 'none';
  } else {
    var video = document.getElementById('screen-share-video');
    if (video) { try { video.srcObject = null; } catch (_) {} }
    var resEl = document.getElementById('ss-resolution');
    if (resEl) resEl.textContent = '';
  }
}

/* ── Taskbar button state ─────────────────────────────────────── */
function _ssUpdateBtn(active) {
  var btn = document.getElementById('btn-screen-share');
  if (!btn) return;
  if (active) {
    btn.classList.add('active-tool');
    btn.innerHTML = '<span class="taskbar-icon">📺</span>Sharing';
  } else {
    btn.classList.remove('active-tool');
    btn.innerHTML = '<span class="taskbar-icon">📺</span>Screen';
  }
}

/* ── Auto-stop when tab is hidden ────────────────────────────── */
function _ssOnVisibilityChange() {
  if (document.visibilityState === 'hidden' && _ssIsPresenting) {
    console.info('[ScreenShare] Tab hidden — stopping share.');
    stopScreenShare();
  }
}
