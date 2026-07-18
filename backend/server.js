'use strict';
/**
 * CoLearn – Express Backend
 * ─────────────────────────────────────────────────────────────────
 * Serves the frontend (../frontend) as static files AND provides
 * the REST API. Binds on 0.0.0.0 so ANY device on the same LAN
 * can reach it via http://<your-ip>:PORT
 *
 * Usage:
 *   node server.js           (production)
 *   npm run dev              (development, with nodemon)
 */

require('dotenv').config();

/* ── Auto-derive GOOGLE_REDIRECT_URI from APP_URL if not explicit ────
   This means production only needs APP_URL set.
   Local dev: set GOOGLE_REDIRECT_URI explicitly OR set APP_URL=http://localhost:3000
   Production: set APP_URL=https://yourdomain.com (redirect URI auto-derived)
   ────────────────────────────────────────────────────────────────── */
(function deriveRedirectUri() {
  if (!process.env.GOOGLE_REDIRECT_URI) {
    const appUrl = (process.env.APP_URL || '').trim().replace(/\/$/, '');
    if (appUrl) {
      process.env.GOOGLE_REDIRECT_URI = appUrl + '/api/drive/callback';
      console.log('[Drive] GOOGLE_REDIRECT_URI auto-derived from APP_URL:', process.env.GOOGLE_REDIRECT_URI);
    } else {
      // Fallback for local dev with no APP_URL
      process.env.GOOGLE_REDIRECT_URI = 'http://localhost:' + (process.env.PORT || '3000') + '/api/drive/callback';
      console.log('[Drive] GOOGLE_REDIRECT_URI defaulted to:', process.env.GOOGLE_REDIRECT_URI);
    }
  }
})();

/* ── Google OAuth startup guard ──────────────────────────────────
   Catches missing / placeholder credentials BEFORE the server binds.
   401 invalid_client at Google means these values are wrong/placeholder.
   ────────────────────────────────────────────────────────────── */
(function checkGoogleOAuthConfig() {
  const id     = process.env.GOOGLE_CLIENT_ID     || '';
  const secret = process.env.GOOGLE_CLIENT_SECRET || '';
  const redir  = process.env.GOOGLE_REDIRECT_URI  || '';
  const env    = process.env.NODE_ENV || 'development';
  const isProd = env === 'production';

  const PLACEHOLDER_RE = /your_google|placeholder|_id_here|_secret_here|xxx|<.*>|CHANGE_ME/i;

  const missing  = [];
  const problems = [];

  if (!id)                            missing.push('GOOGLE_CLIENT_ID');
  else if (PLACEHOLDER_RE.test(id))   problems.push('GOOGLE_CLIENT_ID is still a placeholder — paste the real value from Google Cloud Console');
  else if (!id.endsWith('.apps.googleusercontent.com'))
    problems.push('GOOGLE_CLIENT_ID does not end with .apps.googleusercontent.com — check for copy/paste errors');

  if (!secret)                          missing.push('GOOGLE_CLIENT_SECRET');
  else if (PLACEHOLDER_RE.test(secret)) problems.push('GOOGLE_CLIENT_SECRET is still a placeholder — paste the real value from Google Cloud Console');

  if (!redir) missing.push('GOOGLE_REDIRECT_URI');

  if (isProd && redir && redir.startsWith('http://')) {
    problems.push('GOOGLE_REDIRECT_URI uses http:// in production — must be https://');
  }

  if (missing.length || problems.length) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════════╗');
    console.error('║        ⚠️  GOOGLE DRIVE NOT CONFIGURED  ⚠️                       ║');
    console.error('║        Environment: ' + env.padEnd(45) + '║');
    console.error('╠══════════════════════════════════════════════════════════════════╣');
    if (missing.length)
      console.error('║  MISSING : ' + missing.join(', ').padEnd(54) + '║');
    if (problems.length)
      problems.forEach(p => {
        // word-wrap at 54 chars
        const chunks = p.match(/.{1,54}/g) || [p];
        chunks.forEach((c, i) =>
          console.error('║  ' + (i === 0 ? 'PROBLEM : ' : '          ') + c.padEnd(54) + '║')
        );
      });
    console.error('╠══════════════════════════════════════════════════════════════════╣');
    console.error('║  HOW TO FIX (one-time admin setup):                              ║');
    console.error('║  1. https://console.cloud.google.com/                            ║');
    console.error('║  2. APIs & Services → Credentials                                ║');
    console.error('║  3. Create OAuth 2.0 Client ID → Web application                 ║');
    console.error('║  4. Add Authorized Redirect URI:                                  ║');
    if (isProd) {
      console.error('║     https://YOUR_DOMAIN/api/drive/callback                        ║');
    } else {
      console.error('║     http://localhost:' + (process.env.PORT || '3000') + '/api/drive/callback                    ║');
    }
    console.error('║  5. Paste Client ID + Secret into backend/.env                    ║');
    console.error('║  6. Restart server                                                ║');
    console.error('║                                                                   ║');
    console.error('║  Google Drive upload DISABLED. All other features work normally.  ║');
    console.error('╚══════════════════════════════════════════════════════════════════╝');
    console.error('');
    process.env._DRIVE_MISCONFIGURED = '1';
  } else {
    // Mask sensitive values for safe logging
    const maskId  = id.substring(0, 12) + '...' + id.slice(-28);
    const maskSec = secret.substring(0, 8) + '...' + secret.slice(-4);
    const envTag  = isProd ? '🟢 production' : '🟡 development';
    console.log('🔑  Google Drive OAuth [' + envTag + ']');
    console.log('    Client ID  : ' + maskId);
    console.log('    Redirect   : ' + redir);
  }
})();

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const path         = require('path');
const os           = require('os');

