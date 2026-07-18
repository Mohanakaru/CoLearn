/* ── VIEW 6 – Active Suite Workspace ─────────────────────────── */

/* ─ Workspace initialisation ─────────────────────────────────── */
function initWorkspace() {
  const suite = AppState.currentSuite;

  // Suite name in header
  const nameEl = document.getElementById('ws-suite-name');
  if (nameEl) nameEl.textContent = suite ? (suite.name || 'Unnamed Suite') : 'Suite';

  // Privacy badge
  const badge = document.getElementById('ws-privacy-badge');
  if (badge) {
    if (suite && suite.isPrivate) {
      badge.textContent = '🔒 Private';
      badge.style.cssText = 'background:#fff3cd;color:#856404;font-size:0.78rem;padding:0.25rem 0.7rem;border-radius:20px;font-weight:600;';
      setTimeout(() => {
        const jr = document.getElementById('join-request-container');
        if (jr) jr.style.display = 'block';
      }, 2500);
    } else {
      badge.textContent = '🔓 Public';
      badge.style.cssText = 'background:#d4edda;color:#155724;font-size:0.78rem;padding:0.25rem 0.7rem;border-radius:20px;font-weight:600;';
      const jr = document.getElementById('join-request-container');
      if (jr) jr.style.display = 'none';
    }
  }

  // Reset member 4
  ['ws-member4-info','member4-sidebar-card','vid-member4'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // Reset sidebar
  AppState.sidebarOpen = true;
  const sidebar = document.getElementById('ws-sidebar');
  if (sidebar) sidebar.classList.remove('collapsed');
  const chev = document.getElementById('sidebar-chevron');
  if (chev) chev.textContent = '›';

  // Reset chat
  AppState.chatOpen = false;
  const chatPanel = document.getElementById('chat-panel');
  if (chatPanel) chatPanel.classList.remove('open');
  const chatBtn = document.getElementById('btn-chat');
  if (chatBtn) chatBtn.classList.remove('active-tool');

  // Reset mic/cam
  AppState.micOn = true; AppState.camOn = true;
  ['btn-mic','btn-cam'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.remove('muted');
  });
  const micIcon = document.querySelector('#btn-mic .taskbar-icon');
  const camIcon = document.querySelector('#btn-cam .taskbar-icon');
  if (micIcon) micIcon.textContent = '🎤';
  if (camIcon) camIcon.textContent = '📹';

  // Reset taskbar tool highlights
  ['btn-docs','btn-whiteboard'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.remove('active-tool');
  });

  // Invite link — use real backend link if suite has an ID + user is host
  const linkTextEl = document.getElementById('invite-link-text');
  if (suite && suite.id && AppState.currentUser) {
    if (linkTextEl) linkTextEl.textContent = 'Generating invite link…';
    const user = AppState.currentUser;
    if (!suite.ownerUid || suite.ownerUid === user.uid) {
      API.generateInvite({ suiteId: suite.id, uid: user.uid })
        .then(data => {
          if (data && data.success) {
            if (linkTextEl) linkTextEl.textContent = data.inviteUrl;
            if (typeof window !== 'undefined') {
              window._currentInviteLink = data.inviteUrl;
            }
          }
        })
        .catch(() => {
          if (linkTextEl) linkTextEl.textContent = location.origin + '/invite/(code generated on demand)';
        });
    } else {
      if (linkTextEl) linkTextEl.textContent = 'Ask the host for the invite link.';
    }
  } else {
    const code = Math.random().toString(36).substr(2, 8).toUpperCase();
    if (linkTextEl) linkTextEl.textContent = location.origin + '/quick/' + code;
  }

  // Set default state
  setWSState('invite', true);

  // Connect SSE for real-time member list (only for persistent suites)
  if (suite && suite.id && typeof connectMemberSSE === 'function') {
    connectMemberSSE(suite.id);
  }

  // Init whiteboard
  setTimeout(() => initWhiteboard(), 50);

  // Init real-time chat (Firebase)
  if (suite && suite.id) {
    initSuiteChat(suite.id);
  }

  // Init voice (WebRTC)
  if (suite && suite.id && AppState.currentUser) {
    if (typeof initVoice === 'function') {
      initVoice(suite.id, AppState.currentUser.uid, AppState.currentUser.name);
    }
  }

  // Init video call module
  if (suite && suite.id && AppState.currentUser) {
    if (typeof initVideoCall === 'function') {
      initVideoCall(suite.id, AppState.currentUser.uid, AppState.currentUser.name);
    }
  }

  // Init screen share module
  if (suite && suite.id && AppState.currentUser) {
    if (typeof initScreenShare === 'function') {
      initScreenShare(suite.id, AppState.currentUser.uid, AppState.currentUser.name);
    }
  }

  // Init notifications
  if (AppState.currentUser) {
    if (typeof initNotifications === 'function') {
      initNotifications(AppState.currentUser.uid);
    }
  }

  // Init private chat
  if (AppState.currentUser) {
    if (typeof initPrivateChat === 'function') {
      initPrivateChat(AppState.currentUser.uid, AppState.currentUser.name);
    }
  }

  // Init Google Drive: FIRST clear all old suite state, then load for new suite
  if (suite && suite.id) {
    // Immediately wipe old suite's files, pending queue, and viewer
    if (typeof clearSuiteDocState === 'function') {
      clearSuiteDocState();
    }
    // Check Drive connection status (updates badge)
    if (typeof _checkDriveStatus === 'function') {
      _checkDriveStatus();
    }
    // Load existing Drive files for this suite
    if (typeof loadSuiteDriveFiles === 'function') {
      loadSuiteDriveFiles(suite.id);
    }
  }
}

