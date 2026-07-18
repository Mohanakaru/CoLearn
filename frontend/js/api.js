/* ── API wrapper: calls backend REST endpoints ───────────────── */
/**
 * All fetch() calls route through this module.
 *
 * CONFIG.API_BASE is set in config.js and is derived from
 * window.location.origin at runtime, so it automatically resolves
 * to the correct LAN IP when opened from another device.
 *
 * Network error handling:
 *  If the backend is unreachable (server down, wrong IP, firewall),
 *  fetch() throws a TypeError. Each method catches it and rethrows
 *  with a user-friendly message so the view layer can display it.
 */

/* ── Shared fetch helper ─────────────────────────────────── */
async function apiFetch(path, options = {}) {
  const url = `${CONFIG.API_BASE}${path}`;

  // Auto-inject current user UID so requireAuth middleware always has it
  const uid = (typeof AppState !== 'undefined' && AppState.currentUser)
    ? AppState.currentUser.uid
    : '';

  const defaults = {
    headers: {
      'Content-Type': 'application/json',
      ...(uid ? { 'X-FS-UID': uid } : {}),
    },
    credentials: 'same-origin',
  };

  // For GET requests with a uid-based route, append uid to query string
  // so requireAuth can extract it from req.query
  let finalUrl = url;
  if (uid && options.method === 'GET' && !url.includes('uid=')) {
    const sep = url.includes('?') ? '&' : '?';
    finalUrl = `${url}${sep}uid=${encodeURIComponent(uid)}`;
  }

  // Merge caller options over defaults
  const config = {
    ...defaults,
    ...options,
    headers: { ...defaults.headers, ...(options.headers || {}) },
  };

  try {
    const res = await fetch(finalUrl, config);
    // Parse JSON even on non-2xx so error bodies reach the caller
    const data = await res.json();

    // If the server says auth is required and we have a stored session,
    // it means the uid was invalid — clear session to avoid infinite loops
    if (!data.success && res.status === 401 && uid) {
      console.warn('[CoLearn API] 401 on authenticated request — session may be stale');
    }

    return data;
  } catch (err) {
    // Network-level failure (server down, wrong IP, firewall, CORS blocked)
    const message =
      `❌ Cannot connect to server at ${CONFIG.API_BASE}.\n` +
      `Make sure:\n` +
      `  • The backend server is running (npm run dev in /backend)\n` +
      `  • Both devices are on the same Wi-Fi / LAN network\n` +
      `  • No firewall is blocking port ${CONFIG.API_BASE.split(':').pop() || '3000'}`;
    console.error('[CoLearn API] Network error →', finalUrl, err.message);
    // Re-throw enriched error so view-layer catch blocks display it
    throw new Error(message);
  }
}


