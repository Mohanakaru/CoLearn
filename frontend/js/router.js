/* ── Client-side router (state machine) ──────────────────────── */

const VIEW_IDS = [
  'view-login', 'view-signup', 'view-forgot',
  'view-dashboard', 'view-workspace',
];

function navigate(viewId, fromPopState = false) {
  VIEW_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });

  const target = document.getElementById(viewId);
  if (!target) { console.error('Unknown view:', viewId); return; }
  target.classList.add('active');

  // View-specific on-enter hooks
  if (viewId === 'view-dashboard') {
    if (typeof updateProfileDisplay === 'function') updateProfileDisplay();
    // Always reload suites from backend on every dashboard visit
    if (typeof loadUserSuites === 'function' && AppState.currentUser) {
      loadUserSuites();
    }
  }
  if (viewId === 'view-workspace') {
    if (typeof initWorkspace === 'function') initWorkspace();
  }

  // Manage browser history state
  if (!fromPopState) {
    if (viewId === 'view-dashboard') {
      const wasWorkspace = document.getElementById('view-workspace')?.classList.contains('active');
      if (wasWorkspace) {
        history.replaceState({ view: 'view-dashboard' }, '');
      } else {
        history.pushState({ view: 'view-dashboard' }, '');
      }
    } else if (viewId === 'view-workspace') {
      history.pushState({ view: 'view-workspace', suiteId: AppState.currentSuite?.id }, '');
    } else if (viewId === 'view-signup' || viewId === 'view-forgot') {
      history.pushState({ view: viewId }, '');
    } else if (viewId === 'view-login') {
      history.replaceState({ view: 'view-login' }, '');
    }
  }
}

// Handle browser back/forward buttons
window.addEventListener('popstate', event => {
  const state = event.state;
  if (state && state.view) {
    const isProtected = state.view === 'view-dashboard' || state.view === 'view-workspace';
    if (isProtected && !AppState.currentUser) {
      history.replaceState({ view: 'view-login' }, '');
      navigate('view-login', true);
      return;
    }
    const isAuthPage = state.view === 'view-login' || state.view === 'view-signup' || state.view === 'view-forgot';
    if (AppState.currentUser && isAuthPage) {
      history.pushState({ view: 'view-dashboard' }, '');
      navigate('view-dashboard', true);
      return;
    }
    navigate(state.view, true);
  }
});

/* ── Global keyboard shortcuts ───────────────────────────────── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['modal-create-suite','modal-quick-suite','modal-about','modal-profile','modal-ws-invite']
      .forEach(closeModal);
  }
  if (e.key === 'Enter' && document.getElementById('view-login').classList.contains('active')) {
    // Do not trigger login if focus is on the password toggle button
    const focused = document.activeElement;
    const isToggleBtn = focused && focused.id === 'login-pw-toggle';
    if (!isToggleBtn && typeof handleLogin === 'function') handleLogin();
  }
});

/* ── Close modals on backdrop click ──────────────────────────── */
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', function(e) {
    if (e.target === this) this.classList.add('hidden');
  });
});

/* ── App Initialisation ──────────────────────────────────────── */
/**
 * Runs once on DOMContentLoaded.
 * Restores session from localStorage BEFORE any view is shown.
 * This prevents the flash to login page on refresh.
 */
function initApp() {
  const hadSession = AppState.restoreSession();

  // Re-authenticate Firebase Client SDK if session was restored
  if (hadSession && AppState.currentUser && typeof window.authenticateFirebaseClient === 'function') {
    window.authenticateFirebaseClient(AppState.currentUser.uid).catch(() => {});
  }

  // Handle /invite/:token URL first
  if (typeof handleInviteUrlOnLoad === 'function') {
    handleInviteUrlOnLoad().then(() => {
      _initAppNav(hadSession);
    }).catch(() => {
      _initAppNav(hadSession);
    });
  } else {
    _initAppNav(hadSession);
  }
}

function _initAppNav(hadSession) {
  if (hadSession) {
    // Check if we were in a suite when we refreshed
    if (AppState.currentSuite && AppState.currentSuite.id) {
      // Verify suite still exists, then navigate to workspace
      if (typeof API !== 'undefined') {
        API.getSuite(AppState.currentSuite.id).then(data => {
          if (data && data.success && data.suite) {
            // Update suite data in case it changed
            AppState.currentSuite = {
              ...AppState.currentSuite,
              name:      data.suite.name,
              isPrivate: data.suite.isPrivate,
              ownerUid:  data.suite.ownerUid,
            };
            AppState.saveSession();
            history.replaceState({ view: 'view-workspace', suiteId: AppState.currentSuite.id }, '');
            navigate('view-workspace', true);
          } else {
            // Suite no longer exists — clear it and go to dashboard
            AppState.saveSuite(null);
            history.replaceState({ view: 'view-dashboard' }, '');
            navigate('view-dashboard', true);
          }
        }).catch(() => {
          // Network error — try to restore workspace anyway
          history.replaceState({ view: 'view-workspace', suiteId: AppState.currentSuite.id }, '');
          navigate('view-workspace', true);
        });
      } else {
        history.replaceState({ view: 'view-workspace', suiteId: AppState.currentSuite.id }, '');
        navigate('view-workspace', true);
      }
    } else {
      // Logged in, no active suite — go to dashboard
      history.replaceState({ view: 'view-dashboard' }, '');
      navigate('view-dashboard', true);
    }
  } else {
    // No session — stay on login
    history.replaceState({ view: 'view-login' }, '');
    // Login view is already active by default (class="view active" in HTML)
  }
}

// Bootstrap the app when DOM is ready
document.addEventListener('DOMContentLoaded', initApp);
