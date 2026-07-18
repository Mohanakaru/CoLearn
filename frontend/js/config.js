/* ── App Configuration ───────────────────────────────────────── */
/**
 * API_BASE – the full URL of the backend server.
 *
 * HOW IT WORKS:
 *  Since this is a vanilla-JS frontend (no build step / no Vite/webpack),
 *  we cannot use import.meta.env or process.env here.
 *
 *  Strategy (in priority order):
 *   1. If window.__CoLearn_API_BASE__ is injected by the server-rendered
 *      HTML (see backend server.js – future enhancement), use it.
 *   2. If the page was opened from ANY origin OTHER than localhost /
 *      127.0.0.1 (i.e. a LAN device accessed it via the host IP), derive
 *      the API base from the current page origin so the JS always calls
 *      back to the server that served the page.
 *   3. Fallback: empty string = same-origin (works on localhost).
 *
 * This approach requires ZERO manual config on remote devices.
 * When a phone or laptop opens http://10.139.201.21:3000 the
 * window.location.origin is already http://10.139.201.21:3000,
 * so API calls go to the correct host automatically.
 */

(function () {
  'use strict';

  /* ── Derive API base from the page origin ──────────────────── */
  // window.location.origin = "http://10.139.201.21:3000"  (LAN device)
  //                        = "http://localhost:3000"       (host machine)
  // In both cases, using origin as the API base is correct because
  // the Express server serves BOTH static files AND the /api/* routes.
  const origin = (window.location.origin || '').replace(/\/$/, '');

  // Use explicit override if injected server-side (reserved for future use)
  const apiBase = (typeof window.__CoLearn_API_BASE__ !== 'undefined')
    ? window.__CoLearn_API_BASE__
    : origin;   // ← derives LAN IP automatically from the URL the user opened

  window.CONFIG = {
    /**
     * Base URL for all API calls, e.g. "http://10.139.201.21:3000"
     * All api.js calls use ${CONFIG.API_BASE}/api/...
     * Never hardcoded – always derived from the page origin.
     */
    API_BASE: apiBase,

    OTP_TTL: 300,       // seconds (5 minutes — matches backend OTP_TTL_MS)

    CHAT_REPLIES: [
      'Got it! 👍', 'Makes sense!', 'Great point 📝',
      'Agreed! Let\'s continue.', 'Can you explain more?',
      'That\'s interesting!', 'Let me check that.', 'On it! 🔥',
    ],
  };

  // Log so developers can confirm the correct API target in DevTools console
  console.info('[CoLearn] API_BASE =', window.CONFIG.API_BASE);
})();
