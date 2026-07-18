/* ── notifications.js – CoLearn Real-time Notifications ───────
 *
 * Public API (module-scope):
 *   initNotifications(userId)         – start Firestore listener
 *   showNotification(type, data)      – display toast + update bell
 *   markNotificationRead(notifId)     – mark single notification read
 *   clearAllNotifications()           – clear all for this user
 *   cleanupNotifications()            – unsubscribe (called on leave)
 *   getUnreadNotificationCount()      – returns unread count
 *   writeNotification(uid, type, data) – write notif to Firestore (global)
 *   toggleNotificationPanel()         – toggle dropdown
 *
 * Firestore: notifications/{userId}/{notifId}
 *   { type, title, body, data, timestamp, read }
 */

'use strict';

var _notifUserId  = null;
var _notifUnsub   = null;
var _notifPanelOpen = false;
var _notifications  = [];

var NOTIF_CONFIG = {
  screen_share_start: { icon: '\ud83d\udcfa', title: 'Screen Share Started' },
  screen_share_stop:  { icon: '\ud83d\udcfa', title: 'Screen Share Ended' },
  voice_join:         { icon: '\ud83c\udfa4', title: 'Joined Voice' },
  voice_leave:        { icon: '\ud83c\udfa4', title: 'Left Voice' },
  video_join:         { icon: '\ud83d\udcf9', title: 'Joined Video' },
  video_leave:        { icon: '\ud83d\udcf9', title: 'Left Video' },
  private_message:    { icon: '\ud83d\udcac', title: 'Private Message' },
  member_removed:     { icon: '\ud83d\udeab', title: 'Removed from Suite' },
  suite_invitation:   { icon: '\ud83d\udd17', title: 'Suite Invitation' },
  generic:            { icon: '\ud83d\udd14', title: 'Notification' },
};

function initNotifications(userId) {
  _notifUserId = userId;
  if (!window.fsDb) { console.warn('[Notifications] Firestore not available.'); return; }

  /* Request browser notification permission */
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(function() {});
  }

  /* Listen to Firestore notifications collection */
  _notifUnsub = window.fsDb
    .collection('notifications')
    .doc(userId)
    .collection('items')
    .orderBy('timestamp', 'desc')
    .limit(50)
    .onSnapshot(function(snap) {
      _notifications = [];
      snap.forEach(function(doc) {
        _notifications.push(Object.assign({ id: doc.id }, doc.data()));
      });
      _renderNotificationList();
      _updateBadge();

      /* Show toast for newest unread */
      var changes = snap.docChanges();
      changes.forEach(function(change) {
        if (change.type === 'added') {
          var n = Object.assign({ id: change.doc.id }, change.doc.data());
          if (!n.read) _onNewNotification(n);
        }
      });
    }, function(err) {
      console.warn('[Notifications] Firestore listener error:', err.message);
    });

  console.info('[Notifications] Listening for user', userId);
}

function showNotification(type, data) {
  if (!_notifUserId || !window.fsDb) return;
  var cfg = NOTIF_CONFIG[type] || NOTIF_CONFIG.generic;
  var body = data.body || cfg.title;
  writeNotification(_notifUserId, type, {
    title: cfg.title,
    body:  body,
    data:  data,
  });
}

function markNotificationRead(notifId) {
  if (!_notifUserId || !window.fsDb) return;
  window.fsDb
    .collection('notifications').doc(_notifUserId)
    .collection('items').doc(notifId)
    .update({ read: true })
    .catch(function() {});
}

function clearAllNotifications() {
  if (!_notifUserId || !window.fsDb) return;
  var batch = window.fsDb.batch();
  _notifications.forEach(function(n) {
    var ref = window.fsDb.collection('notifications').doc(_notifUserId)
                         .collection('items').doc(n.id);
    batch.delete(ref);
  });
  batch.commit().catch(function() {});
}

