/* ── voice.js – CoLearn Voice Chat ────────────────────────────
 *
 * Fixed implementation using Perfect Negotiation via RoomManager.
 *
 * Public API (unchanged — workspace.js calls these directly):
 *   initVoice(suiteId, userId, userName)  – async, starts voice session
 *   setVoiceMute(muted)                   – mute/unmute microphone
 *   cleanupVoice()                        – full cleanup on suite leave
 *
 * Internal improvements over original:
 *   • Perfect Negotiation pattern (polite-peer role via lower UID)
 *   • ICE candidate buffering until remoteDescription is set
 *   • Silent audio track fallback when mic is denied
 *   • Autoplay policy recovery (click-anywhere prompt)
 *   • Web Audio API speaking detection
 *   • Connection state monitoring + ICE restart
 *   • Automatic reconnection on network restore
 *   • Prevents double-initialisation with _voiceInitialised guard
 *
 * Dependencies (loaded before this file):
 *   webrtc-manager.js  → RoomManager, MediaManager
 *   firebase-client.js → window.fsRtdb
 */

'use strict';

/* ── Module state ─────────────────────────────────────────────── */
let _voiceSuiteId       = null;
let _voiceUserId        = null;
let _voiceUserName      = null;
let _localStream        = null;     // MediaStream from mic (or silent fallback)
let _silentCtx          = null;     // AudioContext for silent track
let _room               = null;     // { signal, pcm, leave() } from RoomManager
let _audioElements      = {};       // { peerId: HTMLAudioElement }
let _analyserNodes      = {};       // { peerId: { analyser, source, rafId } }
let _voiceInitialised   = false;
let _voiceMuted         = false;
let _pendingAutoplay    = [];       // audio elements blocked by autoplay policy
let _autoplayUnlocked   = false;

/* ── Public: initVoice ───────────────────────────────────────── */
async function initVoice(suiteId, userId, userName) {
  if (_voiceInitialised) {
    console.info('[Voice] Already initialised — skipping double-init.');
    return;
  }

  // Guard against missing RTDB (Firebase not ready yet)
  if (!window.fsRtdb) {
    console.warn('[Voice] Firebase RTDB not available — voice disabled.');
    return;
  }

  _voiceSuiteId   = suiteId;
  _voiceUserId    = userId;
  _voiceUserName  = userName;
  _voiceInitialised = true;
  _voiceMuted     = false;

  console.info(`[Voice] Initialising for suite ${suiteId} as ${userName} (${userId})`);
  _showVoiceStatus('connecting');

  /* 1. Acquire microphone stream */
  _localStream = await MediaManager.getMicrophone();

  if (!_localStream) {
    /* Mic denied / unavailable — use silent track so peer connection
       can still be established and we can receive remote audio. */
    const fallback = MediaManager.createSilentAudioTrack();
    if (fallback) {
      _silentCtx = fallback.ctx;
      const silentStream = new MediaStream([fallback.track]);
      _localStream = silentStream;
      console.info('[Voice] Using silent track fallback (mic denied).');
      _showVoiceStatus('denied');
    } else {
      _showVoiceStatus('unavailable');
      _voiceInitialised = false;
      return;
    }
  } else {
    /* Respect current mute state */
    _localStream.getAudioTracks().forEach(t => { t.enabled = !_voiceMuted; });
    _showVoiceStatus(_voiceMuted ? 'muted' : 'active');
  }

  /* 2. Join room via RoomManager (handles signaling + peer connections) */
  _room = await RoomManager.join({
    roomPath:    `suites/${suiteId}/voiceSignaling`,
    myUid:       userId,
    myName:      userName,
    localStream: _localStream,
    onTrack:     _handleRemoteTrack,
    onPeerLeft:  _handlePeerLeft,
  });

  if (!_room) {
    console.warn('[Voice] RoomManager.join failed.');
    _voiceInitialised = false;
    return;
  }

  /* 3. Autoplay unlock listener */
  _setupAutoplayUnlock();

  /* 4. Cleanup on page leave */
  window.addEventListener('beforeunload', cleanupVoice);

  console.info('[Voice] Session started.');
}

