/* ── VIEW 2 – Sign Up (2-step: fill fields → validate → send OTP → verify) */

/* ─ Password strength meter ─────────────────────────────────── */
function checkPWStrength() {
  const pw  = document.getElementById('signup-password').value;
  const bar = document.getElementById('pw-strength-bar');
  const lbl = document.getElementById('pw-strength-label');
  if (!bar || !lbl) return;

  let score = 0;
  if (pw.length >= 8)             score++;
  if (pw.length >= 12)            score++;
  if (/[A-Z]/.test(pw))          score++;
  if (/[0-9]/.test(pw))          score++;
  if (/[^A-Za-z0-9]/.test(pw))  score++;

  const levels = [
    { pct:'0%',   color:'#dee2e6', label:'' },
    { pct:'25%',  color:'#dc3545', label:'Weak' },
    { pct:'50%',  color:'#ffc107', label:'Fair' },
    { pct:'75%',  color:'#17a2b8', label:'Good' },
    { pct:'100%', color:'#28a745', label:'Strong ✓' },
  ];
  const lvl = levels[Math.min(score, 4)];
  bar.style.width      = lvl.pct;
  bar.style.background = lvl.color;
  lbl.textContent      = pw ? lvl.label : '';
  lbl.style.color      = lvl.color;
}

/* ─ Client-side password validation (mirrors backend rules) ──── */
function validatePassword(password) {
  if (!password || password.length < 8)
    return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(password))
    return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(password))
    return 'Password must contain at least one lowercase letter.';
  if (!/[0-9]/.test(password))
    return 'Password must contain at least one number.';
  if (!/[^A-Za-z0-9]/.test(password))
    return 'Password must contain at least one special character (e.g. @, #, $).';
  return null;
}

/* ─ OTP countdown UI ─────────────────────────────────────────── */
/**
 * OTP validity  : CONFIG.OTP_TTL seconds (300s = 5 minutes)
 * Resend enable : After RESEND_LOCKOUT_SEC seconds (60s)
 *
 * The progress bar counts down from 5 min.
 * The "Send OTP" button re-enables after 60 seconds regardless of expiry.
 */
const RESEND_LOCKOUT_SEC = 60; // seconds before resend is allowed

function startOTPCountdown() {
  const wrap    = document.getElementById('otp-countdown-wrap');
  const barEl   = document.getElementById('otp-progress-bar');
  const timerEl = document.getElementById('otp-timer-text');
  const sendBtn = document.getElementById('btn-send-otp');
  if (!wrap) return;

  wrap.style.display    = 'flex';
  sendBtn.disabled      = true;
  sendBtn.style.opacity = '0.5';
  sendBtn.style.cursor  = 'not-allowed';

  // Track when resend lock expires (60s from now)
  const resendUnlockAt = Date.now() + RESEND_LOCKOUT_SEC * 1000;

  if (AppState.otpTimerHandle) clearInterval(AppState.otpTimerHandle);

  AppState.otpTimerHandle = setInterval(() => {
    const now       = Date.now();
    const remaining = Math.max(0, Math.ceil((AppState.otpExpiry - now) / 1000));
    const pct       = (remaining / CONFIG.OTP_TTL) * 100;

    barEl.style.width   = pct + '%';
    timerEl.textContent = remaining + 's';

    // Color warning at 30s remaining
    if (remaining <= 30) {
      barEl.classList.add('expiring');
      timerEl.classList.add('expiring');
    } else {
      barEl.classList.remove('expiring');
      timerEl.classList.remove('expiring');
    }

    // Unlock resend button after 60 seconds
    if (now >= resendUnlockAt && sendBtn.disabled) {
      sendBtn.disabled      = false;
      sendBtn.style.opacity = '1';
      sendBtn.style.cursor  = 'pointer';
      sendBtn.textContent   = 'Resend OTP';
    }

    // OTP fully expired
    if (remaining === 0) {
      clearInterval(AppState.otpTimerHandle);
      AppState.otpSent   = false;
      AppState.otpExpiry = 0;
      wrap.style.display    = 'none';
      sendBtn.disabled      = false;
      sendBtn.style.opacity = '1';
      sendBtn.style.cursor  = 'pointer';
      sendBtn.textContent   = 'Send OTP';
      const alertEl = document.getElementById('signup-alert');
      if (alertEl) showTempError(alertEl, '⏱ OTP expired. Please request a new one.', 4000);
    }
  }, 1000);
}

