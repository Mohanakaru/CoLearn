'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const { body }  = require('express-validator');
const requireAuth = require('../middleware/requireAuth');

const {
  register,
  login,
  sendResetOTP,
  verifyResetOTP,
  resetPassword,
  sendOTP,
  verifyOTP,
  health,
  getSuites,
  createSuite,
  deleteSuite,
  getSuiteById,
  createCustomToken,
} = require('../controllers/authController');

const router = express.Router();

/* ── Rate limiters ───────────────────────────────────────────── */

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please wait 15 minutes and try again.' },
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please wait 15 minutes and try again.' },
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many OTP requests. Please wait 15 minutes.' },
});

const workspaceReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many workspace read requests. Please wait 15 minutes.' },
});

const workspaceWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many workspace write requests. Please wait 15 minutes.' },
});

/* ── Validation chains ───────────────────────────────────────── */

const registerValidation = [
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required.')
    .isLength({ max: 100 }).withMessage('Name is too long.'),
  body('username')
    .trim()
    .notEmpty().withMessage('Username is required.')
    .isLength({ min: 3, max: 30 }).withMessage('Username must be 3–30 characters.')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username may only contain letters, numbers, and underscores.'),
  body('email')
    .trim()
    .toLowerCase()
    .isEmail().withMessage('Please provide a valid email address.')
    .normalizeEmail(),
  body('password')
    .notEmpty().withMessage('Password is required.'),
];

const loginValidation = [
  body('email')
    .trim()
    .toLowerCase()
    .isEmail().withMessage('Please provide a valid email address.'),
  body('password')
    .notEmpty().withMessage('Password is required.'),
];

/* ── Health ──────────────────────────────────────────────────── */
router.get('/health', health);

/* ── Existing OTP endpoints (signup flow) ────────────────────── */
router.post('/send-otp',   otpLimiter,    sendOTP);
router.post('/verify-otp',               verifyOTP);

/* ── Auth endpoints ──────────────────────────────────────────── */
router.post('/auth/register',
  strictLimiter,
  registerValidation,
  register
);

router.post('/auth/login',
  authLimiter,
  loginValidation,
  login
);

/* ── Password reset flow ─────────────────────────────────────── */
router.post('/auth/send-reset-otp',
  strictLimiter,
  sendResetOTP
);

router.post('/auth/verify-reset-otp',
  authLimiter,
  verifyResetOTP
);

router.post('/auth/reset-password',
  strictLimiter,
  resetPassword
);

/* ── Suite endpoints ────────────────────────────────────────────── */
router.get('/suites',         workspaceReadLimiter,  requireAuth, getSuites);
router.get('/suites/:id',     workspaceReadLimiter,  requireAuth, getSuiteById);
router.post('/suites',        workspaceWriteLimiter, requireAuth, createSuite);
router.delete('/suites/:id',  workspaceWriteLimiter, requireAuth, deleteSuite);

/* ── Firebase Custom Token (for Client SDK auth) ─────────────────── */
// POST /api/auth/token
// Body: { uid }
// Returns a short-lived Firebase custom token so the frontend
// Client SDK can sign in and use Firestore/RTDB with security rules.
router.post('/auth/token', workspaceReadLimiter, requireAuth, createCustomToken);

module.exports = router;
