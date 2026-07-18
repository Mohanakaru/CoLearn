'use strict';
/**
 * inviteStore.js – In-memory invite store
 * ─────────────────────────────────────────────────────────────────
 * Stores active invites for suite sessions.
 * Invites are EPHEMERAL: valid only while the Suite Host is online.
 *
 * Each invite record:
 *  { suiteId, suiteName, inviteCode (5-digit), inviteToken (hex),
 *    hostUid, createdAt, isActive }
 *
 * Security:
 *  • inviteCode: crypto.randomInt (CSPRNG), exactly 5 digits
 *  • inviteToken: crypto.randomBytes(20) hex — 40-char, unguessable
 *  • Suite ID / host UID are NEVER embedded in URLs
 */

const crypto = require('crypto');

/* ── Constants ──────────────────────────────────────────────────── */
const CODE_DIGITS = 5;
const CODE_MIN    = 10000; // 5-digit inclusive lower bound
const CODE_MAX    = 99999; // 5-digit inclusive upper bound

/* ── Storage ────────────────────────────────────────────────────── */
// token  → invite record
const byToken = new Map();
// code   → token (lookup helper)
const byCode  = new Map();
// hostUid → Set<token> (for fast host-level invalidation)
const byHost  = new Map();

/* ── SSE clients: suiteId → Set<res> ────────────────────────────── */
// Used by the SSE member-push feature (server.js attaches this)
const sseClients = new Map();

/* ── Helpers ─────────────────────────────────────────────────────── */

/** Generates a cryptographically secure random 5-digit string. */
function generateCode() {
  // Loop to avoid (very rare) collisions with active codes
  let code;
  let attempts = 0;
  do {
    code = String(crypto.randomInt(CODE_MIN, CODE_MAX + 1));
    attempts++;
    if (attempts > 100) break; // safety valve
  } while (byCode.has(code));
  return code;
}

/** Generates a cryptographically secure URL-safe token. */
function generateToken() {
  return crypto.randomBytes(20).toString('hex'); // 40-char hex
}

/* ── Public API ──────────────────────────────────────────────────── */

/**
 * Create (or replace) an invite for a host+suite pair.
 * Any previous invite from this host for this suite is invalidated first.
 *
 * @returns {{ inviteCode: string, inviteToken: string }}
 */
function createInvite(suiteId, suiteName, hostUid) {
  // Invalidate any existing invites for this host+suite
  const hostTokens = byHost.get(hostUid);
  if (hostTokens) {
    for (const tok of hostTokens) {
      const rec = byToken.get(tok);
      if (rec && rec.suiteId === suiteId) {
        _deactivate(tok, rec.inviteCode);
      }
    }
  }

  const inviteCode  = generateCode();
  const inviteToken = generateToken();

  const record = {
    suiteId,
    suiteName,
    inviteCode,
    inviteToken,
    hostUid,
    createdAt: Date.now(),
    isActive:  true,
  };

  byToken.set(inviteToken, record);
  byCode.set(inviteCode, inviteToken);

  if (!byHost.has(hostUid)) byHost.set(hostUid, new Set());
  byHost.get(hostUid).add(inviteToken);

  console.log(`[Invite] Created — suite=${suiteId} code=${inviteCode}`);
  return { inviteCode, inviteToken };
}

/** Look up an active invite by its 5-digit code. Returns record or null. */
function getByCode(code) {
  const token = byCode.get(String(code));
  if (!token) return null;
  const rec = byToken.get(token);
  return rec && rec.isActive ? rec : null;
}

/** Look up an active invite by its token. Returns record or null. */
function getByToken(token) {
  const rec = byToken.get(token);
  return rec && rec.isActive ? rec : null;
}

/**
 * Invalidate ALL active invites created by a host.
 * Called when the host disconnects / logs out / leaves a suite.
 */
function invalidateHostInvites(hostUid) {
  const tokens = byHost.get(hostUid);
  if (!tokens || tokens.size === 0) return 0;

  let count = 0;
  for (const tok of tokens) {
    const rec = byToken.get(tok);
    if (rec && rec.isActive) {
      _deactivate(tok, rec.inviteCode);
      count++;
    }
  }
  byHost.delete(hostUid);
  if (count > 0) {
    console.log(`[Invite] Invalidated ${count} invite(s) for host uid=${hostUid}`);
  }
  return count;
}

/** Internal: mark a single invite inactive and clean lookup maps. */
function _deactivate(token, code) {
  const rec = byToken.get(token);
  if (rec) rec.isActive = false;
  byCode.delete(code);
  // Keep byToken entry (for audit / token lookup to return 'expired')
}

/** Returns count of active invites (debug helper). */
function activeCount() {
  let n = 0;
  for (const rec of byToken.values()) if (rec.isActive) n++;
  return n;
}

/**
 * Broadcast any JSON payload to all SSE clients watching a suite.
 * Supports both member events (type:'members') and file events
 * (type:'file_added', type:'file_deleted').
 *
 * @param {string} suiteId  - Suite ID
 * @param {object} payload  - JSON-serializable event object
 */
function broadcastToSuite(suiteId, payload) {
  const clients = sseClients.get(suiteId);
  if (!clients || clients.size === 0) return;

  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const clientRes of clients) {
    try {
      clientRes.write(data);
    } catch (_) {
      clients.delete(clientRes);
    }
  }
}

module.exports = {
  createInvite,
  getByCode,
  getByToken,
  invalidateHostInvites,
  activeCount,
  broadcastToSuite,
  sseClients,
};
