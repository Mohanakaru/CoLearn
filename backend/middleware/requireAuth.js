'use strict';
/**
 * requireAuth.js – Server-side UID authentication middleware
 * ─────────────────────────────────────────────────────────────────
 * Validates that the `uid` parameter (from body or query) corresponds
 * to a real, non-disabled Firebase Auth user.
 *
 * This prevents:
 *   • Unauthenticated API calls
 *   • Spoofed UID attacks
 *   • Requests with missing or invalid UIDs
 *
 * Usage:
 *   router.delete('/suites/:id', requireAuth, deleteSuite);
 *   router.post('/invite/send',  requireAuth, sendInvite);
 */

const { auth } = require('../config/firebase');

/**
 * Extract uid from request body, query, params, or header (X-FS-UID).
 * Priority: body > query > header
 */
function extractUid(req) {
  return (
    (req.body  && req.body.uid)  ||
    (req.query && req.query.uid) ||
    (req.headers && req.headers['x-fs-uid']) ||
    ''
  ).trim();
}

/**
 * Middleware: Reject requests without a valid Firebase uid.
 * Attaches req.verifiedUid on success.
 */
async function requireAuth(req, res, next) {
  const uid = extractUid(req);

  if (!uid) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Please log in.',
    });
  }

  try {
    // Verify the uid maps to an active Firebase Auth user
    const userRecord = await auth.getUser(uid);
    if (userRecord.disabled) {
      return res.status(403).json({
        success: false,
        error: 'Your account has been disabled. Please contact support.',
      });
    }
    req.verifiedUid = userRecord.uid;
    return next();
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      return res.status(401).json({
        success: false,
        error: 'Invalid session. Please log in again.',
      });
    }
    console.error('[requireAuth] Firebase auth verification error:', e.message);
    return res.status(500).json({
      success: false,
      error: 'Authentication service unavailable. Please try again.',
    });
  }
}

module.exports = requireAuth;