/* ── Public: setVoiceMute ────────────────────────────────────── */
function setVoiceMute(muted) {
  _voiceMuted = muted;

  if (_localStream) {
    _localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }

  /* Update btn-mic appearance */
  const btn = document.getElementById('btn-mic');
  if (btn) {
    if (muted) {
      btn.classList.add('muted');
      btn.innerHTML = '<span class="taskbar-icon">🔇</span>Muted';
    } else {
      btn.classList.remove('muted');
      btn.innerHTML = '<span class="taskbar-icon">🎤</span>Mic';
    }
  }

  _showVoiceStatus(muted ? 'muted' : 'active');
}

/* ── Public: cleanupVoice ────────────────────────────────────── */
function cleanupVoice() {
  if (!_voiceInitialised) return;
  _voiceInitialised = false;

  console.info('[Voice] Cleaning up...');

  /* Leave room (removes presence, closes all peer connections, detaches listeners) */
  if (_room) {
    _room.leave().catch(() => {});
    _room = null;
  }

  /* Stop speaking detection */
  Object.values(_analyserNodes).forEach(({ source, analyser, rafId }) => {
    try { cancelAnimationFrame(rafId); } catch (_) {}
    try { source.disconnect(); } catch (_) {}
    try { analyser.disconnect(); } catch (_) {}
  });
  _analyserNodes = {};

  /* Remove all remote audio elements */
  Object.entries(_audioElements).forEach(([, el]) => {
    try { el.pause(); el.srcObject = null; el.remove(); } catch (_) {}
  });
  _audioElements = {};

  /* Stop local stream */
  MediaManager.stopStream(_localStream);
  _localStream = null;

  /* Close silent AudioContext */
  if (_silentCtx) {
    try { _silentCtx.close(); } catch (_) {}
    _silentCtx = null;
  }

  _pendingAutoplay = [];
  _autoplayUnlocked = false;

  /* Reset UI */
  _showVoiceStatus('idle');

  window.removeEventListener('beforeunload', cleanupVoice);
  console.info('[Voice] Cleanup complete.');
}

/* ── Remote track handler ────────────────────────────────────── */
function _handleRemoteTrack(peerId, stream) {
  console.info(`[Voice] Remote track received from ${peerId}`);

  /* Reuse or create audio element */
  let audio = _audioElements[peerId];
  if (!audio) {
    audio = document.createElement('audio');
    audio.id        = `voice-audio-${peerId}`;
    audio.autoplay  = true;
    audio.controls  = false;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    _audioElements[peerId] = audio;
  }

  audio.srcObject = stream;

  /* Attempt autoplay — handle browser autoplay policy */
  const playPromise = audio.play();
  if (playPromise !== undefined) {
    playPromise.catch(err => {
      if (err.name === 'NotAllowedError') {
        console.warn(`[Voice] Autoplay blocked for ${peerId} — queuing for unlock`);
        _pendingAutoplay.push(audio);
        _showAutoplayPrompt();
      }
    });
  }

  /* Speaking indicator */
  _setupSpeakingDetection(peerId, stream);
}

/* ── Peer left handler ───────────────────────────────────────── */
function _handlePeerLeft(peerId) {
  /* Remove audio element */
  const audio = _audioElements[peerId];
  if (audio) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    delete _audioElements[peerId];
  }

  /* Stop speaking detection */
  const analyserData = _analyserNodes[peerId];
  if (analyserData) {
    cancelAnimationFrame(analyserData.rafId);
    try { analyserData.source.disconnect(); } catch (_) {}
    try { analyserData.analyser.disconnect(); } catch (_) {}
    delete _analyserNodes[peerId];
  }

  /* Clear speaking indicator */
  _setSpeakingIndicator(peerId, false);
}