/* ─ STEP 1: "Continue" – validate all fields, then send OTP ──── */
/**
 * Issue 8 fix: OTP is NOT sent until the user clicks "Continue"
 * after filling ALL fields correctly. The "Send OTP" button is
 * now HIDDEN until Continue is clicked.
 *
 * Flow:
 *   Fill form → Continue → validate → send OTP → show OTP field
 */
async function handleSignupContinue() {
  const name     = document.getElementById('signup-name').value.trim();
  const username = document.getElementById('signup-username').value.trim().toLowerCase();
  const email    = document.getElementById('signup-email').value.trim().toLowerCase();
  const password = document.getElementById('signup-password').value;
  const confirm  = document.getElementById('signup-confirm-password').value;
  const alertEl  = document.getElementById('signup-alert');
  const contBtn  = document.getElementById('btn-signup-continue');

  // 1. All fields present
  if (!name) { showTempError(alertEl, 'Please enter your full name.', 3000); return; }
  if (!username) { showTempError(alertEl, 'Please enter a username.', 3000); return; }
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    showTempError(alertEl, 'Username: 3-30 chars, letters/numbers/underscores only.', 3000);
    return;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showTempError(alertEl, 'Please enter a valid email address.', 3000);
    return;
  }

  // 2. Password validation
  const pwErr = validatePassword(password);
  if (pwErr) { showTempError(alertEl, pwErr, 4000); return; }

  // 3. Password match
  if (password !== confirm) {
    showTempError(alertEl, '❌ Passwords do not match.', 3000);
    return;
  }

  // 4. Send OTP to the validated email
  if (contBtn) { contBtn.disabled = true; contBtn.textContent = 'Sending OTP…'; }

  try {
    const data = await API.sendOTP(email);

    if (data.success) {
      AppState.otpSent   = true;
      AppState.otpExpiry = Date.now() + CONFIG.OTP_TTL * 1000;

      // Show OTP section, hide Continue
      const otpSection = document.getElementById('signup-otp-section');
      const contSection = document.getElementById('signup-continue-section');
      if (otpSection)  otpSection.style.display  = 'block';
      if (contSection) contSection.style.display = 'none';

      showAlert(alertEl, 'success',
        `✉️ OTP sent to <strong>${escapeHtml(email)}</strong>. Check your inbox!`);
      setTimeout(() => { if (alertEl) alertEl.className = 'hidden'; }, 6000);

      startOTPCountdown();
    } else {
      if (contBtn) { contBtn.disabled = false; contBtn.textContent = 'Continue'; }
      showTempError(alertEl, data.error || 'Failed to send OTP. Try again.', 4000);
    }
  } catch (err) {
    if (contBtn) { contBtn.disabled = false; contBtn.textContent = 'Continue'; }
    showTempError(alertEl, err.message.includes('Cannot connect')
      ? '⚠️ Cannot connect to server. Check Wi-Fi/LAN and backend.'
      : '⚠️ Server unreachable.', 5000);
  }
}

