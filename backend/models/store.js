'use strict';
/**
 * store.js – Lightweight in-memory stores
 * ─────────────────────────────────────────────────────────────────
 * User accounts are now managed by Firebase Authentication +
 * Cloud Firestore.  This file ONLY keeps the ephemeral OTP store
 * needed for email-verification (signup) and password-reset flows.
 *
 * OTP security:
 *  • The 6-digit code is generated with crypto.randomInt (CSPRNG).
 *  • Only a SHA-256 hash of the code is stored in memory.
 *  • The plaintext code is emailed and then immediately discarded.
 *  • Each OTP is valid for 5 minutes, with a max of 5 verify attempts
 *    before the entry is wiped and a new OTP must be requested.
 */

const crypto = require('crypto');

/* ── Constants ─────────────────────────────────────────────────── */
const OTP_TTL_MS      = 5 * 60 * 1000; // 5 minutes
const OTP_MAX_ATTEMPTS = 5;

/* ── OTP store ─────────────────────────────────────────────────── */
// Map<lowerEmail → { hash, expiresAt, attempts }>
const otpStore = new Map();

/**
 * Generate a cryptographically secure 6-digit OTP.
 * Returns the plaintext string (caller must hash before storing).
 */
function generateOTP() {
  return String(crypto.randomInt(100000, 1000000)).padStart(6, '0');
}

/** SHA-256 hash of a plaintext OTP for safe storage. */
function hashOTP(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Store a hashed OTP for the given email.
 * Replaces any existing entry (i.e., resend clears the old code).
 */
function storeOTP(email, otp) {
  const key       = email.toLowerCase().trim();
  const expiresAt = Date.now() + OTP_TTL_MS;
  const hash      = hashOTP(otp);

  otpStore.set(key, { hash, expiresAt, attempts: 0 });

  // Auto-clean after TTL so memory never grows unbounded
  setTimeout(() => {
    const entry = otpStore.get(key);
    if (entry && entry.expiresAt === expiresAt) otpStore.delete(key);
  }, OTP_TTL_MS + 1000);
}

/** Retrieve the raw OTP entry (without exposing the hash externally). */
function getOTP(email) {
  return otpStore.get(email.toLowerCase().trim()) || null;
}

/**
 * Verify a submitted OTP string against the stored hash.
 * Returns one of: 'ok' | 'not_found' | 'expired' | 'invalid' | 'max_attempts'
 */
function verifyOTP(email, submittedOtp) {
  const key   = email.toLowerCase().trim();
  const entry = otpStore.get(key);

  if (!entry)                        return 'not_found';
  if (Date.now() > entry.expiresAt)  { otpStore.delete(key); return 'expired'; }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) { otpStore.delete(key); return 'max_attempts'; }

  const submittedHash = hashOTP(submittedOtp.trim());
  if (submittedHash !== entry.hash) {
    entry.attempts++;
    return 'invalid';
  }

  // ✅ Correct – consume the OTP (one-time use)
  otpStore.delete(key);
  return 'ok';
}

/** Remove the OTP entry for an email (used after successful verification). */
function deleteOTP(email) {
  otpStore.delete(email.toLowerCase().trim());
}

module.exports = { generateOTP, storeOTP, getOTP, verifyOTP, deleteOTP };