// Initialise Firebase Admin before any routes import it
const { warmUpFirebase } = require('./config/firebase');

const emailConfig  = require('./config/email');
const authRoutes   = require('./routes/auth');
const inviteRoutes = require('./routes/invite');
const suiteRoutes  = require('./routes/suite');
const driveRoutes  = require('./routes/drive');
const errorHandler = require('./middleware/errorHandler');

/* ── Initialise email transporter ───────────────────────────── */
emailConfig.init();

/* ── App setup ───────────────────────────────────────────────── */
const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';   // ← Bind on ALL interfaces (LAN + localhost)

/* ── Security headers (Helmet) ───────────────────────────────── */
app.use(helmet({
  // Allow inline scripts/styles that the frontend uses
  contentSecurityPolicy: false,
  // Allow cross-origin requests from other LAN devices
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false,
}));

/* ── CORS – allow any origin on the LAN ─────────────────────── */
// ALLOWED_ORIGINS env var: '*' (wildcard) or comma-separated list
// e.g. ALLOWED_ORIGINS=http://192.168.1.5:3000,http://192.168.1.10:3000
const rawOrigins = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '*').trim();

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    // Wildcard: allow everything
    if (rawOrigins === '*') return callback(null, true);
    // Comma-separated explicit list
    const allowed = rawOrigins.split(',').map(s => s.trim());
    if (allowed.includes(origin)) return callback(null, true);
    // Allow any origin on the same LAN subnet (any http/https origin)
    // This permissive check is intentional for LAN development.
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-FS-UID',
  ],
  exposedHeaders: ['Content-Length', 'X-Request-Id'],
  credentials: true,
  optionsSuccessStatus: 200, // For legacy browsers (IE11) on OPTIONS pre-flight
};

// Handle pre-flight OPTIONS for all routes
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

/* ── Body parsing ────────────────────────────────────────────── */
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

/* ── Static frontend ─────────────────────────────────────────── */
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR, {
  // Allow LAN clients to get fresh assets
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  },
}));

/* ── API routes ──────────────────────────────────────────────── */
app.use('/api', authRoutes);
app.use('/api', inviteRoutes);
app.use('/api', suiteRoutes);
app.use('/api', driveRoutes);

/* ── SPA fallback (serve index.html for all non-API routes) ─── */
// This includes /invite/:token paths so the frontend router handles them
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

/* ── Global error handler ────────────────────────────────────── */
app.use(errorHandler);

