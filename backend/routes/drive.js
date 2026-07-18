'use strict';
/**
 * drive.js – Google Drive API routes
 * ─────────────────────────────────────────────────────────────────
 *  GET    /api/drive/status          – check Drive connection
 *  GET    /api/drive/auth-url        – get OAuth2 consent URL
 *  GET    /api/drive/callback        – OAuth2 code exchange (popup)
 *  POST   /api/drive/disconnect      – revoke Drive access
 *  POST   /api/drive/upload          – upload file to Drive
 *  GET    /api/drive/files/:suiteId  – list suite files (Firestore metadata)
 *  DELETE /api/drive/files/:fileId   – delete file
 *  POST   /api/drive/grant-member    – grant a new member Drive access
 *  POST   /api/drive/revoke-member   – revoke a removed member's Drive access
 */

const express     = require('express');
const multer      = require('multer');
const rateLimit   = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');

const {
  getDriveStatus,
  getAuthUrl,
  handleCallback,
  disconnectDrive,
  uploadFile,
  listFiles,
  deleteFile,
  grantMemberAccess,
  revokeMemberAccess,
} = require('../controllers/driveController');

const router = express.Router();

/* ── Multer: memory storage, 200 MB limit ────────────────────────── */
// Files are stored in memory buffer and streamed to Drive.
// No disk writes on the server.
// Compatible with multer 1.x and 2.x
const multerStorage = (() => {
  try {
    // multer 2.x uses bufferStorage; 1.x uses memoryStorage
    return multer.bufferStorage ? multer.bufferStorage() : multer.memoryStorage();
  } catch (e) {
    return multer.memoryStorage();
  }
})();

const upload = multer({
  storage: multerStorage,
  limits:  { fileSize: 200 * 1024 * 1024 }, // 200 MB
  fileFilter: (req, file, cb) => {
    // Accept all file types — Drive accepts everything
    cb(null, true);
  },
});

/* ── Rate limiters ───────────────────────────────────────────────── */
const driveReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please wait.' },
});

const driveUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many upload requests. Please wait.' },
});

const driveAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many auth requests. Please wait.' },
});

/* ── Drive Status & Auth ─────────────────────────────────────────── */

// Check if Drive is connected for current user
router.get('/drive/status',
  driveReadLimiter, requireAuth,
  getDriveStatus
);

// Get OAuth2 consent URL
router.get('/drive/auth-url',
  driveAuthLimiter, requireAuth,
  getAuthUrl
);

// OAuth2 callback — public route (called by Google redirect)
// No requireAuth here: state param carries uid, no auth header possible
router.get('/drive/callback',
  driveAuthLimiter,
  handleCallback
);

// Disconnect Drive
router.post('/drive/disconnect',
  driveAuthLimiter, requireAuth,
  disconnectDrive
);

/* ── File Operations ─────────────────────────────────────────────── */

// Upload file to Drive (multipart/form-data)
router.post('/drive/upload',
  driveUploadLimiter,
  requireAuth,
  upload.single('file'),    // 'file' = field name in FormData
  uploadFile
);

// List files for a suite (from Firestore metadata)
router.get('/drive/files/:suiteId',
  driveReadLimiter, requireAuth,
  listFiles
);

// Delete a file
router.delete('/drive/files/:fileId',
  driveUploadLimiter, requireAuth,
  deleteFile
);

/* ── Member Permission Management ────────────────────────────────── */

// Grant Drive access to a newly joined member
router.post('/drive/grant-member',
  driveUploadLimiter, requireAuth,
  grantMemberAccess
);

// Revoke Drive access from a removed member
router.post('/drive/revoke-member',
  driveUploadLimiter, requireAuth,
  revokeMemberAccess
);

module.exports = router;
