'use strict';

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { body }   = require('express-validator');
const requireAuth = require('../middleware/requireAuth');

const {
  sendInvite,
  generateInvite,
  validateCode,
  validateToken,
  joinSuite,
  invalidateHostInvites,
} = require('../controllers/inviteController');

const inviteStore = require('../models/inviteStore');
const router      = express.Router();

/* ── Rate limiters ───────────────────────────────────────────────── */
const inviteSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many invite requests. Please wait 15 minutes.' },
});

const inviteValidateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many validation requests. Please wait 5 minutes.' },
});

const joinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many join requests. Please wait 5 minutes.' },
});

/* ── Invite endpoints ────────────────────────────────────────────── */

// Generate + send invite email (requires host auth)
router.post('/invite/send',       inviteSendLimiter,     requireAuth, sendInvite);

// Generate invite code/link only — no email (requires host auth)
router.post('/invite/generate',   inviteSendLimiter,     requireAuth, generateInvite);

// Validate 5-digit code (public — joining flow before login)
router.post('/invite/code',       inviteValidateLimiter, validateCode);

// Validate invite token from link (public — joining flow before login)
router.post('/invite/link',       inviteValidateLimiter, validateToken);

// Actually join the suite (requires uid)
router.post('/suite/join',        joinLimiter,           requireAuth, joinSuite);

// Host going offline — invalidate their invites (requires host auth)
router.post('/invite/invalidate', inviteSendLimiter,     requireAuth, invalidateHostInvites);

/* ── SSE: suite member presence stream ───────────────────────────── */
/**
 * GET /api/suite/:id/members/stream
 * Clients connect here to receive real-time member-list pushes.
 * On first connect, sends the current member list from Firestore.
 */
const { db } = require('../config/firebase');

router.get('/suite/:id/members/stream', async (req, res) => {
  const suiteId = (req.params.id || '').trim();
  if (!suiteId) { res.status(400).end(); return; }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx: disable buffering
  res.flushHeaders();

  // Register this client
  if (!inviteStore.sseClients.has(suiteId)) {
    inviteStore.sseClients.set(suiteId, new Set());
  }
  inviteStore.sseClients.get(suiteId).add(res);

  // Send current members immediately on connect
  try {
    const doc = await db.collection('suites').doc(suiteId).get();
    if (doc.exists) {
      const members = doc.data().members || [];
      res.write(`data: ${JSON.stringify({ type: 'members', members })}\n\n`);
    }
  } catch (_) {}

  // Heartbeat every 25s to keep connection alive through proxies
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(hb); }
  }, 25000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(hb);
    const clients = inviteStore.sseClients.get(suiteId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) inviteStore.sseClients.delete(suiteId);
    }
  });
});

module.exports = router;
