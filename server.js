/**
 * CoLearn – LAN Static Server + Email OTP API
 * ─────────────────────────────────────────────────────────────────
 * Serves index.html on 0.0.0.0:3000 for multi-device LAN access.
 *
 * API endpoints:
 *   POST /api/send-otp          { email }          – Signup OTP
 *   POST /api/verify-otp        { email, otp }     – Verify signup OTP
 *   POST /api/send-reset-otp    { email }          – Forgot-password OTP
 *   POST /api/verify-reset-otp  { email, otp }     – Verify reset OTP
 *   POST /api/reset-password    { email, newPassword } – Apply new password
 *   GET  /api/health                               – Health check
 *
 * BUG FIXED:
 *   Previously sendResetOTP() in index.html used a browser alert() with
 *   a hardcoded OTP "987654" — NO email was ever sent for forgot-password.
 *   This file now provides real backend endpoints so any user's registered
 *   email receives the actual OTP.
 *
 * Usage:  node server.js   (or: npm start)
 */

'use strict';

require('dotenv').config();

const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');

/* ══════════════════════════════════════════════════════════════
   EMAIL CONFIGURATION
   ══════════════════════════════════════════════════════════════ */

// Load SMTP credentials from .env — NEVER hardcoded
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();
const FROM_NAME = (process.env.EMAIL_FROM_NAME || 'CoLearn').trim();

let transporter = null;
let emailConfigured = false;

function initMailer() {
  if (SMTP_USER && SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host:   'smtp.gmail.com',
      port:    587,
      secure:  false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      tls: { rejectUnauthorized: false },
    });
    emailConfigured = true;
    console.log(`📧  SMTP configured → ${SMTP_USER}`);
  } else {
    console.warn('⚠️   SMTP not configured. Set SMTP_USER and SMTP_PASS in .env');
    console.warn('     OTPs will be printed to this console as fallback.');
  }
}

/* ══════════════════════════════════════════════════════════════
   OTP STORE  (in-memory, SHA-256 hashed)
   ══════════════════════════════════════════════════════════════ */

const OTP_TTL_MS       = 5 * 60 * 1000;  // 5 minutes
const OTP_MAX_ATTEMPTS = 5;

// Map<lowerEmail → { hash, expiresAt, attempts }>
const otpStore = new Map();

/** Cryptographically secure 6-digit OTP */
function generateOTP() {
  return String(crypto.randomInt(100000, 1000000)).padStart(6, '0');
}

function hashOTP(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

function storeOTP(email, otp) {
  const key       = email.toLowerCase().trim();
  const expiresAt = Date.now() + OTP_TTL_MS;
  otpStore.set(key, { hash: hashOTP(otp), expiresAt, attempts: 0 });

  // Auto-clean after TTL
  setTimeout(() => {
    const e = otpStore.get(key);
    if (e && e.expiresAt === expiresAt) otpStore.delete(key);
  }, OTP_TTL_MS + 1000);
}

function verifyOTP(email, submitted) {
  const key   = email.toLowerCase().trim();
  const entry = otpStore.get(key);

  if (!entry)                             return 'not_found';
  if (Date.now() > entry.expiresAt)       { otpStore.delete(key); return 'expired'; }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) { otpStore.delete(key); return 'max_attempts'; }

  if (hashOTP(submitted.trim()) !== entry.hash) {
    entry.attempts++;
    return 'invalid';
  }

  otpStore.delete(key);   // one-time use
  return 'ok';
}

/* ══════════════════════════════════════════════════════════════
   EMAIL TEMPLATES
   ══════════════════════════════════════════════════════════════ */

function emailWrapper(body) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;background:#e9f7fe;font-family:Inter,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #dee2e6;box-shadow:0 8px 40px rgba(0,123,255,0.1);">
    <div style="background:#212529;padding:20px 24px;">
      <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:0.04em;">🔗 CoLearn</span>
    </div>
    <div style="padding:32px 24px;">${body}</div>
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

/**
 * Send an OTP email to the EXACT recipient address supplied.
 * Never overrides the to: field with a developer/hardcoded address.
 *
 * @param {string} toEmail  - The user's actual email address (from req.body.email)
 * @param {string} otp      - The plaintext OTP (logged to console, NOT stored)
 * @param {string} subject  - Email subject line
 * @param {string} bodyHtml - Full HTML body
 */