/* ── API object ──────────────────────────────────────────────── */
const API = {

  /* ── Signup OTP ──────────────────────────────────────────────── */

  /** POST /api/send-otp → { success, message } | { success: false, error } */
  async sendOTP(email) {
    return apiFetch('/api/send-otp', {
      method: 'POST',
      body:   JSON.stringify({ email }),
    });
  },

  /** POST /api/verify-otp → { success } | { success: false, error } */
  async verifyOTP(email, otp) {
    return apiFetch('/api/verify-otp', {
      method: 'POST',
      body:   JSON.stringify({ email, otp }),
    });
  },

  /* ── Authentication ──────────────────────────────────────────── */

  /**
   * POST /api/auth/register
   * → { success, message, user: { uid, name, username, email } }
   * → { success: false, error }
   */
  async register({ name, username, email, password, confirm }) {
    return apiFetch('/api/auth/register', {
      method: 'POST',
      body:   JSON.stringify({ name, username, email, password, confirm }),
    });
  },

  /**
   * POST /api/auth/login
   * → { success, message, user: { uid, name, username, email } }
   * → { success: false, error }
   */
  async login({ email, password }) {
    return apiFetch('/api/auth/login', {
      method: 'POST',
      body:   JSON.stringify({ email, password }),
    });
  },

  /* ── Password Reset ──────────────────────────────────────────── */

  /**
   * POST /api/auth/send-reset-otp  – Check email exists, send OTP
   * → { success, message } | { success: false, error }
   */
  async sendResetOTP(email) {
    return apiFetch('/api/auth/send-reset-otp', {
      method: 'POST',
      body:   JSON.stringify({ email }),
    });
  },

  /**
   * POST /api/auth/verify-reset-otp
   * → { success } | { success: false, error }
   */
  async verifyResetOTP(email, otp) {
    return apiFetch('/api/auth/verify-reset-otp', {
      method: 'POST',
      body:   JSON.stringify({ email, otp }),
    });
  },

  /**
   * POST /api/auth/reset-password
   * → { success, message } | { success: false, error }
   */
  async resetPassword({ email, newPassword, confirm }) {
    return apiFetch('/api/auth/reset-password', {
      method: 'POST',
      body:   JSON.stringify({ email, newPassword, confirm }),
    });
  },

  /* ── Suites ─────────────────────────────────────────────── */

  /**
   * GET /api/suites?uid=<uid>
   * Returns the current user's suites.
   */
  async getSuites(uid) {
    return apiFetch(`/api/suites?uid=${encodeURIComponent(uid)}`, { method: 'GET' });
  },

  /**
   * GET /api/suites/:id
   * Returns the details of a specific suite.
   */
  async getSuite(suiteId) {
    return apiFetch(`/api/suites/${encodeURIComponent(suiteId)}`, { method: 'GET' });
  },

  /**
   * POST /api/suites
   * Body: { uid, name, isPrivate, description? }
   * Creates a suite in Firestore.
   */
  async createSuite({ uid, name, isPrivate, description }) {
    return apiFetch('/api/suites', {
      method: 'POST',
      body:   JSON.stringify({ uid, name, isPrivate, description: description || '' }),
    });
  },

  /**
   * DELETE /api/suites/:id
   * Body: { uid } — must be the suite owner.
   */
  async deleteSuite(suiteId, uid) {
    return apiFetch(`/api/suites/${encodeURIComponent(suiteId)}`, {
      method: 'DELETE',
      body:   JSON.stringify({ uid }),
    });
  },

  /* ── Invites ─────────────────────────────────────────────── */

  /**
   * POST /api/invite/send
   * Body: { suiteId, uid, email }
   * Generates invite + sends email. Returns { success, inviteCode, inviteUrl }
   */
  async sendInvite({ suiteId, uid, email }) {
    return apiFetch('/api/invite/send', {
      method: 'POST',
      body:   JSON.stringify({ suiteId, uid, email }),
    });
  },

  /**
   * POST /api/invite/generate
   * Body: { suiteId, uid }
   * Generates invite code + link without sending email.
   * Returns { success, inviteCode, inviteUrl }
   */
  async generateInvite({ suiteId, uid }) {
    return apiFetch('/api/invite/generate', {
      method: 'POST',
      body:   JSON.stringify({ suiteId, uid }),
    });
  },

  /**
   * POST /api/invite/code
   * Body: { code }
   * Validates a 5-digit invite code.
   * Returns { success, suiteId, suiteName } | { success: false, error }
   */
  async validateInviteCode(code) {
    return apiFetch('/api/invite/code', {
      method: 'POST',
      body:   JSON.stringify({ code }),
    });
  },

  /**
   * POST /api/invite/link
   * Body: { token }
   * Validates an invite token from a URL.
   * Returns { success, suiteId, suiteName } | { success: false, error }
   */
  async validateInviteToken(token) {
    return apiFetch('/api/invite/link', {
      method: 'POST',
      body:   JSON.stringify({ token }),
    });
  },

  /**
   * POST /api/suite/join
   * Body: { uid, suiteId }
   * Adds user to suite members in Firestore.
   * Returns { success, suite, member } | { success: false, error }
   */
  async joinSuite({ uid, suiteId }) {
    return apiFetch('/api/suite/join', {
      method: 'POST',
      body:   JSON.stringify({ uid, suiteId }),
    });
  },

  /**
   * POST /api/invite/invalidate
   * Body: { uid }
   * Invalidates all active invites created by this host.
   */
  async invalidateHostInvites(uid) {
    return apiFetch('/api/invite/invalidate', {
      method: 'POST',
      body:   JSON.stringify({ uid }),
    });
  },

  /* ── Health ─────────────────────────────────────────────── */

  /** GET /api/health → { status, uptime, … } */
  async health() {
    return apiFetch('/api/health', { method: 'GET' });
  },

  /* ── Google Drive ─────────────────────────────────────────── */

  /**
   * GET /api/drive/status
   * Returns { success, connected, googleEmail, connectedAt }
   */
  async getDriveStatus() {
    return apiFetch('/api/drive/status', { method: 'GET' });
  },

  /**
   * GET /api/drive/auth-url
   * Returns { success, url } – Google OAuth2 consent URL
   */
  async getDriveAuthUrl() {
    return apiFetch('/api/drive/auth-url', { method: 'GET' });
  },

  /**
   * POST /api/drive/disconnect
   * Revokes Drive access for the current user.
   */
  async disconnectDrive() {
    const uid = (typeof AppState !== 'undefined' && AppState.currentUser)
      ? AppState.currentUser.uid : '';
    return apiFetch('/api/drive/disconnect', {
      method: 'POST',
      body:   JSON.stringify({ uid }),
    });
  },

  /**
   * POST /api/drive/upload (multipart/form-data)
   * Uploads a file to the user's Google Drive.
   * Uses XMLHttpRequest for upload progress tracking.
   * onProgress(pct) is called with 0-100.
   *
   * Returns a Promise<{ success, file }> | Promise<{ success:false, error }>
   */
  uploadDriveFile(file, suiteId, onProgress) {
    const uid     = (typeof AppState !== 'undefined' && AppState.currentUser)
      ? AppState.currentUser.uid : '';
    const apiBase = (typeof CONFIG !== 'undefined' && CONFIG.API_BASE) ? CONFIG.API_BASE : '';

    return new Promise(function (resolve, reject) {
      const formData = new FormData();
      formData.append('file',    file);
      formData.append('suiteId', suiteId);

      const xhr = new XMLHttpRequest();

      if (typeof onProgress === 'function') {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
      }

      xhr.onload = function () {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data);
        } catch (e) {
          resolve({ success: false, error: 'Invalid server response' });
        }
      };

      xhr.onerror   = function () { reject(new Error('Network error during Drive upload.')); };
      xhr.ontimeout = function () { reject(new Error('Drive upload timed out.')); };

      xhr.open('POST', apiBase + '/api/drive/upload');
      xhr.setRequestHeader('X-FS-UID', uid);
      xhr.timeout = 5 * 60 * 1000; // 5 minutes
      xhr.send(formData);
    });
  },

  /**
   * GET /api/drive/files/:suiteId
   * Returns { success, files: [...] } – Drive file metadata from Firestore
   */
  async getDriveFiles(suiteId) {
    return apiFetch(`/api/drive/files/${encodeURIComponent(suiteId)}`, { method: 'GET' });
  },

  /**
   * DELETE /api/drive/files/:fileId
   * Deletes a Drive file. Body: { suiteId }
   */
  async deleteDriveFile(fileId, suiteId) {
    const uid = (typeof AppState !== 'undefined' && AppState.currentUser)
      ? AppState.currentUser.uid : '';
    return apiFetch(`/api/drive/files/${encodeURIComponent(fileId)}?suiteId=${encodeURIComponent(suiteId)}`, {
      method: 'DELETE',
      body:   JSON.stringify({ uid, suiteId }),
    });
  },

  /**
   * POST /api/drive/grant-member
   * Grants Drive access to a new suite member.
   * Body: { suiteId, memberEmail }
   */
  async grantDriveMember({ suiteId, memberEmail }) {
    return apiFetch('/api/drive/grant-member', {
      method: 'POST',
      body:   JSON.stringify({ suiteId, memberEmail }),
    });
  },

  /**
   * POST /api/drive/revoke-member
   * Revokes Drive access from a removed member.
   * Body: { suiteId, memberEmail }
   */
  async revokeDriveMember({ suiteId, memberEmail }) {
    return apiFetch('/api/drive/revoke-member', {
      method: 'POST',
      body:   JSON.stringify({ suiteId, memberEmail }),
    });
  },
};
