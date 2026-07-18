'use strict';
/**
 * driveAuthService.js – Google Drive OAuth2 token management
 * ─────────────────────────────────────────────────────────────────
 *  Manages per-user OAuth2 tokens for Google Drive access.
 *  Refresh tokens are stored ONLY in Firestore (never sent to frontend).
 *  Access tokens are fetched on-demand and auto-refreshed.
 *
 *  Firestore path for private auth data:
 *    users/{uid}/privateData (subcollection doc: "driveAuth")
 */

const { google }           = require('googleapis');
const { db, firestoreWithRetry } = require('../config/firebase');

/* ── OAuth2 client factory ───────────────────────────────────────── */
function createOAuthClient() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Google OAuth2 not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ' +
      'and GOOGLE_REDIRECT_URI in backend/.env'
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/* ── Scopes required ─────────────────────────────────────────────── */
const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',   // files created/opened by the app
];

/* ══════════════════════════════════════════════════════════════════
   getAuthUrl
   Returns the Google OAuth2 consent page URL.
   state = uid (to identify user on callback)
   ══════════════════════════════════════════════════════════════════ */
function getAuthUrl(uid) {
  const oauth2 = createOAuthClient();
  return oauth2.generateAuthUrl({
    access_type:  'offline',    // request refresh_token
    prompt:       'consent',    // always show consent so we always get refresh_token
    scope:        DRIVE_SCOPES,
    state:        uid,          // passed back on callback
  });
}

/* ══════════════════════════════════════════════════════════════════
   exchangeCode
   Exchange one-time auth code for tokens and persist refresh_token.
   Called from driveController.handleCallback().
   ══════════════════════════════════════════════════════════════════ */
async function exchangeCode(code, uid) {
  const oauth2 = createOAuthClient();
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. ' +
      'User may need to revoke app access at myaccount.google.com/permissions and retry.'
    );
  }

  // Fetch the user's Google profile to store their email + ID
  oauth2.setCredentials(tokens);
  const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
  let googleProfile;
  try {
    const { data } = await oauth2Api.userinfo.get();
    googleProfile = data;
  } catch (e) {
    googleProfile = { email: 'unknown', id: 'unknown' };
  }

  // Persist tokens to Firestore (refresh token NEVER leaves backend)
  const now = new Date().toISOString();
  const driveAuthData = {
    refreshToken:     tokens.refresh_token,
    googleEmail:      googleProfile.email  || '',
    googleUserId:     googleProfile.id     || '',
    connectedAt:      now,
    lastRefreshedAt:  now,
    connected:        true,
  };

  try {
    await firestoreWithRetry(() =>
      db.collection('users')
        .doc(uid)
        .collection('privateData')
        .doc('driveAuth')
        .set(driveAuthData)
    );
  } catch (e) {
    console.error('[DriveAuth] Failed to persist tokens to Firestore:', e.message);
    throw new Error('Failed to save Drive authorization. Please try again.');
  }

  // Also update the public user doc so frontend can read connection status
  try {
    await firestoreWithRetry(() =>
      db.collection('users').doc(uid).update({
        'driveAuth.connected':    true,
        'driveAuth.googleEmail':  googleProfile.email || '',
        'driveAuth.connectedAt':  now,
      })
    );
  } catch (e) {
    // Non-fatal: private data already saved
    console.warn('[DriveAuth] Could not update user doc with driveAuth status:', e.message);
  }

  console.log(`[DriveAuth] Drive connected for uid=${uid} (${googleProfile.email})`);
  return { email: googleProfile.email };
}

/* ══════════════════════════════════════════════════════════════════
   getAccessToken
   Retrieves a valid access token for the given uid.
   Auto-refreshes using the stored refresh token.
   ══════════════════════════════════════════════════════════════════ */
