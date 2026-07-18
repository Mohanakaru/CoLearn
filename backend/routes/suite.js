'use strict';
/**
 * CoLearn – Suite Routes
 * ─────────────────────────────────────────────────────────────
 *   DELETE /api/suite/:suiteId/members/:memberId  – host removes a member
 *   GET    /api/suite/:suiteId/members            – list suite members
 *   POST   /api/suite/:suiteId/screen-share       – update screen-share state
 *   GET    /api/suite/:suiteId                    – get suite details
 */

const express = require('express');
const router  = express.Router();
const { admin, db, rtdb } = require('../config/firebase');
const driveController = require('../controllers/driveController');

/* ── Auth helper ──────────────────────────────────────────────── */
function getCallerUid(req) {
  return (req.headers['x-fs-uid'] || '').trim();
}

/* ══════════════════════════════════════════════════════════════
   GET /api/suite/:suiteId  – Suite details
   ══════════════════════════════════════════════════════════════ */
router.get('/suite/:suiteId', async (req, res) => {
  const { suiteId } = req.params;
  const callerUid   = getCallerUid(req);
  if (!callerUid) return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (!suiteId)   return res.status(400).json({ success: false, error: 'Suite ID required.' });

  try {
    const snap = await db.collection('suites').doc(suiteId).get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Suite not found.' });

    const suite = { id: snap.id, ...snap.data() };
    return res.json({ success: true, suite });
  } catch (err) {
    console.error('[suite] GET /suite/:id error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   GET /api/suite/:suiteId/members  – List suite members
   ══════════════════════════════════════════════════════════════ */
router.get('/suite/:suiteId/members', async (req, res) => {
  const { suiteId } = req.params;
  const callerUid   = getCallerUid(req);
  if (!callerUid) return res.status(401).json({ success: false, error: 'Authentication required.' });

  try {
    const snap  = await db.collection('suites').doc(suiteId).get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Suite not found.' });

    const suite      = snap.data();
    const memberUids = suite.memberUids || [];

    /* Fetch user profiles for each member */
    const members = await Promise.all(
      memberUids.map(async (uid) => {
        try {
          const userSnap = await db.collection('users').doc(uid).get();
          const u = userSnap.exists ? userSnap.data() : {};
          return { uid, name: u.name || uid, username: u.username || uid, isHost: uid === suite.ownerUid };
        } catch {
          return { uid, name: uid, username: uid, isHost: uid === suite.ownerUid };
        }
      })
    );

    return res.json({ success: true, members });
  } catch (err) {
    console.error('[suite] GET /suite/:id/members error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   DELETE /api/suite/:suiteId/members/:memberId  – Remove a member
   ══════════════════════════════════════════════════════════════ */
router.delete('/suite/:suiteId/members/:memberId', async (req, res) => {
  const { suiteId, memberId } = req.params;
  const callerUid = getCallerUid(req);

  if (!callerUid)  return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (!suiteId)    return res.status(400).json({ success: false, error: 'Suite ID required.' });
  if (!memberId)   return res.status(400).json({ success: false, error: 'Member ID required.' });
  if (callerUid === memberId) return res.status(400).json({ success: false, error: 'You cannot remove yourself from the suite.' });

  try {
    const suiteRef  = db.collection('suites').doc(suiteId);
    const suiteSnap = await suiteRef.get();

    if (!suiteSnap.exists) return res.status(404).json({ success: false, error: 'Suite not found.' });

    const suite = suiteSnap.data();

    /* Only the host can remove members */
    if (suite.ownerUid !== callerUid) {
      return res.status(403).json({ success: false, error: 'Only the suite host can remove members.' });
    }

    /* Check member is actually in the suite */
    const memberUids = suite.memberUids || [];
    if (!memberUids.includes(memberId)) {
      return res.status(404).json({ success: false, error: 'Member not found in this suite.' });
    }

    /* Remove member from Firestore */
    await suiteRef.update({
      memberUids: admin.firestore.FieldValue.arrayRemove(memberId),
    });

    /* Signal removal via RTDB (auto-removed after 10s) */
    if (rtdb) {
      const removedRef = rtdb.ref(`suites/${suiteId}/memberRemoved`);
      await removedRef.set({ uid: memberId, removedBy: callerUid, at: Date.now() });
      setTimeout(() => removedRef.remove().catch(() => {}), 10000);
    }

    /* Write notification to removed member */
    try {
      await db.collection('notifications').doc(memberId).collection('items').add({
        type:      'member_removed',
        title:     'Removed from Suite',
        body:      `You were removed from "${suite.name}"`,
        icon:      '🚫',
        data:      { suiteId, suiteName: suite.name },
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        read:      false,
      });
    } catch (e) {
      console.warn('[suite] Notification write failed:', e.message);
    }

    /* Revoke removed member's Google Drive access (fire-and-forget) */
    try {
      const removedUserSnap = await db.collection('users').doc(memberId).get();
      const removedEmail    = removedUserSnap.exists ? (removedUserSnap.data().email || '') : '';
      if (removedEmail) {
        driveController.revokeMemberAccess(
          { verifiedUid: callerUid, body: { suiteId, memberEmail: removedEmail } },
          { json: () => {} }
        ).catch(e => console.warn('[suite] Drive revoke failed:', e.message));
      }
    } catch (e) {
      console.warn('[suite] Could not fetch removed member email for Drive revocation:', e.message);
    }

    console.log(`[suite] Member ${memberId} removed from suite ${suiteId} by ${callerUid}`);
    return res.json({ success: true, message: 'Member removed from suite.' });

  } catch (err) {
    console.error('[suite] DELETE /suite/:id/members/:memberId error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/suite/:suiteId/screen-share  – Update screen-share state
   ══════════════════════════════════════════════════════════════ */
router.post('/suite/:suiteId/screen-share', async (req, res) => {
  const { suiteId }                          = req.params;
  const { presenterUid, presenterName, action } = req.body;
  const callerUid = getCallerUid(req);

  if (!callerUid) return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (!suiteId)   return res.status(400).json({ success: false, error: 'Suite ID required.' });

  try {
    const docRef = db.collection('screenSharing').doc(suiteId);

    if (action === 'start') {
      await docRef.set({
        isSharing:     true,
        presenterUid:  presenterUid || callerUid,
        presenterName: presenterName || 'User',
        startedAt:     admin.firestore.FieldValue.serverTimestamp(),
        suiteId,
      });
    } else if (action === 'stop') {
      await docRef.delete();
    } else {
      return res.status(400).json({ success: false, error: 'Action must be "start" or "stop".' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[suite] POST /screen-share error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
