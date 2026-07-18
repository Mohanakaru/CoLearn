'use strict';
/**
 * inviteController.js – Invite system business logic
 * ─────────────────────────────────────────────────────────────────
 *  POST /api/invite/send        – Generate invite + send email
 *  POST /api/invite/generate    – Generate invite only (no email)
 *  POST /api/invite/code        – Validate 5-digit code
 *  POST /api/invite/link        – Validate invite token
 *  POST /api/suite/join         – Join a suite (update Firestore)
 *  POST /api/invite/invalidate  – Host going offline
 */

const { db, firestoreWithRetry } = require('../config/firebase');
const inviteStore    = require('../models/inviteStore');
const emailService   = require('../services/emailService');
const driveController = require('./driveController');

/* ── URL builder ────────────────────────────────────────────────── */
/**
 * Build the production-safe invite URL.
 * Priority:
 *   1. APP_URL env var  (set on Vercel / Render / Railway)
 *   2. x-forwarded-proto + host header  (behind reverse proxy)
 *   3. req.protocol + req.hostname
 *
 * NEVER emits localhost or 127.0.0.1.
 */
function buildInviteUrl(req, token) {
  let base = (process.env.APP_URL || '').trim().replace(/\/$/, '');

  if (!base) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host  = req.headers['x-forwarded-host']  || req.headers.host || req.hostname;
    // Guard against private/loopback addresses
    const isLocal = /localhost|127\.0\.0\.1|::1|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
    base = isLocal
      ? 'https://colearn.app'   // fallback brand URL when running locally
      : `${proto}://${host}`;
  }

  return `${base}/invite/${token}`;
}

/* ══════════════════════════════════════════════════════════════════
   POST /api/invite/send
   Body: { suiteId, uid, email }
   Generates invite + sends email to recipient.
   ══════════════════════════════════════════════════════════════════ */
async function sendInvite(req, res) {
  const suiteId = (req.body.suiteId || '').trim();
  const uid     = (req.body.uid     || '').trim();
  const email   = (req.body.email   || '').trim().toLowerCase();

  // Validation
  if (!suiteId) return res.status(400).json({ success: false, error: 'suiteId is required.' });
  if (!uid)     return res.status(400).json({ success: false, error: 'uid is required.' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Please provide a valid email address.' });
  }

  // Fetch suite from Firestore
  let suite;
  try {
    const doc = await firestoreWithRetry(() => db.collection('suites').doc(suiteId).get());
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'Suite not found.' });
    }
    suite = { id: doc.id, ...doc.data() };
  } catch (e) {
    console.error('[sendInvite] Firestore error. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }

  // Authorisation: only the suite owner may send invites
  if (suite.ownerUid !== uid) {
    return res.status(403).json({ success: false, error: 'Only the Suite Host can send invitations.' });
  }

  // Generate invite (or re-use existing active one for this suite+host)
  const { inviteCode, inviteToken } = inviteStore.createInvite(suiteId, suite.name, uid);
  const inviteUrl = buildInviteUrl(req, inviteToken);

  // Send email
  try {
    await emailService.sendInviteEmail(email, suite.name, inviteCode, inviteUrl);
    console.log(`[Invite] Email sent to ${email} — suite=${suiteId} code=${inviteCode}`);
  } catch (e) {
    console.error('[sendInvite] Email error:', e.message);
    // Non-fatal: invite is generated, inform caller
    return res.json({
      success: true,
      warning: 'Invite generated but email delivery failed. Share the code/link manually.',
      inviteCode,
      inviteUrl,
    });
  }

  return res.json({ success: true, inviteCode, inviteUrl });
}

/* ══════════════════════════════════════════════════════════════════
   POST /api/invite/generate
   Body: { suiteId, uid }
   Generates invite code + link WITHOUT sending email (for display
   in the workspace invite panel on first open).
   ══════════════════════════════════════════════════════════════════ */
async function generateInvite(req, res) {
  const suiteId = (req.body.suiteId || '').trim();
  const uid     = (req.body.uid     || '').trim();

  if (!suiteId) return res.status(400).json({ success: false, error: 'suiteId is required.' });
  if (!uid)     return res.status(400).json({ success: false, error: 'uid is required.' });

  // Fetch suite
  let suite;
  try {
    const doc = await firestoreWithRetry(() => db.collection('suites').doc(suiteId).get());
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'Suite not found.' });
    }
    suite = { id: doc.id, ...doc.data() };
  } catch (e) {
    console.error('[generateInvite] Firestore error. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    return res.status(500).json({ success: false, error: 'Server error.' });
  }

  if (suite.ownerUid !== uid) {
    return res.status(403).json({ success: false, error: 'Only the Suite Host can generate invites.' });
  }

  const { inviteCode, inviteToken } = inviteStore.createInvite(suiteId, suite.name, uid);
  const inviteUrl = buildInviteUrl(req, inviteToken);

  return res.json({ success: true, inviteCode, inviteUrl });
}

/* ══════════════════════════════════════════════════════════════════
   POST /api/invite/code
   Body: { code }
   Validates a 5-digit invite code.
   ══════════════════════════════════════════════════════════════════ */
function validateCode(req, res) {
  const code = (req.body.code || '').trim();

  if (!code || !/^\d{5}$/.test(code)) {
    return res.status(400).json({ success: false, error: 'Please enter a valid 5-digit invite code.' });
  }

  const invite = inviteStore.getByCode(code);

  if (!invite) {
    return res.status(404).json({ success: false, error: 'This invite code is invalid or has expired.' });
  }

  return res.json({
    success:   true,
    suiteId:   invite.suiteId,
    suiteName: invite.suiteName,
  });
}