async function getAccessToken(uid) {
  // Load refresh token from Firestore
  let snap;
  try {
    snap = await firestoreWithRetry(() =>
      db.collection('users')
        .doc(uid)
        .collection('privateData')
        .doc('driveAuth')
        .get()
    );
  } catch (e) {
    console.error('[DriveAuth] Firestore read failed:', e.message);
    throw new Error('Failed to read Drive credentials. Please reconnect Google Drive.');
  }

  if (!snap.exists || !snap.data().refreshToken) {
    throw new DriveNotConnectedError('Google Drive is not connected for this user.');
  }

  const { refreshToken } = snap.data();

  const oauth2 = createOAuthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });

  // getAccessToken() auto-refreshes if needed
  let accessTokenResult;
  try {
    accessTokenResult = await oauth2.getAccessToken();
  } catch (e) {
    console.error('[DriveAuth] Token refresh failed:', e.message);
    // If refresh fails, mark as disconnected and require reconnect
    await _markDisconnected(uid);
    throw new DriveNotConnectedError(
      'Google Drive access expired. Please reconnect your Google Drive.'
    );
  }

  const token = accessTokenResult.token || accessTokenResult.res?.data?.access_token;
  if (!token) {
    throw new Error('Could not obtain access token from OAuth2 client.');
  }

  // Fire-and-forget: update lastRefreshedAt
  firestoreWithRetry(() =>
    db.collection('users')
      .doc(uid)
      .collection('privateData')
      .doc('driveAuth')
      .update({ lastRefreshedAt: new Date().toISOString() })
  ).catch(() => {});

  return token;
}

/* ══════════════════════════════════════════════════════════════════
   isConnected
   Returns true if the user has a valid refresh token stored.
   ══════════════════════════════════════════════════════════════════ */
async function isConnected(uid) {
  try {
    const snap = await firestoreWithRetry(() =>
      db.collection('users')
        .doc(uid)
        .collection('privateData')
        .doc('driveAuth')
        .get()
    );
    return snap.exists && !!snap.data().refreshToken && snap.data().connected === true;
  } catch (e) {
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════════
   getConnectionInfo
   Returns public connection metadata (no tokens).
   ══════════════════════════════════════════════════════════════════ */
async function getConnectionInfo(uid) {
  try {
    const snap = await firestoreWithRetry(() =>
      db.collection('users')
        .doc(uid)
        .collection('privateData')
        .doc('driveAuth')
        .get()
    );
    if (!snap.exists || !snap.data().refreshToken) {
      return { connected: false };
    }
    const d = snap.data();
    return {
      connected:    d.connected    || false,
      googleEmail:  d.googleEmail  || '',
      connectedAt:  d.connectedAt  || null,
    };
  } catch (e) {
    return { connected: false };
  }
}

/* ══════════════════════════════════════════════════════════════════
   revokeAccess
   Revokes the user's Drive access and removes stored tokens.
   ══════════════════════════════════════════════════════════════════ */
async function revokeAccess(uid) {
  let refreshToken;
  try {
    const snap = await firestoreWithRetry(() =>
      db.collection('users')
        .doc(uid)
        .collection('privateData')
        .doc('driveAuth')
        .get()
    );
    if (snap.exists) refreshToken = snap.data().refreshToken;
  } catch (e) {
    console.warn('[DriveAuth] Could not read token for revocation:', e.message);
  }

  // Attempt to revoke at Google
  if (refreshToken) {
    try {
      const oauth2 = createOAuthClient();
      await oauth2.revokeToken(refreshToken);
    } catch (e) {
      console.warn('[DriveAuth] Token revocation at Google failed (may already be revoked):', e.message);
    }
  }

  await _markDisconnected(uid);
  console.log(`[DriveAuth] Drive access revoked for uid=${uid}`);
}

/* ── Internal: mark user as disconnected ────────────────────────── */
async function _markDisconnected(uid) {
  try {
    await firestoreWithRetry(() =>
      db.collection('users')
        .doc(uid)
        .collection('privateData')
        .doc('driveAuth')
        .set({ connected: false, refreshToken: null, revokedAt: new Date().toISOString() })
    );
    await firestoreWithRetry(() =>
      db.collection('users').doc(uid).update({ 'driveAuth.connected': false })
    );
  } catch (e) {
    console.warn('[DriveAuth] Could not update disconnected status:', e.message);
  }
}

/* ── Custom error class ─────────────────────────────────────────── */
class DriveNotConnectedError extends Error {
  constructor(message) {
    super(message || 'Google Drive is not connected.');
    this.name = 'DriveNotConnectedError';
    this.code = 'DRIVE_NOT_CONNECTED';
  }
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  getAccessToken,
  isConnected,
  getConnectionInfo,
  revokeAccess,
  DriveNotConnectedError,
};
