'use strict';

const emailConfig = require('../config/email');

/* ══════════════════════════════════════════════════════════════
   HTML TEMPLATES
   ══════════════════════════════════════════════════════════════ */

function emailWrapper(bodyContent) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;background:#e9f7fe;font-family:Inter,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #dee2e6;box-shadow:0 8px 40px rgba(0,123,255,0.1);">
    <div style="background:#212529;padding:20px 24px;">
      <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:0.04em;">🔗 CoLearn</span>
    </div>
    <div style="padding:32px 24px;">
      ${bodyContent}
    </div>
    <div style="background:#f8f9fa;padding:12px 24px;border-top:1px solid #dee2e6;text-align:center;">
      <span style="color:#adb5bd;font-size:12px;">CoLearn · Collaborative Study Platform</span>
    </div>
  </div>
</body>
</html>`;
}

function otpBox(otp) {
  return `
    <div style="background:#e9f7fe;border:2px dashed #007bff;border-radius:12px;padding:24px;text-align:center;margin:20px 0;">
      <span style="font-size:36px;font-weight:800;letter-spacing:0.25em;color:#004085;font-family:monospace;">${otp}</span>
    </div>
    <p style="color:#adb5bd;font-size:12px;margin:0;">
      If you didn't request this code, you can safely ignore this email.
    </p>`;
}

/* ══════════════════════════════════════════════════════════════
   CORE SEND HELPER
   ══════════════════════════════════════════════════════════════ */

/**
 * Internal mailer – sends an email via the SMTP transporter.
 *
 * SECURITY:
 *  - The subject NEVER contains the OTP.
 *  - Logs NEVER contain the OTP, subject, or SMTP password.
 *  - Only safe metadata is logged: Recipient, Purpose, Message ID.
 *
 * @param {string} toEmail    - Recipient's email address (from req.body.email)
 * @param {string} subject    - Non-sensitive subject line (no OTP)
 * @param {string} html       - HTML email body (OTP inside, not logged)
 * @param {string} text       - Plain-text fallback
 * @param {string} purpose    - Human label for logs: 'Signup Verification' | 'Password Reset'
 */
async function sendEmailCore(toEmail, subject, html, text, purpose) {
  const recipient = toEmail.toLowerCase().trim();

  if (!emailConfig.configured || !emailConfig.transporter) {
    // No SMTP — print safe fallback (no OTP in output)
    consoleFallback(purpose, recipient);
    return;
  }

  const mailOptions = {
    from:    `"${emailConfig.FROM_NAME}" <${emailConfig.SMTP_USER}>`,
    to:      recipient,   // ← Always the requesting user's email. NEVER hardcoded.
    subject,              // ← Never contains OTP
    html,
    text,
  };

  let info;
  try {
    info = await emailConfig.transporter.sendMail(mailOptions);
  } catch (err) {
    // Differentiated error handling — no secrets exposed in log
    const msg = err.message || '';
    if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
      console.error(`[Email] SMTP CONNECTION FAILURE — check SMTP_USER/host config`);
    } else if (msg.includes('535') || msg.toLowerCase().includes('authentication')) {
      console.error(`[Email] SMTP AUTHENTICATION FAILURE — check SMTP_PASS in .env`);
    } else if (msg.includes('550') || msg.toLowerCase().includes('invalid recipient')) {
      console.error(`[Email] INVALID RECIPIENT — ${recipient}`);
    } else if (msg.includes('421') || msg.includes('451') || msg.toLowerCase().includes('rate')) {
      console.error(`[Email] RATE LIMIT EXCEEDED — wait before retrying`);
    } else {
      console.error(`[Email] SEND FAILED — ${err.code || 'unknown error'}`);
    }
    throw err;
  }

  // ── Safe success log (no OTP, no subject) ────────────────────
  const divider = '─'.repeat(48);
  if (process.env.NODE_ENV !== 'production' || true) {
    console.log(`\n${divider}`);
    console.log(`  OTP Email Sent`);
    console.log(`  Recipient  : ${recipient}`);
    console.log(`  Purpose    : ${purpose}`);
    console.log(`  SMTP       : Success`);
    console.log(`  Message ID : ${info.messageId}`);
    console.log(`${divider}\n`);
  }
}

/* ══════════════════════════════════════════════════════════════
   PUBLIC API
   ══════════════════════════════════════════════════════════════ */

/**
 * Send a signup OTP email.
 * Subject: "CoLearn Email Verification" (NO OTP in subject)
 * OTP appears only inside the email body.
 *
 * @param {string} toEmail - The registering user's email from req.body.email
 * @param {string} otp     - Plaintext OTP (embedded in body only, never logged)
 */
async function sendOTPEmail(toEmail, otp) {
  const html = emailWrapper(`
    <h2 style="margin:0 0 8px;color:#212529;font-size:20px;font-weight:700;">Verify Your Email</h2>
    <p style="color:#6c757d;font-size:14px;margin:0 0 16px;line-height:1.6;">
      Your CoLearn verification code is:
    </p>
    ${otpBox(otp)}
    <p style="color:#6c757d;font-size:13px;margin-top:16px;line-height:1.5;">
      This OTP is valid for <strong>5 minutes</strong>.<br>
      Do not share this code with anyone.
    </p>
  `);

  if (emailConfig.configured) {
    await sendEmailCore(
      toEmail,
      'CoLearn Email Verification',   // ← No OTP in subject
      html,
      `Your CoLearn verification code is in the email body.\nDo not share it with anyone. Valid for 5 minutes.`,
      'Signup Verification'
    );
  } else {
    consoleFallback('Signup Verification', toEmail);
  }
}

/**
 * Send a password-reset OTP email.
 * Subject: "CoLearn Password Reset" (NO OTP in subject)
 * OTP appears only inside the email body.
 *
 * @param {string} toEmail - The account owner's registered email (from Firestore)
 * @param {string} otp     - Plaintext OTP (embedded in body only, never logged)
 */
async function sendResetOTPEmail(toEmail, otp) {
  const html = emailWrapper(`
    <h2 style="margin:0 0 8px;color:#212529;font-size:20px;font-weight:700;">Password Reset Request</h2>
    <p style="color:#6c757d;font-size:14px;margin:0 0 16px;line-height:1.6;">
      We received a request to reset your CoLearn account password.<br>
      Your password reset code is:
    </p>
    ${otpBox(otp)}
    <p style="color:#6c757d;font-size:13px;margin-top:16px;line-height:1.5;">
      This OTP is valid for <strong>5 minutes</strong>.<br>
      Do not share this code with anyone.<br>
      If you did not request a password reset, you can safely ignore this email.
    </p>
  `);

  if (emailConfig.configured) {
    await sendEmailCore(
      toEmail,
      'CoLearn Password Reset',       // ← No OTP in subject
      html,
      `Your CoLearn password reset code is in the email body.\nDo not share it. Valid for 5 minutes.`,
      'Password Reset'
    );
  } else {
    consoleFallback('Password Reset', toEmail);
  }
}

/* ══════════════════════════════════════════════════════════════
   CONSOLE FALLBACK  (SMTP not configured — dev only)
   ══════════════════════════════════════════════════════════════ */

/**
 * SECURITY: This function deliberately does NOT log the OTP.
 * In dev mode without SMTP, the developer should check the OTP
 * by querying the store or temporarily adding a breakpoint.
 *
 * The OTP is only sent via email in production.
 */
function consoleFallback(purpose, toEmail) {
  const line = '═'.repeat(52);
  console.log('\n' + line);
  console.log(`  OTP Email (SMTP not configured)`);
  console.log(`  Recipient  : ${toEmail}`);
  console.log(`  Purpose    : ${purpose}`);
  console.log(`  SMTP       : Not configured — email not sent`);
  console.log(`  Action     : Set SMTP_USER and SMTP_PASS in backend/.env`);
  console.log(`               to enable real email delivery.`);
  console.log(line + '\n');
}

/**
 * Send a suite invitation email.
 * Subject: "You're invited to join a CoLearn Suite"
 *
 * @param {string} toEmail    - Recipient's email address
 * @param {string} suiteName  - Name of the suite they're invited to
 * @param {string} inviteCode - 5-digit invite code
 * @param {string} inviteUrl  - Full invite link (production URL)
 */
async function sendInviteEmail(toEmail, suiteName, inviteCode, inviteUrl) {
  const html = emailWrapper(`
    <h2 style="margin:0 0 8px;color:#212529;font-size:20px;font-weight:700;">🎉 You're Invited!</h2>
    <p style="color:#6c757d;font-size:14px;margin:0 0 16px;line-height:1.6;">
      You've been invited to join a collaborative study suite on
      <strong style="color:#007bff;">CoLearn</strong>.
    </p>

    <!-- Suite name badge -->
    <div style="background:#e9f7fe;border-radius:10px;padding:14px 18px;margin-bottom:20px;border-left:4px solid #007bff;">
      <div style="font-size:11px;font-weight:600;color:#6c757d;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Suite Name</div>
      <div style="font-size:18px;font-weight:800;color:#004085;">${escapeHtmlEmail(suiteName)}</div>
    </div>

    <!-- Invite code -->
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:600;color:#495057;margin-bottom:8px;">📋 Your 5-Digit Invite Code</div>
      <div style="background:#212529;border-radius:12px;padding:20px;text-align:center;">
        <span style="font-size:40px;font-weight:800;letter-spacing:0.35em;color:#ffffff;font-family:monospace;">${escapeHtmlEmail(inviteCode)}</span>
      </div>
      <p style="color:#adb5bd;font-size:11px;margin:8px 0 0;text-align:center;">
        Enter this code on CoLearn → Home → Join Suite
      </p>
    </div>

    <!-- Divider -->
    <div style="display:flex;align-items:center;gap:12px;margin:20px 0;">
      <div style="flex:1;height:1px;background:#dee2e6;"></div>
      <span style="color:#adb5bd;font-size:12px;font-weight:600;">OR</span>
      <div style="flex:1;height:1px;background:#dee2e6;"></div>
    </div>

    <!-- Invite link button -->
    <div style="text-align:center;margin-bottom:20px;">
      <a href="${inviteUrl}"
         style="display:inline-block;background:linear-gradient(135deg,#007bff,#0056b3);color:#ffffff;
                text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;
                font-size:15px;letter-spacing:0.02em;">
        🔗 Click to Join Suite
      </a>
    </div>

    <!-- Link fallback -->
    <div style="background:#f8f9fa;border-radius:8px;padding:12px 14px;margin-bottom:16px;">
      <div style="font-size:11px;color:#6c757d;margin-bottom:4px;">Or copy this link:</div>
      <div style="font-size:11px;color:#007bff;word-break:break-all;font-family:monospace;">${escapeHtmlEmail(inviteUrl)}</div>
    </div>

    <p style="color:#adb5bd;font-size:11px;margin:0;line-height:1.5;">
      ⚠️ This invitation is valid only while the Suite Host is online.<br>
      If the host is offline, request a new invitation.
    </p>
  `);

  const text = [
    `You're invited to join a CoLearn Suite!`,
    ``,
    `Suite: ${suiteName}`,
    ``,
    `5-Digit Invite Code: ${inviteCode}`,
    `(Enter on CoLearn → Home → Join Suite)`,
    ``,
    `Or click the invite link:`,
    inviteUrl,
    ``,
    `This invitation is valid only while the Suite Host is online.`,
  ].join('\n');

  if (emailConfig.configured) {
    await sendEmailCore(
      toEmail,
      `You're invited to join a CoLearn Suite`,
      html,
      text,
      'Suite Invitation'
    );
  } else {
    console.log('\n' + '═'.repeat(52));
    console.log(`  Suite Invitation (SMTP not configured)`);
    console.log(`  Recipient  : ${toEmail}`);
    console.log(`  Suite      : ${suiteName}`);
    console.log(`  Code       : ${inviteCode}`);
    console.log(`  Link       : ${inviteUrl}`);
    console.log('═'.repeat(52) + '\n');
  }
}

/** Escapes HTML special chars in email template values. */
function escapeHtmlEmail(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { sendOTPEmail, sendResetOTPEmail, sendInviteEmail };