/* ─ Viewport state switching ─────────────────────────────────── */
function setWSState(state, silent) {
  AppState.wsCurrentState = state;
  ['invite','docs','whiteboard'].forEach(s => {
    const el = document.getElementById('ws-state-' + s);
    if (el) el.style.display = 'none';
  });
  const active = document.getElementById('ws-state-' + state);
  if (active) { active.style.display = 'block'; active.style.animation = 'fadeIn 0.3s ease'; }

  ['btn-docs','btn-whiteboard'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.remove('active-tool');
  });
  if (state === 'docs')       document.getElementById('btn-docs')?.classList.add('active-tool');
  if (state === 'whiteboard') document.getElementById('btn-whiteboard')?.classList.add('active-tool');

  if (state === 'whiteboard' && !silent) setTimeout(resizeWhiteboard, 80);

  // When switching to docs view, reload Drive files for the current (and only) suite
  if (state === 'docs' && !silent) {
    const suite = AppState && AppState.currentSuite;
    if (suite && suite.id) {
      if (typeof loadSuiteDriveFiles === 'function') {
        // loadSuiteDriveFiles clears stale data first internally
        loadSuiteDriveFiles(suite.id);
      }
    }
    if (typeof _checkDriveStatus === 'function') {
      _checkDriveStatus();
    }
  }
}

/* ─ Sidebar toggle ───────────────────────────────────────────── */
function toggleSidebar() {
  AppState.sidebarOpen = !AppState.sidebarOpen;
  const sidebar = document.getElementById('ws-sidebar');
  const chevron = document.getElementById('sidebar-chevron');
  if (sidebar) sidebar.classList.toggle('collapsed', !AppState.sidebarOpen);
  if (chevron) chevron.textContent = AppState.sidebarOpen ? '›' : '‹';
}

/* ─ Leave suite ──────────────────────────────────────────────── */
async function leaveSuite() {
  if (!confirm('Leave this suite? Your session will end.')) return;

  // Cleanup all media modules
  if (typeof cleanupVoice         === 'function') cleanupVoice();
  if (typeof cleanupVideoCall      === 'function') await cleanupVideoCall();
  if (typeof cleanupScreenShare    === 'function') await cleanupScreenShare();
  if (typeof cleanupNotifications  === 'function') cleanupNotifications();
  if (typeof cleanupPrivateChat    === 'function') cleanupPrivateChat();

  // Disconnect chat listener
  cleanupSuiteChat();

  // Disconnect SSE
  if (typeof disconnectMemberSSE === 'function') disconnectMemberSSE();

  // If host, invalidate all active invites
  if (typeof invalidateHostInvitesNow === 'function') {
    await invalidateHostInvitesNow();
  }

  // Clear all Drive state for this suite (cache, queue, viewer)
  if (typeof clearSuiteDocState === 'function') {
    clearSuiteDocState();
  }

  // Clear suite from session (keep user logged in)
  AppState.saveSuite(null);

  navigate('view-dashboard');
}