function cleanupNotifications() {
  if (_notifUnsub) { try { _notifUnsub(); } catch (_) {} _notifUnsub = null; }
  _notifications  = [];
  _notifUserId    = null;
  _notifPanelOpen = false;
  _updateBadge();
  _renderNotificationList();
}

function getUnreadNotificationCount() {
  return _notifications.filter(function(n) { return !n.read; }).length;
}

function toggleNotificationPanel() {
  _notifPanelOpen = !_notifPanelOpen;
  var panel = document.getElementById('notification-dropdown');
  if (panel) panel.classList.toggle('hidden', !_notifPanelOpen);
  if (_notifPanelOpen) {
    /* Mark visible as read after a short delay */
    setTimeout(function() {
      _notifications.filter(function(n) { return !n.read; }).slice(0, 10).forEach(function(n) {
        markNotificationRead(n.id);
      });
    }, 1500);
  }
}

/* ── Global: writeNotification ───────────────────────────────── */
window.writeNotification = function(targetUserId, type, data) {
  if (!window.fsDb) return;
  var cfg = NOTIF_CONFIG[type] || NOTIF_CONFIG.generic;
  window.fsDb
    .collection('notifications').doc(targetUserId)
    .collection('items').add({
      type:      type,
      title:     data.title || cfg.title,
      body:      data.body  || '',
      icon:      cfg.icon,
      data:      data.data  || {},
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      read:      false,
    }).catch(function() {});
};

/* ── Internal ────────────────────────────────────────────────── */
function _onNewNotification(n) {
  /* Show toast */
  var icon = n.icon || (NOTIF_CONFIG[n.type] || {}).icon || '\ud83d\udd14';
  if (typeof showToast === 'function') {
    showToast('main-toast', icon + ' ' + (n.title || '') + (n.body ? ': ' + n.body : ''), 'dark');
  }
  /* Browser notification for private messages and invitations */
  if ((n.type === 'private_message' || n.type === 'suite_invitation') &&
      'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('CoLearn - ' + (n.title || ''), {
        body: n.body || '',
        icon: '/favicon.ico',
      });
    } catch (_) {}
  }
}

function _updateBadge() {
  var count = getUnreadNotificationCount();
  var badge = document.getElementById('notification-count');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function _renderNotificationList() {
  var list = document.getElementById('notification-list');
  if (!list) return;
  if (!_notifications.length) {
    list.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--c-slate);font-size:0.85rem;">No notifications</div>';
    return;
  }
  list.innerHTML = _notifications.slice(0, 20).map(function(n) {
    var cfg = NOTIF_CONFIG[n.type] || NOTIF_CONFIG.generic;
    var icon = n.icon || cfg.icon;
    var time = n.timestamp ? _formatNotifTime(n.timestamp.toDate ? n.timestamp.toDate() : new Date(n.timestamp)) : '';
    return '<div class="notif-item' + (n.read ? '' : ' unread') + '" onclick="markNotificationRead(\'' + n.id + '\')">' +
           '<div class="notif-icon">' + escapeHtml(icon) + '</div>' +
           '<div class="notif-body">' +
             '<div class="notif-title">' + escapeHtml(n.title || cfg.title) + '</div>' +
             (n.body ? '<div class="notif-text">' + escapeHtml(n.body) + '</div>' : '') +
             '<div class="notif-time">' + time + '</div>' +
           '</div>' +
           '</div>';
  }).join('');
}

function _formatNotifTime(date) {
  if (!date) return '';
  var now  = new Date();
  var diff = Math.floor((now - date) / 1000);
  if (diff < 60)   return 'Just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return date.toLocaleDateString();
}

/* Close notification panel when clicking outside */
document.addEventListener('click', function(e) {
  if (_notifPanelOpen) {
    var wrap = document.getElementById('notification-bell-wrap');
    if (wrap && !wrap.contains(e.target)) {
      _notifPanelOpen = false;
      var panel = document.getElementById('notification-dropdown');
      if (panel) panel.classList.add('hidden');
    }
  }
});