/* ── Helpers ─────────────────────────────────────────────────── */
/**
 * Returns the first non-internal IPv4 address found.
 * Prefers Wi-Fi / Ethernet adapters over virtual adapters.
 */
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push({ name, address: iface.address });
      }
    }
  }

  // Prefer Wi-Fi / Ethernet over virtual/VMware adapters
  const preferred = candidates.find(c =>
    /wi[-\s]?fi|wlan|ethernet|en\d|eth\d/i.test(c.name)
  );
  if (preferred) return preferred.address;
  if (candidates.length > 0) return candidates[0].address;
  return 'localhost';
}

/* ── Start server ────────────────────────────────────────────── */
async function startServer() {
  let attempt = 0;
  const baseDelay = 500;
  const maxDelay = 16000;

  while (true) {
    try {
      await warmUpFirebase();
      break;
    } catch (err) {
      attempt++;
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      console.error(`\n❌  Firebase Warm-up failed (attempt ${attempt}):`);
      console.error(`    Message: ${err.message || 'Unknown'}`);
      console.error(`    Code: ${err.code || 'N/A'}`);
      console.error(`    Stack: ${err.stack || 'N/A'}`);
      console.error(`\n💡  ACTIONABLE DIAGNOSIS:`);
      console.error(`    - Please verify your system clock is accurate (matches current real time).`);
      console.error(`    - Check if you are behind a corporate proxy, VPN, or firewall.`);
      console.error(`    - Verify network connectivity to oauth2.googleapis.com and firestore.googleapis.com.`);
      console.error(`    - Verify that your service account credentials key in backend/config/serviceAccountKey.json is still valid and has not been revoked.\n`);
      console.log(`🔄  Retrying Firebase warm-up in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  app.listen(PORT, HOST, () => {
    const ip = getLocalIP();
    const line = '═'.repeat(58);
    console.log('');
    console.log(`╔${line}╗`);
    console.log(`║             🔗  CoLearn Server  🔗                    ║`);
    console.log(`╠${line}╣`);
    console.log(`║  Local   →  http://localhost:${PORT}                         ║`);
    console.log(`║  Network →  http://${ip}:${PORT}                     ║`);
    console.log(`╠${line}╣`);
    console.log(`║  📋  API endpoints:                                       ║`);
    console.log(`║    GET  /api/health                                       ║`);
    console.log(`║    POST /api/send-otp          (signup OTP)               ║`);
    console.log(`║    POST /api/verify-otp        (verify signup OTP)        ║`);
    console.log(`║    POST /api/auth/register                                ║`);
    console.log(`║    POST /api/auth/login                                   ║`);
    console.log(`║    POST /api/auth/send-reset-otp                          ║`);
    console.log(`║    POST /api/auth/verify-reset-otp                        ║`);
    console.log(`║    POST /api/auth/reset-password                          ║`);
    console.log(`║    GET  /api/suites?uid=<uid>  (user's suites)            ║`);
    console.log(`║    POST /api/suites            (create suite)             ║`);
    console.log(`║    DELETE /api/suites/:id      (delete suite)             ║`);
    console.log(`║    POST /api/invite/send       (send invite email)        ║`);
    console.log(`║    POST /api/invite/generate   (get code+link only)       ║`);
    console.log(`║    POST /api/invite/code       (validate 5-digit code)    ║`);
    console.log(`║    POST /api/invite/link       (validate invite token)    ║`);
    console.log(`║    POST /api/suite/join        (join a suite)             ║`);
    console.log(`║    POST /api/invite/invalidate (host offline)             ║`);
    console.log(`║    GET  /api/suite/:id/members/stream  (SSE)              ║`);
    console.log(`╠${line}╣`);
    console.log(`║  🌐  LAN Access (other laptops / phones):                 ║`);
    console.log(`║    Open: http://${ip}:${PORT}                     ║`);
    console.log(`║                                                           ║`);
    console.log(`║  ⚠️  Windows Firewall: if other laptops can't connect,    ║`);
    console.log(`║     run this in PowerShell (as Administrator):            ║`);
    console.log(`║     netsh advfirewall firewall add rule name="CoLearn" ║`);
    console.log(`║       dir=in action=allow protocol=TCP localport=${PORT}       ║`);
    console.log(`╚${line}╝`);
    console.log('');
    console.log(`  ✅  Listening on http://0.0.0.0:${PORT}`);
    console.log(`  ✅  Share with LAN devices: http://${ip}:${PORT}`);
    console.log('');
  });
}

startServer();