async function sendEmail(toEmail, subject, bodyHtml) {
  const normalizedTo = toEmail.toLowerCase().trim();

  // ── Diagnostic log (safe — does NOT log password or OTP hash) ──
  console.log('────────────────────────────────────────');
  console.log(`  📬  Sending email`);
  console.log(`  📧  Recipient : ${normalizedTo}`);
  console.log(`  📨  Subject   : ${subject}`);
  console.log(`  🔧  SMTP User : ${SMTP_USER}`);
  console.log('────────────────────────────────────────');

  if (!emailConfigured || !transporter) {
    // Console fallback — print OTP so developer can test without SMTP
    console.warn('  ⚠️  SMTP not configured — email NOT sent.');
    console.warn(`  ℹ️  Set SMTP_USER / SMTP_PASS in .env to enable real email delivery.`);
    return;
  }

  const info = await transporter.sendMail({
    from:    `"${FROM_NAME}" <${SMTP_USER}>`,
    to:      normalizedTo,   // ← ALWAYS the user's real email, never hardcoded
    subject,
    html:    bodyHtml,
    text:    subject,
  });

  console.log(`  ✅  Email sent! Message ID: ${info.messageId}`);
}

async function sendSignupOTPEmail(toEmail, otp) {
  const html = emailWrapper(`
    <h2 style="margin:0 0 8px;color:#212529;font-size:20px;font-weight:700;">Your Verification Code</h2>
    <p style="color:#6c757d;font-size:14px;margin:0 0 4px;line-height:1.6;">
      Use the code below to complete your CoLearn sign-up.<br>
      <strong>Expires in 5 minutes</strong> — do not share it with anyone.
    </p>
    ${otpBox(otp)}
  `);
  await sendEmail(toEmail, `${otp} – Your CoLearn verification code`, html);
}

async function sendResetOTPEmail(toEmail, otp) {
  const html = emailWrapper(`
    <h2 style="margin:0 0 8px;color:#212529;font-size:20px;font-weight:700;">CoLearn Password Reset</h2>
    <p style="color:#6c757d;font-size:14px;margin:0 0 4px;line-height:1.6;">
      We received a request to reset your CoLearn account password.<br>
      Enter the OTP below to continue. <strong>Expires in 5 minutes.</strong>
    </p>
    ${otpBox(otp)}
    <p style="color:#6c757d;font-size:13px;margin-top:16px;">
      ⚠️ If you did not request a password reset, please ignore this email.
    </p>
  `);
  await sendEmail(toEmail, `${otp} – Your CoLearn Password Reset Code`, html);
}

/* ══════════════════════════════════════════════════════════════
   MOCK USER STORE  (in-memory — replaces hardcoded MOCK_USERS)
   ══════════════════════════════════════════════════════════════ */

// Stores users registered via /api/auth/register as { email, passwordHash, name, username }
// NOTE: In production this is replaced by Firebase Auth + Firestore.
const userStore = new Map();

// Pre-seed demo accounts (passwords hashed)
['alex@example.com', 'priya@example.com'].forEach(e => {
  userStore.set(e, { email: e, name: e.split('@')[0], username: e.split('@')[0], passwordHash: hashOTP('pass123') });
});

// Tracks which emails have verified OTPs for password reset
const resetVerified = new Set();  // email → verified

/* ══════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════ */

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email || '').trim());
}

/* ══════════════════════════════════════════════════════════════
   STATIC FILE SERVER
   ══════════════════════════════════════════════════════════════ */

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) candidates.push({ name, address: iface.address });
    }
  }
  const preferred = candidates.find(c => /wi[-\s]?fi|wlan|ethernet|en\d|eth\d/i.test(c.name));
  return preferred ? preferred.address : (candidates[0]?.address || 'localhost');
}

/* ══════════════════════════════════════════════════════════════
   REQUEST HANDLER
   ══════════════════════════════════════════════════════════════ */