/* ─ Mic / Cam ────────────────────────────────────────────────── */
function toggleMic() {
  AppState.micOn = !AppState.micOn;
  const btn  = document.getElementById('btn-mic');
  const icon = btn?.querySelector('.taskbar-icon');
  if (btn)  btn.classList.toggle('muted', !AppState.micOn);
  if (icon) icon.textContent = AppState.micOn ? '🎤' : '🔇';

  // Mute/unmute voice track
  if (typeof setVoiceMute === 'function') {
    setVoiceMute(!AppState.micOn);
  }
}

function toggleCam() {
  AppState.camOn = !AppState.camOn;
  const btn  = document.getElementById('btn-cam');
  const icon = btn?.querySelector('.taskbar-icon');
  if (btn)  btn.classList.toggle('muted', !AppState.camOn);
  if (icon) icon.textContent = AppState.camOn ? '📹' : '🚫';
}

/* ─ Chat fly-out ─────────────────────────────────────────────── */
function toggleChat() {
  AppState.chatOpen = !AppState.chatOpen;
  const panel = document.getElementById('chat-panel');
  const btn   = document.getElementById('btn-chat');
  if (panel) panel.classList.toggle('open', AppState.chatOpen);
  if (btn)   btn.classList.toggle('active-tool', AppState.chatOpen);

  // Scroll to bottom when opening
  if (AppState.chatOpen) {
    const messages = document.getElementById('chat-messages');
    if (messages) setTimeout(() => { messages.scrollTop = messages.scrollHeight; }, 50);
  }
}

/* ─ Real-time Chat (Firebase Firestore) ──────────────────────── */
let _chatUnsubscribe   = null;   // Firestore onSnapshot unsubscribe handle
let _chatRenderedIds   = new Set(); // Track rendered message IDs to prevent duplicates

/**
 * Initialize suite chat: load history and subscribe to new messages.
 * Uses Firebase Client SDK Firestore (window.fsDb).
 */
function initSuiteChat(suiteId) {
  // Clean up any previous listener
  cleanupSuiteChat();
  _chatRenderedIds.clear();

  // Clear placeholder messages from HTML
  const messages = document.getElementById('chat-messages');
  if (messages) messages.innerHTML = '';

  // Check if Firebase client SDK is available
  if (typeof window.fsDb === 'undefined') {
    console.warn('[Chat] Firebase client DB not available. Chat will be local-only.');
    return;
  }

  try {
    const messagesRef = window.fsDb
      .collection('suites')
      .doc(suiteId)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .limitToLast(100);

    _chatUnsubscribe = messagesRef.onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const msg = { id: change.doc.id, ...change.doc.data() };
          _renderChatMessage(msg);
        }
      });
    }, err => {
      console.error('[Chat] Snapshot error:', err.message);
    });

  } catch (e) {
    console.error('[Chat] Failed to init chat listener:', e.message);
  }
}

