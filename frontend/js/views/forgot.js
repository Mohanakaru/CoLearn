/* ── VIEW 3 – Forgot Password (3-step flow) ──────────────────── */
/*
 *  Step 1: User enters email  → sendResetOTP()
 *  Step 2: User enters OTP   → verifyStep()
 *  Step 3: User sets password → handleResetPassword()
 */

/* ─ Navigate to a step panel ─────────────────────────────────── */
function showForgotStep(step) {
  [1, 2, 3].forEach(n => {
    const el = document.getElementById(`forgot-step${n}`);
    if (el) el.style.display = (n === step) ? (n === 1 ? 'block' : 'flex') : 'none';
  });
}

/* ─ Step 1: Send OTP ─────────────────────────────────────────── */
async function sendResetOTP() {
  const email   = document.getElementById('forgot-email').value.trim().toLowerCase();
  const alertEl = document.getElementById('forgot-alert');
  const btn     = document.getElementById('btn-reset-request');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showTempError(alertEl, 'Please enter a valid email address.', 3000);
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    const data = await API.sendResetOTP(email);

    if (data.success) {
      AppState.resetEmail       = email;
      AppState.resetOtpVerified = false;

      showAlert(alertEl, 'success',
        `✉️ Reset OTP sent to <strong>${escapeHtml(email)}</strong>. Check your inbox!`);
      setTimeout(() => { if (alertEl) alertEl.className = 'hidden'; }, 5000);

      if (btn) { btn.disabled = false; btn.textContent = 'Resend OTP'; }
      showForgotStep(2);
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Request Reset Link'; }
      showTempError(alertEl, data.error || 'Failed to send OTP.', 4000);
    }
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = 'Request Reset Link'; }
    showTempError(alertEl, '⚠️ Server unreachable. Is the backend running?', 4000);
  }
}

/* ─ Step 2: Verify OTP ───────────────────────────────────────── */
async function verifyResetStep() {
  const otp     = document.getElementById('forgot-otp').value.trim();
  const alertEl = document.getElementById('forgot-alert');
  const btn     = document.getElementById('btn-verify-otp');

  if (!otp) {
    showTempError(alertEl, 'Please enter the OTP sent to your email.', 3000);
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }

  try {
    const data = await API.verifyResetOTP(AppState.resetEmail, otp);

    if (data.success) {
      AppState.resetOtpVerified = true;
      showAlert(alertEl, 'success', '✅ OTP verified! Please set your new password.');
      setTimeout(() => { if (alertEl) alertEl.className = 'hidden'; }, 3000);
      showForgotStep(3);
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Verify OTP'; }
      showTempError(alertEl, data.error || 'Invalid OTP. Please try again.', 4000);
    }
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = 'Verify OTP'; }
    showTempError(alertEl, '⚠️ Server error. Please try again.', 3000);
  }
}

/* ─ Step 3: Reset Password ───────────────────────────────────── */
async function handleResetPassword() {
  const newpw   = document.getElementById('forgot-newpw').value;
  const confirm = document.getElementById('forgot-confirmpw').value;
  const alertEl = document.getElementById('forgot-alert');
  const btn     = document.getElementById('btn-reset-password');

  if (!AppState.resetOtpVerified) {
    showTempError(alertEl, 'Please verify your OTP first.', 3000);
    return;
  }

  if (!newpw || !confirm) {
    showTempError(alertEl, 'Please fill in both password fields.', 3000);
    return;
  }
  if (newpw !== confirm) {
    showTempError(alertEl, '❌ Passwords do not match.', 3000);
    return;
  }

  // Client-side strength check
  if (newpw.length < 8) {
    showTempError(alertEl, 'Password must be at least 8 characters.', 3000);
    return;
  }
  if (!/[A-Z]/.test(newpw)) {
    showTempError(alertEl, 'Password must contain at least one uppercase letter.', 3000);
    return;
  }
  if (!/[a-z]/.test(newpw)) {
    showTempError(alertEl, 'Password must contain at least one lowercase letter.', 3000);
    return;
  }
  if (!/[0-9]/.test(newpw)) {
    showTempError(alertEl, 'Password must contain at least one number.', 3000);
    return;
  }
  if (!/[^A-Za-z0-9]/.test(newpw)) {
    showTempError(alertEl, 'Password must contain at least one special character (e.g. @, #, $).', 3000);
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }

  try {
    const data = await API.resetPassword({
      email:       AppState.resetEmail,
      newPassword: newpw,
      confirm,
    });

    if (data.success) {
      showAlert(alertEl, 'success', '✅ Password updated successfully! Redirecting to login…');

      // Reset all state and form fields
      AppState.resetEmail       = '';
      AppState.resetOtpVerified = false;

      ['forgot-email','forgot-otp','forgot-newpw','forgot-confirmpw'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });

      showForgotStep(1);
      const resetBtn = document.getElementById('btn-reset-request');
      if (resetBtn) { resetBtn.disabled = false; resetBtn.textContent = 'Request Reset Link'; }

      setTimeout(() => {
        alertEl.className = 'hidden';
        navigate('view-login');
      }, 1800);
    } else {
      showTempError(alertEl, data.error || 'Failed to reset password.', 4000);
    }
  } catch {
    showTempError(alertEl, '⚠️ Server error. Please try again.', 3000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Reset Password'; }
  }
}