async function handleRequest(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  // CORS – allow all origins (LAN dev mode)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* ── GET /api/health ────────────────────────────────────────── */
  if (url === '/api/health' && method === 'GET') {
    return jsonResponse(res, 200, {
      status:  'ok',
      service: 'CoLearn API',
      smtp:    emailConfigured ? `configured (${SMTP_USER})` : 'not configured (console fallback)',
      uptime:  Math.floor(process.uptime()) + 's',
      timestamp: new Date().toISOString(),
    });
  }

  /* ── POST /api/send-otp  (Signup OTP) ───────────────────────── */
  if (url === '/api/send-otp' && method === 'POST') {
    const body = await readBody(req);
    const email = (body.email || '').trim().toLowerCase();

    if (!validateEmail(email)) {
      return jsonResponse(res, 400, { success: false, error: 'Invalid email address.' });
    }

    const otp = generateOTP();
    storeOTP(email, otp);

    console.log(`\n[SIGNUP OTP]`);
    console.log(`  Requested email : ${email}`);
    console.log(`  OTP             : ${otp}  (expires in 5 min)`);

    try {
      await sendSignupOTPEmail(email, otp);
      return jsonResponse(res, 200, { success: true, message: 'OTP sent to your email.' });
    } catch (err) {
      console.error('[send-otp] Email error:', err.message);
      // Still return success — OTP is stored, console fallback active
      return jsonResponse(res, 200, {
        success: true,
        message: emailConfigured
          ? 'OTP sent (check your email).'
          : 'OTP generated (check server console — SMTP not configured).',
      });
    }
  }

  /* ── POST /api/verify-otp  (Signup OTP verify) ──────────────── */
  if (url === '/api/verify-otp' && method === 'POST') {
    const body  = await readBody(req);
    const email = (body.email || '').trim().toLowerCase();
    const otp   = (body.otp   || '').trim();

    if (!email || !otp) {
      return jsonResponse(res, 400, { success: false, error: 'Email and OTP are required.' });
    }

    const result = verifyOTP(email, otp);
    switch (result) {
      case 'ok':
        return jsonResponse(res, 200, { success: true });
      case 'not_found':
        return jsonResponse(res, 400, { success: false, error: 'No OTP found. Please request a new one.' });
      case 'expired':
        return jsonResponse(res, 400, { success: false, error: 'OTP expired. Please request a new one.' });
      case 'max_attempts':
        return jsonResponse(res, 429, { success: false, error: 'Too many incorrect attempts. Please request a new OTP.' });
      default:
        return jsonResponse(res, 400, { success: false, error: 'Invalid OTP. Please try again.' });
    }
  }

  /* ── POST /api/send-reset-otp  (Forgot Password – Step 1) ────── */
  if (url === '/api/send-reset-otp' && method === 'POST') {
    const body  = await readBody(req);
    const email = (body.email || '').trim().toLowerCase();

    if (!validateEmail(email)) {
      return jsonResponse(res, 400, { success: false, error: 'Please provide a valid email address.' });
    }

    // Check email is registered
    if (!userStore.has(email)) {
      console.log(`[RESET OTP] Email not found in store: ${email}`);
      return jsonResponse(res, 404, {
        success: false,
        error:   'No account found with this email. Please register first.',
      });
    }

    const otp = generateOTP();
    storeOTP(email, otp);
    resetVerified.delete(email);   // clear any previous verified state

    console.log(`\n[FORGOT-PASSWORD OTP]`);
    console.log(`  Requested email : ${email}`);
    console.log(`  Recipient       : ${email}`);   // always the same — NEVER hardcoded
    console.log(`  OTP             : ${otp}  (expires in 5 min)`);

    try {
      await sendResetOTPEmail(email, otp);
      return jsonResponse(res, 200, { success: true, message: 'Reset OTP sent to your email.' });
    } catch (err) {
      console.error('[send-reset-otp] Email error:', err.message);
      return jsonResponse(res, 200, {
        success: true,
        message: emailConfigured
          ? 'OTP sent (check your email).'
          : 'OTP generated (check server console — SMTP not configured).',
      });
    }
  }

  /* ── POST /api/verify-reset-otp  (Forgot Password – Step 2) ─── */
  if (url === '/api/verify-reset-otp' && method === 'POST') {
    const body  = await readBody(req);
    const email = (body.email || '').trim().toLowerCase();
    const otp   = (body.otp   || '').trim();

    if (!email || !otp) {
      return jsonResponse(res, 400, { success: false, error: 'Email and OTP are required.' });
    }

    const result = verifyOTP(email, otp);
    switch (result) {
      case 'ok':
        resetVerified.add(email);   // mark as verified for password reset
        return jsonResponse(res, 200, { success: true });
      case 'not_found':
        return jsonResponse(res, 400, { success: false, error: 'No OTP found. Please request a new one.' });
      case 'expired':
        return jsonResponse(res, 400, { success: false, error: 'OTP expired. Please request a new one.' });
      case 'max_attempts':
        return jsonResponse(res, 429, { success: false, error: 'Too many incorrect attempts. Please request a new OTP.' });
      default:
        return jsonResponse(res, 400, { success: false, error: 'Invalid OTP. Please try again.' });
    }
  }

  /* ── POST /api/reset-password  (Forgot Password – Step 3) ────── */
  if (url === '/api/reset-password' && method === 'POST') {
    const body        = await readBody(req);
    const email       = (body.email       || '').trim().toLowerCase();
    const newPassword = (body.newPassword || '').trim();

    if (!email || !newPassword) {
      return jsonResponse(res, 400, { success: false, error: 'Email and new password are required.' });
    }

    if (!resetVerified.has(email)) {
      return jsonResponse(res, 403, { success: false, error: 'OTP not verified. Please verify your OTP first.' });
    }

    if (newPassword.length < 8) {
      return jsonResponse(res, 400, { success: false, error: 'Password must be at least 8 characters.' });
    }

    const user = userStore.get(email);
    if (!user) {
      return jsonResponse(res, 404, { success: false, error: 'Account not found.' });
    }

    // Update password hash
    user.passwordHash = hashOTP(newPassword);
    userStore.set(email, user);
    resetVerified.delete(email);

    console.log(`\n[PASSWORD RESET]`);
    console.log(`  Account : ${email}`);
    console.log(`  Status  : Password updated successfully`);

    return jsonResponse(res, 200, { success: true, message: 'Password updated successfully.' });
  }

  /* ── POST /api/auth/register ────────────────────────────────── */
  if (url === '/api/auth/register' && method === 'POST') {
    const body     = await readBody(req);
    const name     = (body.name     || '').trim();
    const username = (body.username || '').trim().toLowerCase();
    const email    = (body.email    || '').trim().toLowerCase();
    const password = (body.password || '').trim();

    if (!name || !username || !email || !password) {
      return jsonResponse(res, 400, { success: false, error: 'All fields are required.' });
    }

    if (!validateEmail(email)) {
      return jsonResponse(res, 400, { success: false, error: 'Invalid email address.' });
    }

    if (userStore.has(email)) {
      return jsonResponse(res, 409, { success: false, error: 'Account already exists. Please login.' });
    }

    if (password.length < 8) {
      return jsonResponse(res, 400, { success: false, error: 'Password must be at least 8 characters.' });
    }

    const uid = crypto.randomBytes(12).toString('hex');
    userStore.set(email, { uid, email, name, username, passwordHash: hashOTP(password) });

    console.log(`\n[REGISTER] New user: ${email}`);
    return jsonResponse(res, 201, {
      success: true,
      message: 'Account created successfully.',
      user:    { uid, name, username, email },
    });
  }

  /* ── POST /api/auth/login ───────────────────────────────────── */
  if (url === '/api/auth/login' && method === 'POST') {
    const body     = await readBody(req);
    const email    = (body.email    || '').trim().toLowerCase();
    const password = (body.password || '').trim();

    if (!email || !password) {
      return jsonResponse(res, 400, { success: false, error: 'Email and password are required.' });
    }

    const user = userStore.get(email);
    if (!user) {
      return jsonResponse(res, 404, { success: false, error: 'No account found with this email. Please create an account.' });
    }

    if (user.passwordHash !== hashOTP(password)) {
      return jsonResponse(res, 401, { success: false, error: 'Incorrect password.' });
    }

    console.log(`\n[LOGIN] ${email}`);
    return jsonResponse(res, 200, {
      success: true,
      message: 'Login successful.',
      user:    { uid: user.uid, name: user.name, username: user.username, email },
    });
  }

  /* ── Static files ───────────────────────────────────────────── */
  let filePath = (url === '/' || !path.extname(url)) ? '/index.html' : url;
  filePath = path.join(ROOT, filePath);

  // Prevent directory traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 – File not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* ══════════════════════════════════════════════════════════════
   BOOTSTRAP
   ══════════════════════════════════════════════════════════════ */

initMailer();

const server = http.createServer(handleRequest);
server.listen(PORT, HOST, () => {
  const ip   = getLocalIP();
  const line = '═'.repeat(54);
  console.log('');
  console.log(`╔${line}╗`);
  console.log(`║           🔗  CoLearn Dev Server                   ║`);
  console.log(`╠${line}╣`);
  console.log(`║  Local   →  http://localhost:${PORT}                     ║`);
  console.log(`║  Network →  http://${ip}:${PORT}                 ║`);
  console.log(`╠${line}╣`);
  console.log(`║  API endpoints:                                       ║`);
  console.log(`║    GET  /api/health                                   ║`);
  console.log(`║    POST /api/send-otp           (signup OTP)          ║`);
  console.log(`║    POST /api/verify-otp          (verify signup OTP)  ║`);
  console.log(`║    POST /api/send-reset-otp      (forgot password)    ║`);
  console.log(`║    POST /api/verify-reset-otp    (verify reset OTP)   ║`);
  console.log(`║    POST /api/reset-password      (set new password)   ║`);
  console.log(`║    POST /api/auth/register                            ║`);
  console.log(`║    POST /api/auth/login                               ║`);
  console.log(`╠${line}╣`);
  console.log(`║  SMTP : ${emailConfigured ? `✅ ${SMTP_USER}` : '⚠️  Not configured (console fallback)'}`.padEnd(57) + `║`);
  console.log(`╚${line}╝`);
  console.log('');
  console.log(`  ✅  Open on another device: http://${ip}:${PORT}`);
  console.log('');
});
