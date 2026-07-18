/* ── member-context-menu.js – Right-Click Member Context Menu ────
 *
 * Public API (module-scope):
 *   initMemberContextMenu()                              – setup document listeners
 *   showMemberContextMenu(e, memberId, memberName, isHost) – show menu
 *   hideMemberContextMenu()                              – hide menu
 *   confirmRemoveMember()                                – confirm removal action
 *
 * The context menu is injected into #member-context-menu div (already in HTML).
 * A MutationObserver auto-attaches context-menu handlers to new .member-card elements.
 */
'use strict';

var _cmMenuEl       = null;
var _cmPendingRemove = null; // { memberId, memberName }

/* ══ Public: initMemberContextMenu ══════════════════════════ */
function initMemberContextMenu() {
  _cmMenuEl = document.getElementById('member-context-menu');

  /* Close on Escape */
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') hideMemberContextMenu();
  });

  /* Close on click outside */
  document.addEventListener('click', function(e) {
    if (_cmMenuEl && !_cmMenuEl.classList.contains('hidden') && !_cmMenuEl.contains(e.target)) {
      hideMemberContextMenu();
    }
  });

  /* MutationObserver: auto-attach handlers when member cards are added to sidebar */
  var sidebar = document.getElementById('sidebar-members-list');
  if (sidebar && window.MutationObserver) {
    var observer = new MutationObserver(function() {
      _patchMemberCards();
    });
    observer.observe(sidebar, { childList: true, subtree: true });
  }

  console.info('[MemberContextMenu] Initialised.');
}

/* ══ Public: showMemberContextMenu ══════════════════════════ */
function showMemberContextMenu(e, memberId, memberName, isCurrentUserHost) {
  e.preventDefault();
  e.stopPropagation();

  if (!_cmMenuEl) _cmMenuEl = document.getElementById('member-context-menu');
  if (!_cmMenuEl) return;

  var currentUid = window.AppState && window.AppState.currentUser ? window.AppState.currentUser.uid : null;
  var isSelf = (memberId === currentUid);

  /* Build menu HTML */
  var html = '';

  /* Chat Privately — always shown (except self) */
  if (!isSelf) {
    html += '<button class="ctx-item" onclick="hideMemberContextMenu();_cmOpenPrivateChat(\'' + _esc(memberId) + '\',\'' + _esc(memberName) + '\')">' +
            '✉️ Chat Privately</button>';
  }

  /* Remove from Suite — host only, not self */
  if (isCurrentUserHost && !isSelf) {
    html += '<div class="ctx-separator"></div>';
    html += '<button class="ctx-item danger" onclick="hideMemberContextMenu();_cmConfirmRemove(\'' + _esc(memberId) + '\',\'' + _esc(memberName) + '\')">' +
            '🚫 Remove from Suite</button>';
  }

  /* If self: just a label */
  if (isSelf) {
    html += '<div class="ctx-item" style="pointer-events:none;opacity:0.5;font-style:italic;">That\'s you</div>';
  }

  if (!html) return;

  _cmMenuEl.innerHTML = html;
  _cmMenuEl.classList.remove('hidden');

  /* Position at cursor (keep within viewport) */
  var x = e.clientX;
  var y = e.clientY;
  var menuW = 200;
  var menuH = 120;
  if (x + menuW > window.innerWidth)  x = window.innerWidth  - menuW - 8;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;

  _cmMenuEl.style.left = x + 'px';
  _cmMenuEl.style.top  = y + 'px';
}

/* ══ Public: hideMemberContextMenu ══════════════════════════ */
function hideMemberContextMenu() {
  if (_cmMenuEl) _cmMenuEl.classList.add('hidden');
}

/* ══ Public: confirmRemoveMember (called from modal) ════════ */
async function confirmRemoveMember() {
  if (!_cmPendingRemove) return;
  var memberId   = _cmPendingRemove.memberId;
  var memberName = _cmPendingRemove.memberName;
  _cmPendingRemove = null;

  if (typeof closeModal === 'function') closeModal('modal-remove-member');

  var suite = window.AppState && window.AppState.currentSuite;
  if (!suite || !suite.id) { showToast('main-toast', '⚠️ Suite not found.', 'dark'); return; }

  var user = window.AppState && window.AppState.currentUser;
  if (!user) return;

  try {
    var resp = await fetch(
      (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/suite/' + suite.id + '/members/' + memberId,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-FS-UID': user.uid },
      }
    );
    var data = await resp.json();
    if (data.success) {
      showToast('main-toast', '✓ ' + memberName + ' removed from suite.', 'dark');
      /* Optimistically remove card from sidebar */
      var card = document.querySelector('.member-card[data-uid="' + memberId + '"]');
      if (card) {
        card.style.transition = 'opacity 0.25s';
        card.style.opacity = '0';
        setTimeout(function() { card.remove(); }, 260);
      }
    } else {
      showToast('main-toast', '⚠️ ' + (data.error || 'Could not remove member.'), 'dark');
    }
  } catch (err) {
    showToast('main-toast', '⚠️ Network error. Could not remove member.', 'dark');
    console.error('[MemberContextMenu] removeMember error:', err.message);
  }
}

/* ══ Internal helpers ════════════════════════════════════════ */

function _cmOpenPrivateChat(memberId, memberName) {
  if (typeof openPrivateConversation === 'function') {
    openPrivateConversation(memberId, memberName);
  } else {
    showToast('main-toast', '💬 Private chat is loading…', 'dark');
  }
}

function _cmConfirmRemove(memberId, memberName) {
  _cmPendingRemove = { memberId: memberId, memberName: memberName };
  var nameEl = document.getElementById('remove-member-name');
  if (nameEl) nameEl.textContent = memberName;
  if (typeof openModal === 'function') openModal('modal-remove-member');
}

/* Escape strings for use in onclick attribute strings */
function _esc(str) {
  return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

/* Patch all existing and future member-card elements with contextmenu handler */
function _patchMemberCards() {
  var cards = document.querySelectorAll('.member-card[data-uid]');
  cards.forEach(function(card) {
    if (card.dataset.cmPatched) return; // already attached
    card.dataset.cmPatched = '1';
    card.addEventListener('contextmenu', function(e) {
      var uid  = card.dataset.uid;
      var name = card.dataset.name || card.querySelector('.member-name')?.textContent || 'Member';
      var currentUser  = window.AppState && window.AppState.currentUser;
      var suite        = window.AppState && window.AppState.currentSuite;
      var isHost = suite && currentUser && suite.ownerUid === currentUser.uid;
      showMemberContextMenu(e, uid, name, isHost);
    });
  });
}

/* ══ Auto-init on DOMContentLoaded ══════════════════════════ */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMemberContextMenu);
} else {
  initMemberContextMenu();
}
