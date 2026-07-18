/* ── private-chat.js – CoLearn Private Messaging ──────────────
 *
 * Public API (module-scope):
 *   initPrivateChat(userId, userName)
 *   openPrivateConversation(peerId, peerName)
 *   closePrivateChatPanel()
 *   togglePrivateChatPanel()
 *   showConversationList()
 *   sendPrivateMessage()
 *   handlePrivateTyping()
 *   toggleEmojiPicker()
 *   clearReply()
 *   cleanupPrivateChat()
 *
 * Firestore: privateChats/{convId} + privateChats/{convId}/messages/{msgId}
 * RTDB: privateTyping/{convId}/{uid}
 */
'use strict';

var _pcUserId    = null;
var _pcUserName  = null;
var _pcConvId    = null;
var _pcPeerId    = null;
var _pcPeerName  = null;
var _pcUnsubs    = [];
var _pcMsgUnsub  = null;
var _pcTypUnsub  = null;
var _pcTypTimer  = null;
var _pcConvs     = {};
var _pcReplyTo   = null;
var _pcPanelOpen = false;
var _pcEmojiOpen = false;
var _pcCtxMenu   = null;

var PC_EMOJIS = ['😀','😂','😍','🤔','😎','😢','😄','😅','🥳','👍','👎','🙏',
                 '🔥','❤️','💯','🎉','🚀','✔️','❌','❓','⚠️','🤗','💤','⌛',
                 '📝','📚','💻','📱','🌍','👨‍💻','🌟','🤝'];

/* ══ Public Functions ════════════════════════════════════════ */

function initPrivateChat(userId, userName) {
  _pcUserId   = userId;
  _pcUserName = userName;
  _buildEmojiPicker();
  _listenAllConvs();
  console.info('[PrivateChat] init', userId);
}

function openPrivateConversation(peerId, peerName) {
  if (!_pcUserId) return;
  _pcPeerId   = peerId;
  _pcPeerName = peerName;
  _pcConvId   = [_pcUserId, peerId].sort().join('_');
  _pcReplyTo  = null;
  _hidePCReply();

  _pcPanelOpen = true;
  _pcShowPanel(true);

  var listEl = document.getElementById('pc-conversation-list');
  var convEl = document.getElementById('pc-active-conversation');
  if (listEl) listEl.style.display = 'none';
  if (convEl) convEl.style.display = 'flex';

  var nameEl = document.getElementById('pc-peer-name');
  if (nameEl) nameEl.textContent = peerName;

  _listenMsgs(_pcConvId);
  _markRead(_pcConvId);
}

function closePrivateChatPanel() {
  _pcPanelOpen = false;
  _pcShowPanel(false);
  _stopMsgListener();
}

function togglePrivateChatPanel() {
  if (_pcPanelOpen) { closePrivateChatPanel(); } else { _pcPanelOpen = true; _pcShowPanel(true); }
}

function showConversationList() {
  _stopMsgListener();
  _pcPeerId = _pcPeerName = _pcConvId = null;
  var listEl = document.getElementById('pc-conversation-list');
  var convEl = document.getElementById('pc-active-conversation');
  if (listEl) listEl.style.display = 'flex';
  if (convEl) convEl.style.display = 'none';
}

async function sendPrivateMessage() {
  var input = document.getElementById('pc-message-input');
  if (!input) return;
  var text = input.value.trim();
  if (!text || !_pcConvId || !_pcUserId || !window.fsDb) return;
  input.value = '';
  _clearTyping();

  var msgData = {
    text: text,
    senderUid: _pcUserId,
    senderName: _pcUserName,
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    read: false,
    deleted: false,
    replyTo: _pcReplyTo ? { id: _pcReplyTo.id, text: (_pcReplyTo.text || '').substring(0, 80) } : null,
  };

  _pcReplyTo = null;
  _hidePCReply();

  try {
    var convRef = window.fsDb.collection('privateChats').doc(_pcConvId);
    var unreadInc = {};
    unreadInc['unreadCount.' + _pcPeerId] = firebase.firestore.FieldValue.increment(1);
    unreadInc['unreadCount.' + _pcUserId] = 0;

    await convRef.set({
      participants: [_pcUserId, _pcPeerId],
      participantNames: (function() { var m = {}; m[_pcUserId] = _pcUserName; m[_pcPeerId] = _pcPeerName; return m; })(),
      lastMessage: text.substring(0, 60),
      lastMessageAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastSenderId: _pcUserId,
    }, { merge: true });

    await convRef.update(unreadInc).catch(function() {});
    await convRef.collection('messages').add(msgData);

    if (typeof writeNotification === 'function') {
      writeNotification(_pcPeerId, 'private_message', {
        title: _pcUserName + ' sent you a message',
        body: text.substring(0, 60),
        data: { fromUid: _pcUserId, fromName: _pcUserName },
      });
    }
  } catch (e) {
    console.error('[PrivateChat] send error:', e.message);
    showToast('main-toast', 'Could not send message.', 'dark');
  }
}

