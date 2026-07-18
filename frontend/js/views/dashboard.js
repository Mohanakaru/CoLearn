/* ── VIEW 4 – Dashboard ──────────────────────────────────────── */

/* ─ Profile ───────────────────────────────────────────────────── */
function updateProfileDisplay() {
  const u = AppState.currentUser;
  if (!u) return;
  const init = document.getElementById('profile-initial');
  const name = document.getElementById('profile-name-display');
  const mail = document.getElementById('profile-email-display');
  if (init) init.textContent = u.name[0].toUpperCase();
  if (name) name.textContent = u.name;
  if (mail) mail.textContent = u.email;
}

function showAbout()   { openModal('modal-about'); }
function showProfile() { updateProfileDisplay(); openModal('modal-profile'); }

async function handleLogout() {
  closeModal('modal-profile');

  // Invalidate all active invites if this user is a host
  if (typeof invalidateHostInvitesNow === 'function') {
    await invalidateHostInvitesNow();
  }
  // Disconnect any SSE connection
  if (typeof disconnectMemberSSE === 'function') {
    disconnectMemberSSE();
  }

  // Clear session from localStorage and memory
  AppState.clearSession();

  // Sign out from Firebase Client SDK (Firestore/RTDB auth)
  if (typeof window.fsAuth !== 'undefined' && window.fsAuth) {
    window.fsAuth.signOut().catch(() => {});
  }

  // Clear the suites list so it doesn't show the previous user's data
  renderSuites([]);
  navigate('view-login');
}

/* ─ Suite icons ───────────────────────────────────────────────── */
const SUITE_ICONS = ['📚','🔢','⚗️','💻','📖','🎨','🔬','🌍','📐','🎵'];

function suiteIcon(index) {
  return SUITE_ICONS[index % SUITE_ICONS.length];
}

/* ─ Render suites list ────────────────────────────────────────── */
/**
 * Renders the user's suites into #suites-list.
 * Shows "No suites yet" when the array is empty.
 * Each card has an "Open" button and a "Delete" button.
 */
function renderSuites(suites) {
  const container = document.getElementById('suites-list');
  if (!container) return;

  if (!suites || suites.length === 0) {
    container.innerHTML = `
      <div style="padding:2rem;text-align:center;color:var(--c-slate);font-size:0.9rem;border:1.5px dashed var(--c-divider);border-radius:12px;">
        <div style="font-size:2rem;margin-bottom:0.5rem;">📭</div>
        <div style="font-weight:600;color:var(--c-mutedgray);">No suites created yet.</div>
        <div style="margin-top:0.3rem;font-size:0.82rem;">Create a new suite to get started!</div>
      </div>`;
    return;
  }

  container.innerHTML = suites.map((suite, i) => {
    const u       = AppState.currentUser;
    const isOwner = u && (suite.ownerUid === u.uid);
    const deleteBtn = isOwner
      ? `<button
          title="Delete suite"
          data-suite-id="${escapeHtml(suite.id)}"
          data-suite-name="${escapeHtml(suite.name)}"
          onclick="confirmDeleteSuite(this.dataset.suiteId, this.dataset.suiteName)"
          style="flex-shrink:0;background:none;border:1px solid #dee2e6;border-radius:7px;
                 padding:0.3rem 0.55rem;cursor:pointer;font-size:0.8rem;color:#dc3545;
                 transition:background 0.15s;"
          onmouseover="this.style.background='#fff5f5'"
          onmouseout="this.style.background='none'"
          aria-label="Delete ${escapeHtml(suite.name)}">
          🗑️
        </button>`
      : '';

    return `
    <div class="suite-btn" id="suite-card-${suite.id}"
         style="display:flex;align-items:center;gap:0.6rem;justify-content:space-between;padding:0.75rem 0.9rem;">
      <div style="display:flex;align-items:center;gap:0.6rem;flex:1;min-width:0;cursor:pointer;"
           data-suite-id="${escapeHtml(suite.id)}"
           data-suite-name="${escapeHtml(suite.name)}"
           onclick="openExistingSuite(this.dataset.suiteId, this.dataset.suiteName)">
        <span class="suite-icon">${suiteIcon(i)}</span>
        <div style="min-width:0;">
          <div style="font-weight:600;font-size:0.9rem;color:var(--c-charcoal);
                      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${escapeHtml(suite.name)}
          </div>
          <div style="font-size:0.75rem;color:var(--c-slate);">
            ${suite.isPrivate ? '🔒 Private' : '🔓 Public'} ·
            ${new Date(suite.createdAt).toLocaleDateString()}
            ${isOwner ? ' · <span style="color:var(--c-blue);font-weight:600;">Host</span>' : ' · <span style="color:var(--c-slate);">Member</span>'}
          </div>
        </div>
      </div>
      ${deleteBtn}
    </div>`;
  }).join('');

}