/** Render a single message into the chat panel */
function _renderChatMessage(msg) {
  if (_chatRenderedIds.has(msg.id)) return; // Prevent duplicates
  _chatRenderedIds.add(msg.id);

  const messages = document.getElementById('chat-messages');
  if (!messages) return;

  const isOwn = AppState.currentUser && msg.senderUid === AppState.currentUser.uid;
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble${isOwn ? ' own' : ''}`;
  bubble.dataset.msgId = msg.id;

  // Format timestamp
  let timeStr = '';
  if (msg.timestamp) {
    const ts = msg.timestamp.toDate ? msg.timestamp.toDate() : new Date(msg.timestamp);
    timeStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  bubble.innerHTML = `
    <div class="chat-sender">${escapeHtml(msg.senderName || 'Unknown')}${timeStr ? `<span style="font-size:0.7rem;color:var(--c-mutedgray);margin-left:6px;">${timeStr}</span>` : ''}</div>
    ${escapeHtml(msg.text)}
  `;

  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

/** Cleanup chat Firestore listener */
function cleanupSuiteChat() {
  if (_chatUnsubscribe) {
    try { _chatUnsubscribe(); } catch (_) {}
    _chatUnsubscribe = null;
  }
  _chatRenderedIds.clear();
}

/** Send a chat message — saves to Firestore */
function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text  = input ? input.value.trim() : '';
  if (!text) return;

  const user  = AppState.currentUser;
  const suite = AppState.currentSuite;

  if (input) input.value = '';

  // If Firebase is available, write to Firestore
  if (typeof window.fsDb !== 'undefined' && suite && suite.id) {
    const msg = {
      text,
      senderUid:  user ? user.uid  : 'anon',
      senderName: user ? user.name : 'Anonymous',
      timestamp:  firebase.firestore.FieldValue.serverTimestamp(),
    };

    window.fsDb
      .collection('suites')
      .doc(suite.id)
      .collection('messages')
      .add(msg)
      .catch(err => {
        console.error('[Chat] Failed to send message:', err.message);
        // Fallback: show locally
        _renderLocalMessage(text, user);
      });
  } else {
    // Firebase not available — show locally
    _renderLocalMessage(text, user);
  }
}

/** Fallback: show a message locally only (when Firestore not available) */
function _renderLocalMessage(text, user) {
  const messages = document.getElementById('chat-messages');
  if (!messages) return;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble own';
  bubble.innerHTML = `<div class="chat-sender">${escapeHtml(user?.name || 'You')}</div>${escapeHtml(text)}`;
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

/* ─ Private suite admission ──────────────────────────────────── */
function admitMember() {
  document.getElementById('join-request-container').style.display = 'none';
  ['member4-sidebar-card','ws-member4-info','vid-member4'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === 'member4-sidebar-card' ? 'flex' : 'block';
  });
  showToast('main-toast', '✅ Sam Chen has been admitted!', 'green');
}

function rejectMember() {
  document.getElementById('join-request-container').style.display = 'none';
  showToast('main-toast', '✕ Join request from Sam Chen was rejected.');
}

/* ─ Google Drive integration ─────────────────────────────────── */
function linkDriveFile(type, filename) {
  const icons = { PDF:'📄', DOCX:'📝', PPTX:'📊', IMG:'🖼️' };
  showToast('main-toast', `☁️ Linked ${type}: ${filename}`);
  const iconEl = document.getElementById('doc-type-icon');
  const nameEl = document.getElementById('doc-file-name');
  const metaEl = document.getElementById('doc-file-meta');
  if (iconEl) iconEl.textContent = icons[type] || '📄';
  if (nameEl) nameEl.textContent = filename;
  if (metaEl) metaEl.textContent = `${type} · Synced from Google Drive`;
  setWSState('docs');
}

/* ─ Doc navigation ───────────────────────────────────────────── */
function changeDocPage(delta) {
  AppState.docPage = Math.max(1, Math.min(AppState.DOC_PAGES, AppState.docPage + delta));
  const ind = document.getElementById('doc-page-indicator');
  if (ind) ind.textContent = `Page ${AppState.docPage} of ${AppState.DOC_PAGES}`;
}

/* ─ Invite link ──────────────────────────────────────────────── */
// copyInviteLink() and showInviteModal() are implemented in invite.js
// which overrides these stubs at runtime.
function copyInviteLink() {
  const text = document.getElementById('invite-link-text')?.textContent || location.href;
  copyToClipboard(text);
  showToast('copy-toast', '✓ Invite link copied!', 'green');
}

function showInviteModal() { openModal('modal-ws-invite'); }