/* ── Speaking detection (Web Audio API analyser) ─────────────── */
function _setupSpeakingDetection(peerId, stream) {
  /* Clean up previous analyser for this peer */
  if (_analyserNodes[peerId]) {
    cancelAnimationFrame(_analyserNodes[peerId].rafId);
    try { _analyserNodes[peerId].source.disconnect(); } catch (_) {}
  }

  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let isSpeaking = false;

    function check() {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((s, v) => s + v, 0) / data.length;
      const nowSpeaking = avg > 12; // threshold

      if (nowSpeaking !== isSpeaking) {
        isSpeaking = nowSpeaking;
        _setSpeakingIndicator(peerId, isSpeaking);
      }

      _analyserNodes[peerId] = { ...(_analyserNodes[peerId] || {}), rafId: requestAnimationFrame(check) };
    }

    const rafId = requestAnimationFrame(check);
    _analyserNodes[peerId] = { source, analyser, rafId };
  } catch (e) {
    console.warn(`[Voice] Speaking detection failed for ${peerId}:`, e.message);
  }
}

/* ── Speaking indicator UI ───────────────────────────────────── */
function _setSpeakingIndicator(peerId, isSpeaking) {
  /* Find the member card with matching data-uid */
  const card = document.querySelector(`.member-card[data-uid="${CSS.escape(peerId)}"]`);
  if (!card) return;

  if (isSpeaking) {
    card.style.borderColor = '#28a745';
    card.style.boxShadow   = '0 0 0 2px rgba(40,167,69,0.35)';
  } else {
    card.style.borderColor = '';
    card.style.boxShadow   = '';
  }
}

/* ── Voice status in taskbar button ──────────────────────────── */
function _showVoiceStatus(state) {
  const btn = document.getElementById('btn-mic');
  if (!btn) return;

  switch (state) {
    case 'active':
      btn.classList.remove('muted');
      btn.innerHTML = '<span class="taskbar-icon">🎤</span>Mic';
      btn.title = 'Microphone active — click to mute';
      break;
    case 'muted':
      btn.classList.add('muted');
      btn.innerHTML = '<span class="taskbar-icon">🔇</span>Muted';
      btn.title = 'Microphone muted — click to unmute';
      break;
    case 'connecting':
      btn.innerHTML = '<span class="taskbar-icon">⏳</span>Voice…';
      btn.title = 'Connecting to voice…';
      break;
    case 'denied':
      btn.classList.add('muted');
      btn.innerHTML = '<span class="taskbar-icon">🚫</span>No Mic';
      btn.title = 'Microphone access denied — you can hear others but cannot speak';
      break;
    case 'unavailable':
      btn.classList.add('muted');
      btn.innerHTML = '<span class="taskbar-icon">❌</span>No Mic';
      btn.title = 'Microphone not available';
      break;
    case 'idle':
    default:
      btn.classList.remove('muted');
      btn.innerHTML = '<span class="taskbar-icon">🎤</span>Mic';
      btn.title = 'Voice';
      break;
  }
}

/* ── Autoplay unlock ─────────────────────────────────────────── */
function _setupAutoplayUnlock() {
  const unlock = () => {
    if (_autoplayUnlocked) return;
    _autoplayUnlocked = true;
    _pendingAutoplay.forEach(audio => {
      audio.play().catch(() => {});
    });
    _pendingAutoplay = [];
    document.removeEventListener('click', unlock);
    document.removeEventListener('keydown', unlock);
    document.removeEventListener('touchstart', unlock);
  };

  document.addEventListener('click',      unlock, { once: true });
  document.addEventListener('keydown',    unlock, { once: true });
  document.addEventListener('touchstart', unlock, { once: true });
}

function _showAutoplayPrompt() {
  if (typeof showToast === 'function') {
    showToast('main-toast', '🔊 Click anywhere to enable voice audio', 'dark');
  }
}

/* ── Backward-compatible toggleMic (called from taskbar button) ─ */
function toggleMic() {
  if (!_voiceInitialised) {
    showToast('main-toast', '⏳ Voice not yet connected…', 'dark');
    return;
  }
  setVoiceMute(!_voiceMuted);
}