/* ─ Load suites from Firestore ────────────────────────────────── */
async function loadUserSuites() {
  const u = AppState.currentUser;
  if (!u || !u.uid) return;

  const container = document.getElementById('suites-list');
  if (container) {
    container.innerHTML = `
      <div style="padding:1.5rem;text-align:center;color:var(--c-slate);font-size:0.88rem;">
        ⏳ Loading your suites…
      </div>`;
  }

  try {
    const data = await API.getSuites(u.uid);
    if (data.success) {
      renderSuites(data.suites || []);
    } else {
      renderSuites([]);
      console.warn('[Dashboard] getSuites error:', data.error);
    }
  } catch (err) {
    renderSuites([]);
    console.error('[Dashboard] Could not load suites:', err.message);
  }
}

/* ─ Open an existing suite ────────────────────────────────────── */
let isSuiteLoading = false;

async function openExistingSuite(suiteId, suiteName) {
  // 1. Validate Suite ID exists
  if (!suiteId) {
    showToast('main-toast', '⚠️ Suite ID is required.');
    return;
  }

  // 2. Prevent duplicate/simultaneous requests
  if (isSuiteLoading) return;
  isSuiteLoading = true;

  // 3. Set visual loading state on the clicked suite card and show loading toast
  const card = document.getElementById(`suite-card-${suiteId}`);
  if (card) {
    card.style.opacity = '0.5';
    card.style.pointerEvents = 'none';
  }
  showToast('main-toast', '⏳ Opening suite...', 'dark');

  try {
    // 4. Fetch the latest suite data from the backend
    const data = await API.getSuite(suiteId);
    if (data.success && data.suite) {
      const suite = {
        id:        data.suite.id,
        name:      data.suite.name,
        isPrivate: data.suite.isPrivate,
        ownerUid:  data.suite.ownerUid,
        type:      'existing',
      };
      AppState.saveSuite(suite);
      // 5. Open Workspace
      navigate('view-workspace');
    } else {
      showToast('main-toast', `⚠️ ${data.error || 'Suite does not exist.'}`);
    }
  } catch (err) {
    showToast('main-toast', '⚠️ Connection error. Could not retrieve suite.');
    console.error('[Dashboard] openExistingSuite error:', err);
  } finally {
    // 6. Reset loading flag and re-enable suite cards
    isSuiteLoading = false;
    if (card) {
      card.style.opacity = '';
      card.style.pointerEvents = '';
    }
  }
}

/* ─ Delete suite (with confirmation) ─────────────────────────── */
async function confirmDeleteSuite(suiteId, suiteName) {
  const confirmed = window.confirm(
    `Delete suite "${suiteName}"?\n\nThis action cannot be undone.`
  );
  if (!confirmed) return;

  const u = AppState.currentUser;
  if (!u) return;

  try {
    const data = await API.deleteSuite(suiteId, u.uid);
    if (data.success) {
      // Remove card from DOM without page refresh
      const card = document.getElementById(`suite-card-${suiteId}`);
      if (card) {
        card.style.transition = 'opacity 0.25s, transform 0.25s';
        card.style.opacity    = '0';
        card.style.transform  = 'translateX(-20px)';
        setTimeout(() => {
          card.remove();
          // If no cards remain, show empty state
          const container = document.getElementById('suites-list');
          if (container && container.children.length === 0) {
            renderSuites([]);
          }
        }, 280);
      }
      showToast('main-toast', `✓ Suite "${suiteName}" deleted.`);
    } else {
      showToast('main-toast', `⚠️ ${data.error || 'Could not delete suite.'}`);
    }
  } catch (err) {
    showToast('main-toast', '⚠️ Server error. Please try again.');
  }
}