/* ══════════════════════════════════════════════════════════════════
   POST /api/invite/link
   Body: { token }
   Validates an invite token (from URL).
   ══════════════════════════════════════════════════════════════════ */
function validateToken(req, res) {
  const token = (req.body.token || '').trim();

  if (!token) {
    return res.status(400).json({ success: false, error: 'Invite token is required.' });
  }

  const invite = inviteStore.getByToken(token);

  if (!invite) {
    return res.status(404).json({
      success: false,
      error:   'This invitation link is invalid or has expired.',
    });
  }

  return res.json({
    success:   true,
    suiteId:   invite.suiteId,
    suiteName: invite.suiteName,
  });
}

/* ══════════════════════════════════════════════════════════════════
   POST /api/suite/join
   Body: { uid, suiteId }
   Adds the user to the suite's members array in Firestore, then
   broadcasts the new member list via SSE to all suite listeners.
   ══════════════════════════════════════════════════════════════════ */
async function joinSuite(req, res) {
  const uid     = (req.body.uid     || '').trim();
  const suiteId = (req.body.suiteId || '').trim();

  if (!uid)     return res.status(400).json({ success: false, error: 'uid is required.' });
  if (!suiteId) return res.status(400).json({ success: false, error: 'suiteId is required.' });

  // Fetch suite
  let suiteDoc;
  try {
    const ref = db.collection('suites').doc(suiteId);
    suiteDoc  = await firestoreWithRetry(() => ref.get());
    if (!suiteDoc.exists) {
      return res.status(404).json({ success: false, error: 'Suite not found.' });
    }
  } catch (e) {
    console.error('[joinSuite] Firestore fetch error. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    return res.status(500).json({ success: false, error: 'Server error.' });
  }

  const suiteData = suiteDoc.data();

  // Fetch user profile
  let userDoc;
  try {
    const snap = await firestoreWithRetry(() => db.collection('users').doc(uid).get());
    if (!snap.exists) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }
    userDoc = snap.data();
  } catch (e) {
    console.error('[joinSuite] User fetch error. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    return res.status(500).json({ success: false, error: 'Server error.' });
  }

  const members    = Array.isArray(suiteData.members)    ? suiteData.members    : [];
  const memberUids = Array.isArray(suiteData.memberUids) ? suiteData.memberUids : [];
  const ownerUid   = suiteData.ownerUid;

  // Ensure owner is in members list and memberUids
  if (!members.find(m => m.uid === ownerUid)) {
    try {
      const ownerSnap = await firestoreWithRetry(() => db.collection('users').doc(ownerUid).get());
      if (ownerSnap.exists) {
        const o = ownerSnap.data();
        members.unshift({ uid: ownerUid, name: o.name, username: o.username, isHost: true });
      }
    } catch (e) {
      console.error('[joinSuite] Owner fetch error. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    }
  }
  if (!memberUids.includes(ownerUid)) {
    memberUids.unshift(ownerUid);
  }

  // Check if already a member (prevent duplicates)
  if (members.find(m => m.uid === uid)) {
    return res.status(409).json({ success: false, error: "You're already a member of this suite." });
  }

  // Add new member
  const newMember = {
    uid,
    name:     userDoc.name,
    username: userDoc.username,
    isHost:   false,
    joinedAt: new Date().toISOString(),
  };
  members.push(newMember);

  // Maintain flat memberUids array for Firestore array-contains queries
  if (!memberUids.includes(uid)) {
    memberUids.push(uid);
  }

  // Persist to Firestore atomically
  try {
    await firestoreWithRetry(() => db.collection('suites').doc(suiteId).update({
      members,
      memberUids,
      updatedAt: new Date().toISOString(),
    }));
  } catch (e) {
    console.error('[joinSuite] Firestore update error. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    return res.status(500).json({ success: false, error: 'Failed to join suite.' });
  }

  // Broadcast via SSE to all clients watching this suite
  broadcastMembers(suiteId, members);

  // Grant Google Drive access to all existing suite files (fire-and-forget)
  // Uses the new member's email so they can view/download Drive files immediately.
  const memberEmail = userDoc.email || '';
  if (memberEmail) {
    driveController.grantMemberAccess(
      // Build a minimal req/res shim so the controller logic runs
      { verifiedUid: ownerUid, body: { suiteId, memberEmail } },
      { json: () => {} }
    ).catch(e => {
      console.warn('[joinSuite] Could not grant Drive access to new member:', e.message);
    });
  }

  console.log(`[Suite] ${userDoc.name} (uid=${uid}) joined suite=${suiteId}`);
  return res.json({
    success: true,
    suite:   { id: suiteId, ...suiteData, members },
    member:  newMember,
  });
}

/* ══════════════════════════════════════════════════════════════════
   POST /api/invite/invalidate
   Body: { uid }
   Called when host logs out / leaves suite.
   ══════════════════════════════════════════════════════════════════ */
function invalidateHostInvites(req, res) {
  const uid = (req.body.uid || '').trim();
  if (!uid) return res.status(400).json({ success: false, error: 'uid is required.' });

  const count = inviteStore.invalidateHostInvites(uid);
  return res.json({ success: true, invalidated: count });
}

/* ── SSE broadcast helper ────────────────────────────────────────── */
function broadcastMembers(suiteId, members) {
  const clients = inviteStore.sseClients.get(suiteId);
  if (!clients || clients.size === 0) return;

  const payload = `data: ${JSON.stringify({ type: 'members', members })}\n\n`;
  for (const clientRes of clients) {
    try {
      clientRes.write(payload);
    } catch (_) {
      clients.delete(clientRes);
    }
  }
}

module.exports = {
  sendInvite,
  generateInvite,
  validateCode,
  validateToken,
  joinSuite,
  invalidateHostInvites,
  broadcastMembers,
};