function handlePrivateTyping() {
  if (!_pcConvId || !_pcUserId || !window.fsRtdb) return;
  window.fsRtdb.ref('privateTyping/' + _pcConvId + '/' + _pcUserId).set({ typing: true, name: _pcUserName });
  clearTimeout(_pcTypTimer);
  _pcTypTimer = setTimeout(_clearTyping, 3000);
}

function toggleEmojiPicker() {
  _pcEmojiOpen = !_pcEmojiOpen;
  var p = document.getElementById('pc-emoji-picker');
  if (p) p.classList.toggle('hidden', !_pcEmojiOpen);
}

function clearReply() {
  _pcReplyTo = null;
  _hidePCReply();
}

function cleanupPrivateChat() {
  _pcUnsubs.forEach(function(fn) { try { fn(); } catch (_) {} });
  _pcUnsubs = [];
  _stopMsgListener();
  _clearTyping();
  if (_pcCtxMenu) { try { _pcCtxMenu.remove(); } catch (_) {} _pcCtxMenu = null; }
  _pcUserId = _pcUserName = _pcConvId = _pcPeerId = _pcPeerName = null;
  _pcPanelOpen = false;
  _pcShowPanel(false);
}

/* ══ Internal ════════════════════════════════════════════════ */

function _listenAllConvs() {
  if (!window.fsDb || !_pcUserId) return;
  var unsub = window.fsDb
    .collection('privateChats')
    .where('participants', 'array-contains', _pcUserId)
    .orderBy('lastMessageAt', 'desc')
    .limit(30)
    .onSnapshot(function(snap) {
      _pcConvs = {};
      snap.forEach(function(doc) { _pcConvs[doc.id] = Object.assign({ id: doc.id }, doc.data()); });
      _renderConvList();
      _updatePCBadge();
    }, function(err) { console.warn('[PrivateChat] convs listener:', err.message); });
  _pcUnsubs.push(unsub);
}

function _listenMsgs(convId) {
  _stopMsgListener();
  if (!window.fsDb) return;

  _pcMsgUnsub = window.fsDb
    .collection('privateChats').doc(convId)
    .collection('messages')
    .orderBy('timestamp', 'asc')
    .limit(100)
    .onSnapshot(function(snap) { _renderMsgs(snap); }, function() {});

  if (window.fsRtdb && _pcPeerId) {
    var ref = window.fsRtdb.ref('privateTyping/' + convId + '/' + _pcPeerId);
    ref.on('value', function(snap) {
      var d = snap.val();
      var el = document.getElementById('pc-typing-indicator');
      if (el) el.textContent = (d && d.typing) ? (d.name || 'Peer') + ' is typing…' : '';
    });
    _pcTypUnsub = function() { ref.off(); };
  }
}

function _stopMsgListener() {
  if (_pcMsgUnsub) { try { _pcMsgUnsub(); } catch (_) {} _pcMsgUnsub = null; }
  if (_pcTypUnsub) { try { _pcTypUnsub(); } catch (_) {} _pcTypUnsub = null; }
  var ind = document.getElementById('pc-typing-indicator');
  if (ind) ind.textContent = '';
}

function _renderMsgs(snap) {
  var c = document.getElementById('pc-messages');
  if (!c) return;
  c.innerHTML = '';
  snap.forEach(function(doc) {
    var msg = Object.assign({ id: doc.id }, doc.data());
    var own = msg.senderUid === _pcUserId;
    var el = document.createElement('div');
    el.className = 'pc-bubble ' + (own ? 'own' : 'other') + (msg.deleted ? ' deleted' : '');
    el.dataset.msgId = msg.id;

    var h = '';
    if (!own) h += '<div class="pc-bubble-sender">' + escapeHtml(msg.senderName || '') + '</div>';
    if (msg.replyTo && msg.replyTo.text) {
      h += '<div class="pc-reply-context">↩ ' + escapeHtml(msg.replyTo.text) + '</div>';
    }
    h += '<div>' + (msg.deleted ? '<em>This message was deleted</em>' : escapeHtml(msg.text || '')) + '</div>';
    var ts = msg.timestamp ? _fmtTime(msg.timestamp.toDate ? msg.timestamp.toDate() : new Date(msg.timestamp)) : '';
    h += '<span class="pc-bubble-time">' + ts + '</span>';
    if (own && msg.read) h += '<span class="pc-bubble-seen">Seen</span>';

    el.innerHTML = h;
    el.addEventListener('contextmenu', function(e) { e.preventDefault(); _showMsgCtx(e, msg, own); });
    c.appendChild(el);
  });
  c.scrollTop = c.scrollHeight;
}