/* ─ Join Suite ────────────────────────────────────────────────── */
function handleJoinSuite() {
  const input = document.getElementById('join-suite-code');
  const code  = input ? input.value.trim() : '';
  if (!code) { showToast('main-toast', '⚠️ Please enter a suite code or link.'); return; }
  AppState.currentSuite = {
    name:      'Joined Suite – ' + code.slice(-6).toUpperCase(),
    isPrivate: false,
    type:      'joined',
  };
  if (input) input.value = '';
  navigate('view-workspace');
}

/* ─ Toggle switch ────────────────────────────────────────────── */
function toggleSwitch(trackId, labelId) {
  const track = document.getElementById(trackId);
  const label = document.getElementById(labelId);
  if (!track) return;
  track.classList.toggle('on');
  const isOn = track.classList.contains('on');

  if (trackId === 'cs-private-toggle') {
    if (label) label.textContent = isOn
      ? 'Yes – Private (Approval required)'
      : 'No – Public (Direct join)';
    const hint = document.getElementById('cs-private-hint');
    if (hint) hint.textContent = isOn
      ? '🔒 External users wait in queue until you approve them.'
      : '🔓 Anyone with the invite link can join directly.';
  }
}

/* ─ Quick suite radio style ──────────────────────────────────── */
function updateQSOption() {
  const val = document.querySelector('input[name="qs-access"]:checked');
  if (!val) return;
  ['qs-opt-public','qs-opt-private'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.borderColor = '#dee2e6'; el.style.background = '#f8f9fa'; }
  });
  const selId = val.value === 'public' ? 'qs-opt-public' : 'qs-opt-private';
  const sel = document.getElementById(selId);
  if (sel) { sel.style.borderColor = '#007bff'; sel.style.background = '#e9f7fe'; }
}

/* ─ Suite creation – saves to Firestore then refreshes list ──── */
async function createSuite(type) {
  const u = AppState.currentUser;
  if (!u) return;

  let name, isPrivate;
  if (type === 'permanent') {
    const nameEl = document.getElementById('cs-suite-name');
    name      = (nameEl ? nameEl.value.trim() : '') || 'My New Suite';
    isPrivate = document.getElementById('cs-private-toggle')?.classList.contains('on') || false;
    closeModal('modal-create-suite');
    if (nameEl) nameEl.value = '';
  } else {
    const nameEl = document.getElementById('qs-suite-name');
    name      = (nameEl ? nameEl.value.trim() : '') || 'Quick Session';
    const acc = document.querySelector('input[name="qs-access"]:checked');
    isPrivate = acc ? acc.value === 'private' : false;
    closeModal('modal-quick-suite');
    if (nameEl) nameEl.value = '';
  }

  // For quick suites we still just navigate immediately (no DB storage)
  if (type === 'quick') {
    AppState.currentSuite = { name, isPrivate, type };
    navigate('view-workspace');
    return;
  }

  // Permanent suite → save to Firestore
  try {
    const data = await API.createSuite({ uid: u.uid, name, isPrivate });
    if (data.success) {
      const suite = {
        id:        data.suite.id,
        name:      data.suite.name,
        isPrivate: data.suite.isPrivate,
        ownerUid:  u.uid,
        type:      'permanent',
      };
      AppState.saveSuite(suite);
      // Refresh suite list (non-blocking) then navigate
      loadUserSuites().catch(() => {});
      navigate('view-workspace');
    } else {
      showToast('main-toast', `⚠️ ${data.error || 'Could not create suite.'}`);
    }
  } catch (err) {
    showToast('main-toast', '⚠️ Server error. Please try again.');
  }
}