/* ─ Resend OTP (standalone, callable from hidden Send OTP button) */
async function sendOTP() {
  const email   = document.getElementById('signup-email').value.trim().toLowerCase();
  const alertEl = document.getElementById('signup-alert');
  const sendBtn = document.getElementById('btn-send-otp');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showTempError(alertEl, 'Please enter a valid email address first.', 3000);
    return;
  }

  sendBtn.disabled      = true;
  sendBtn.textContent   = 'Sending…';
  sendBtn.style.opacity = '0.7';

  try {
    const data = await API.sendOTP(email);
    if (data.success) {
      AppState.otpSent   = true;
      AppState.otpExpiry = Date.now() + CONFIG.OTP_TTL * 1000;
      sendBtn.textContent   = 'Sent ✓';
      sendBtn.style.opacity = '1';
      showAlert(alertEl, 'success',
        `✉️ New OTP sent to <strong>${escapeHtml(email)}</strong>.`);
      setTimeout(() => { if (alertEl) alertEl.className = 'hidden'; }, 5000);
      startOTPCountdown();
    } else {
      sendBtn.disabled      = false;
      sendBtn.textContent   = 'Resend OTP';
      sendBtn.style.opacity = '1';
      sendBtn.style.cursor  = 'pointer';
      showTempError(alertEl, data.error || 'Failed to send OTP.', 4000);
    }
  } catch (err) {
    sendBtn.disabled      = false;
    sendBtn.textContent   = 'Resend OTP';
    sendBtn.style.opacity = '1';
    sendBtn.style.cursor  = 'pointer';
    showTempError(alertEl, '⚠️ Server unreachable.', 4000);
  }
}

/* ─ STEP 2: Sign Up submit – verify OTP + register account ───── */
async function handleSignup() {
  const name     = document.getElementById('signup-name').value.trim();
  const username = document.getElementById('signup-username').value.trim().toLowerCase();
  const email    = document.getElementById('signup-email').value.trim().toLowerCase();
  const password = document.getElementById('signup-password').value;
  const confirm  = document.getElementById('signup-confirm-password').value;
  const otp      = document.getElementById('signup-otp').value.trim();
  const alertEl  = document.getElementById('signup-alert');
  const submitBtn = document.getElementById('btn-signup-submit');

  // Validate OTP entry
  if (!AppState.otpSent) {
    showTempError(alertEl, 'Please click "Continue" first to receive your OTP.', 3000);
    return;
  }
  if (!otp || otp.length !== 6) {
    showTempError(alertEl, 'Please enter the 6-digit OTP sent to your email.', 3000);
    return;
  }

  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Verifying…'; }

  // 1. Verify OTP
  try {
    const otpData = await API.verifyOTP(email, otp);
    if (!otpData.success) {
      showTempError(alertEl, otpData.error || 'Invalid OTP. Please try again.', 3000);
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Account'; }
      return;
    }
  } catch (err) {
    showTempError(alertEl, '⚠️ Server error. Please try again.', 3000);
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Account'; }
    return;
  }

  // 2. Register account via Firebase (backend)
  if (submitBtn) submitBtn.textContent = 'Creating account…';

  try {
    const data = await API.register({ name, username, email, password, confirm });

    if (data.success) {
      // Clean up OTP state
      if (AppState.otpTimerHandle) clearInterval(AppState.otpTimerHandle);
      AppState.otpSent   = false;
      AppState.otpExpiry = 0;

      showAlert(alertEl, 'success', '✅ Account created! Redirecting to login…');

      // Reset form
      ['signup-name','signup-username','signup-email','signup-otp',
       'signup-password','signup-confirm-password'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });

      // Reset step visibility
      const otpSection  = document.getElementById('signup-otp-section');
      const contSection = document.getElementById('signup-continue-section');
      if (otpSection)  otpSection.style.display  = 'none';
      if (contSection) contSection.style.display = 'block';

      const wrap = document.getElementById('otp-countdown-wrap');
      if (wrap) wrap.style.display = 'none';

      const bar = document.getElementById('pw-strength-bar');
      if (bar) bar.style.width = '0%';
      const lbl = document.getElementById('pw-strength-label');
      if (lbl) lbl.textContent = '';

      const sendBtn = document.getElementById('btn-send-otp');
      if (sendBtn) {
        sendBtn.disabled      = false;
        sendBtn.textContent   = 'Send OTP';
        sendBtn.style.opacity = '1';
        sendBtn.style.cursor  = 'pointer';
      }

      setTimeout(() => navigate('view-login'), 1800);
    } else {
      // Use data.message first (spec-required text), then data.error as fallback
      showTempError(alertEl, data.message || data.error || 'Registration failed. Please try again.', 5000);
    }
  } catch (err) {
    showTempError(alertEl, '⚠️ Server error. Please try again.', 3000);
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Account'; }
  }
}