function _showMsgCtx(e, msg, own) {
  if (_pcCtxMenu) _pcCtxMenu.remove();
  var m = document.createElement('div');
  m.className = 'msg-context-menu';

  var x = Math.min(e.clientX, window.innerWidth - 160);
  var y = Math.min(e.clientY, window.innerHeight - 120);
  m.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;z-index:9999;';

  function item(icon, label, cls, fn) {
    var i = document.createElement('div');
    i.className = 'msg-context-item' + (cls ? ' ' + cls : '');
    i.innerHTML = icon + ' ' + label;
    i.onclick = function() { m.remove(); _pcCtxMenu = null; fn(); };
    m.appendChild(i);
  }

  item('📎', 'Reply', '', function() { _setReply(msg); });
  item('📋', 'Copy', '', function() {
    try { navigator.clipboard.writeText(msg.text || ''); } catch (_) {}
    showToast('main-toast', '✓ Copied', 'dark');
  });
  if (own && !msg.deleted) {
    item('🗑️', 'Delete', 'danger', function() { _deleteMsg(msg.id); });
  }

  document.body.appendChild(m);
  _pcCtxMenu = m;
  setTimeout(function() {
    document.addEventListener('click', function cb() { if (m.parentNode) m.remove(); _pcCtxMenu = null; document.removeEventListener('click', cb); });
  }, 10);
}

function _deleteMsg(id) {
  if (!_pcConvId || !window.fsDb) return;
  window.fsDb.collection('privateChats').doc(_pcConvId).collection('messages').doc(id)
    .update({ deleted: true }).catch(function() {});
}

function _setReply(msg) {
  _pcReplyTo = msg;
  var p = document.getElementById('pc-reply-preview');
  var t = document.getElementById('pc-reply-text');
  if (p) p.style.display = 'block';
  if (t) t.textContent = (msg.text || '').substring(0, 80);
  var inp = document.getElementById('pc-message-input');
  if (inp) inp.focus();
}

function _hidePCReply() {
  var p = document.getElementById('pc-reply-preview');
  var t = document.getElementById('pc-reply-text');
  if (p) p.style.display = 'none';
  if (t) t.textContent = '';
}

function _renderConvList() {
  var c = document.getElementById('pc-conversation-list');
  if (!c) return;
  var list = Object.values(_pcConvs);
  if (!list.length) {
    c.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--c-slate);font-size:0.85rem;"><div style="font-size:1.5rem;">✉️</div>No conversations yet</div>';
    return;
  }
  c.innerHTML = list.map(function(conv) {
    var otherId   = (conv.participants || []).find(function(p) { return p !== _pcUserId; }) || '';
    var otherName = ((conv.participantNames || {})[otherId]) || 'Unknown';
    var unread    = ((conv.unreadCount || {})[_pcUserId] || 0);
    var last      = (conv.lastMessage || '').substring(0, 28);
    return '<div class="pc-conv-item" onclick="openPrivateConversation(\'' + escapeHtml(otherId) + '\',\'' + escapeHtml(otherName) + '\')">' +
           '<div class="pc-conv-avatar">' + escapeHtml(otherName[0] ? otherName[0].toUpperCase() : '?') + '</div>' +
           '<div class="pc-conv-info"><div class="pc-conv-name">' + escapeHtml(otherName) + '</div>' +
           '<div class="pc-conv-last">' + escapeHtml(last) + '</div></div>' +
           (unread ? '<div class="pc-unread-dot">' + unread + '</div>' : '') +
           '</div>';
  }).join('');
}

function _markRead(convId) {
  if (!window.fsDb || !convId || !_pcUserId) return;
  var upd = {}; upd['unreadCount.' + _pcUserId] = 0;
  window.fsDb.collection('privateChats').doc(convId).update(upd).catch(function() {});
  window.fsDb.collection('privateChats').doc(convId).collection('messages')
    .where('senderUid', '!=', _pcUserId).where('read', '==', false)
    .get().then(function(snap) {
      var b = window.fsDb.batch();
      snap.forEach(function(d) { b.update(d.ref, { read: true }); });
      b.commit().catch(function() {});
    }).catch(function() {});
}

function _updatePCBadge() {
  var total = 0;
  Object.values(_pcConvs).forEach(function(c) { total += ((c.unreadCount || {})[_pcUserId] || 0); });
  var badge = document.getElementById('pc-unread-badge');
  if (!badge) return;
  if (total > 0) { badge.textContent = String(Math.min(total, 99)); badge.style.display = 'flex'; }
  else { badge.style.display = 'none'; }
}

function _clearTyping() {
  clearTimeout(_pcTypTimer);
  if (!window.fsRtdb || !_pcConvId || !_pcUserId) return;
  window.fsRtdb.ref('privateTyping/' + _pcConvId + '/' + _pcUserId).remove().catch(function() {});
}

function _pcShowPanel(show) {
  var p = document.getElementById('private-chat-panel');
  if (p) p.classList.toggle('hidden', !show);
}

function _buildEmojiPicker() {
  var p = document.getElementById('pc-emoji-picker');
  if (!p) return;
  p.innerHTML = PC_EMOJIS.map(function(e) {
    return '<button class="pc-emoji-btn" onclick="insertEmoji(\'' + e + '\')" type="button">' + e + '</button>';
  }).join('');
}

window.insertEmoji = function(emoji) {
  var inp = document.getElementById('pc-message-input');
  if (inp) { inp.value += emoji; inp.focus(); }
  _pcEmojiOpen = false;
  var p = document.getElementById('pc-emoji-picker');
  if (p) p.classList.add('hidden');
};

function _fmtTime(date) {
  if (!date) return '';
  var now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
