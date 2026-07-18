/* ── VIEW 1 – Login ──────────────────────────────────────────── */

/* ── Password Reveal Toggle (Issue 1) ────────────────────────── */
/**
 * Toggles the login password field between type="password" and type="text".
 * Preserves the entered value and cursor position.
 * Does NOT trigger login or reset validation state.
 */
function toggleLoginPassword() {
  const input      = document.getElementById('login-password');
  const eyeIcon    = document.getElementById('login-eye-icon');
  const eyeOffIcon = document.getElementById('login-eye-off-icon');
  const btn        = document.getElementById('login-pw-toggle');

  if (!input) return;

  // Save cursor position (selectionStart/End are lost on type change in some browsers)
  const selStart = input.selectionStart;
  const selEnd   = input.selectionEnd;

  if (input.type === 'password') {
    input.type = 'text';
    if (eyeIcon)    eyeIcon.style.display    = 'none';
    if (eyeOffIcon) eyeOffIcon.style.display = '';
    if (btn) btn.setAttribute('aria-label', 'Hide password');
  } else {
    input.type = 'password';
    if (eyeIcon)    eyeIcon.style.display    = '';
    if (eyeOffIcon) eyeOffIcon.style.display = 'none';
    if (btn) btn.setAttribute('aria-label', 'Show password');
  }

  // Restore cursor position
  try {
    input.setSelectionRange(selStart, selEnd);
  } catch (_) {}

  // Return focus to input (keyboard accessibility)
  input.focus();
}

async function handleLogin() {
  const email   = document.getElementById('login-email').value.trim().toLowerCase();
  const pw      = document.getElementById('login-password').value;
  const alertEl = document.getElementById('login-alert');
  const btn     = document.querySelector('#view-login .btn-primary');

  // Clear any stale error immediately (before the async request)
  alertEl.className = 'hidden';
  alertEl.innerHTML = '';

  // Basic presence checks
  if (!email || !pw) {
    showTempError(alertEl, 'Please fill in all fields.', 3000);
    return;
  }

  // Disable button during request
  if (btn) { btn.disabled = true; btn.textContent = 'Logging in…'; }


  try {
    const data = await API.login({ email, password: pw });

    if (data.success) {
      // Store user profile from server (no password)
      AppState.currentUser = data.user;
      alertEl.className = 'hidden';

      // Persist session to localStorage so refresh doesn't log out
      AppState.saveSession();

      // Authenticate Firebase Client SDK (for Firestore chat + RTDB signaling)
      if (typeof window.authenticateFirebaseClient === 'function') {
        window.authenticateFirebaseClient(data.user.uid).catch(() => {});
      }

      // Clear inputs
      document.getElementById('login-email').value    = '';
      document.getElementById('login-password').value = '';

      // Check for a pending invite (from /invite/:token URL or join-code entered pre-login)
      if (typeof resumePendingInvite === 'function') {
        const handled = await resumePendingInvite(data.user);
        if (handled) return; // invite.js will navigate to workspace
      }

      // No pending invite → go to dashboard and load suites
      navigate('view-dashboard');
      loadUserSuites();
    } else {
      // Display server error message (exact text from spec)
      showTempError(alertEl, data.error || 'Login failed. Please try again.', 5000);
    }
  } catch (err) {
    // err.message contains full LAN guidance from api.js apiFetch()
    const msg = err.message.includes('Cannot connect')
      ? '⚠️ Cannot connect to server. Check that both devices are on the same Wi-Fi/LAN and the backend is running.'
      : '⚠️ Server unreachable. Is the backend running?';
    showTempError(alertEl, msg, 6000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
  }
}
