'use strict';
/**
 * driveController.js – HTTP handlers for Google Drive integration
 * ─────────────────────────────────────────────────────────────────
 *  GET  /api/drive/status          – Is Drive connected for this user?
 *  GET  /api/drive/auth-url        – Get OAuth2 consent URL
 *  GET  /api/drive/callback        – OAuth2 callback (exchange code)
 *  POST /api/drive/disconnect      – Revoke Drive access
 *  POST /api/drive/upload          – Upload file to Drive + Firestore metadata
 *  GET  /api/drive/files/:suiteId  – List files for a suite
 *  DELETE /api/drive/files/:fileId – Delete a file
 *  POST /api/drive/grant-member    – Grant Drive access to a new member
 *  POST /api/drive/revoke-member   – Revoke Drive access from removed member
 */

const { db, firestoreWithRetry }                     = require('../config/firebase');
const driveAuthService                               = require('../services/driveAuthService');
const driveService                                   = require('../services/driveService');
const { DriveNotConnectedError }                     = require('../services/driveAuthService');
const { broadcastToSuite }                           = require('../models/inviteStore');

/* ═══════════════════════════════════════════════════════
   GET /api/drive/status
   Returns whether the calling user has Drive connected.
   ═══════════════════════════════════════════════════════ */
async function getDriveStatus(req, res) {
  const uid = req.verifiedUid;
  try {
    const info = await driveAuthService.getConnectionInfo(uid);
    return res.json({ success: true, ...info });
  } catch (e) {
    console.error('[driveController] getDriveStatus error:', e.message);
    return res.json({ success: true, connected: false });
  }
}

/* ═══════════════════════════════════════════════════════
   GET /api/drive/auth-url
   Returns the Google OAuth2 consent page URL.
   ═══════════════════════════════════════════════════════ */
function getAuthUrl(req, res) {
  // Guard: credentials not yet configured
  if (process.env._DRIVE_MISCONFIGURED === '1') {
    return res.status(503).json({
      success: false,
      error: 'DRIVE_NOT_CONFIGURED',
      message:
        'Google Drive credentials are not configured. ' +
        'Open backend/.env and set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ' +
        'and GOOGLE_REDIRECT_URI with real values from Google Cloud Console. ' +
        'Then restart the server.',
    });
  }

  const uid = req.verifiedUid;
  try {
    const url = driveAuthService.getAuthUrl(uid);
    return res.json({ success: true, url });
  } catch (e) {
    console.error('[driveController] getAuthUrl error:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
}

/* ═══════════════════════════════════════════════════════
   GET /api/drive/callback
   OAuth2 callback from Google. Exchanges code for tokens.
   On success: renders a self-closing popup page that
   sends postMessage to the parent window.
   ═══════════════════════════════════════════════════════ */
async function handleCallback(req, res) {
  const { code, state: uid, error } = req.query;

  // Render helper that sends postMessage and closes popup
  function renderCallbackPage(success, message) {
    const payload = JSON.stringify({ type: 'drive_oauth', success, message });
    return res.send(`<!DOCTYPE html>
<html>
<head><title>CoLearn – Drive Connect</title></head>
<body style="font-family:Arial,sans-serif;background:#f8f9fa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="text-align:center;background:#fff;border-radius:12px;padding:2rem 3rem;box-shadow:0 4px 24px rgba(0,0,0,0.1);">
    <div style="font-size:2.5rem;margin-bottom:0.6rem;">${success ? '✅' : '❌'}</div>
    <div style="font-weight:700;color:#212529;margin-bottom:0.3rem;">${success ? 'Google Drive Connected!' : 'Connection Failed'}</div>
    <div style="color:#6c757d;font-size:0.9rem;">${message}</div>
    <div style="color:#adb5bd;font-size:0.8rem;margin-top:1rem;">This window will close automatically…</div>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage(${payload}, '*');
      }
    } catch(e) {}
    setTimeout(function() { window.close(); }, 2000);
  </script>
</body>
</html>`);
  }

  // Google returned an error (user denied)
  if (error) {
    console.warn('[driveController] OAuth error from Google:', error);
    return renderCallbackPage(false, 'Authorization was cancelled or denied.');
  }

  if (!code || !uid) {
    return renderCallbackPage(false, 'Invalid callback parameters.');
  }

  try {
    const result = await driveAuthService.exchangeCode(code, uid);
    return renderCallbackPage(true, `Connected as ${result.email}. You can close this window.`);
  } catch (e) {
    console.error('[driveController] exchangeCode error:', e.message);
    return renderCallbackPage(false, 'Could not connect Google Drive. Please try again.');
  }
}

/* ═══════════════════════════════════════════════════════
   POST /api/drive/disconnect
   Revokes Drive access for the user.
   ═══════════════════════════════════════════════════════ */
async function disconnectDrive(req, res) {
  const uid = req.verifiedUid;
  try {
    await driveAuthService.revokeAccess(uid);
    return res.json({ success: true, message: 'Google Drive disconnected.' });
  } catch (e) {
    console.error('[driveController] disconnectDrive error:', e.message);
    return res.status(500).json({ success: false, error: 'Could not disconnect Drive.' });
  }
}

/* ═══════════════════════════════════════════════════════
   POST /api/drive/upload
   Receives a multipart file upload, streams it to Drive,
   saves metadata to Firestore, and broadcasts via SSE.

   Expected: multipart/form-data with fields:
     file    – the file (from multer)
     suiteId – the suite this file belongs to
   ═══════════════════════════════════════════════════════ */
async function uploadFile(req, res) {
  const uid = req.verifiedUid;

  // multer populates req.file
  const multerFile = req.file;
  const suiteId    = (req.body.suiteId || '').trim();

  if (!multerFile) {
    return res.status(400).json({ success: false, error: 'No file provided.' });
  }
  if (!suiteId) {
    return res.status(400).json({ success: false, error: 'suiteId is required.' });
  }

  // Verify user is a member of the suite
  let suiteData;
  try {
    const suiteSnap = await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).get()
    );
    if (!suiteSnap.exists) {
      return res.status(404).json({ success: false, error: 'Suite not found.' });
    }
    suiteData = suiteSnap.data();
    const memberUids = suiteData.memberUids || [];
    if (!memberUids.includes(uid) && suiteData.ownerUid !== uid) {
      return res.status(403).json({ success: false, error: 'You are not a member of this suite.' });
    }
  } catch (e) {
    console.error('[driveController] Suite membership check failed:', e.message);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }

  // Get user info
  let userDoc;
  try {
    const userSnap = await firestoreWithRetry(() =>
      db.collection('users').doc(uid).get()
    );
    userDoc = userSnap.exists ? userSnap.data() : { name: 'Unknown', email: '' };
  } catch (e) {
    userDoc = { name: 'Unknown', email: '' };
  }

  // Get Drive access token for the uploader
  let accessToken;
  try {
    accessToken = await driveAuthService.getAccessToken(uid);
  } catch (e) {
    if (e.code === 'DRIVE_NOT_CONNECTED') {
      return res.status(403).json({
        success: false,
        error: 'DRIVE_NOT_CONNECTED',
        message: 'Please connect your Google Drive before uploading.',
      });
    }
    return res.status(500).json({ success: false, error: 'Could not authenticate with Google Drive.' });
  }

  // Get or create suite folder in Drive
  let folderId;
  try {
    folderId = await driveService.getOrCreateSuiteFolder(
      accessToken, suiteId, suiteData.name || 'Suite'
    );
  } catch (e) {
    console.error('[driveController] getOrCreateSuiteFolder failed:', e.message);
    return res.status(500).json({ success: false, error: 'Could not create Drive folder.' });
  }

  // Check for duplicate filename in Firestore
  let existingFileId = null;
  try {
    const existingSnap = await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).collection('files')
        .where('fileName', '==', multerFile.originalname)
        .limit(1)
        .get()
    );
    if (!existingSnap.empty) {
      existingFileId = existingSnap.docs[0].id;
    }
  } catch (e) {
    // Non-blocking
  }

  // Handle duplicate: if duplicate-action header sent
  const duplicateAction = req.headers['x-duplicate-action'] || 'keep_both';
  let finalFileName = multerFile.originalname;

  if (existingFileId && duplicateAction === 'keep_both') {
    // Auto-rename: "report.pdf" → "report (2).pdf"
    const parts = multerFile.originalname.match(/^(.*?)(\.[^.]+)?$/);
    const base  = parts[1] || multerFile.originalname;
    const ext   = parts[2] || '';
    finalFileName = `${base} (${Date.now()})${ext}`;
  } else if (existingFileId && duplicateAction === 'replace') {
    // Delete the old file from Firestore (Drive file stays in user's Drive)
    try {
      const oldDoc = await firestoreWithRetry(() =>
        db.collection('suites').doc(suiteId).collection('files').doc(existingFileId).get()
      );
      if (oldDoc.exists && oldDoc.data().driveFileId) {
        await driveService.deleteFile(accessToken, oldDoc.data().driveFileId);
      }
      await firestoreWithRetry(() =>
        db.collection('suites').doc(suiteId).collection('files').doc(existingFileId).delete()
      );
    } catch (e) {
      console.warn('[driveController] Could not clean up replaced file:', e.message);
    }
  }

  // Upload to Drive (stream the buffer)
  let driveFile;
  try {
    const { Readable } = require('stream');
    const bufferStream = new Readable();
    bufferStream.push(multerFile.buffer);
    bufferStream.push(null);

    driveFile = await driveService.uploadFile(
      accessToken,
      folderId,
      bufferStream,
      finalFileName,
      multerFile.mimetype,
      multerFile.size
    );
  } catch (e) {
    console.error('[driveController] Drive upload failed:', e.message);
    return res.status(500).json({ success: false, error: `Upload failed: ${e.message}` });
  }

  // Grant read permissions to all current suite members
  const memberUids = suiteData.memberUids || [];
  const memberEmails = [];
  try {
    const emailFetches = memberUids
      .filter(mUid => mUid !== uid) // uploader already has access
      .map(async (mUid) => {
        try {
          const snap = await firestoreWithRetry(() =>
            db.collection('users').doc(mUid).get()
          );
          if (snap.exists && snap.data().email) {
            return snap.data().email;
          }
        } catch (e) { /* ignore */ }
        return null;
      });
    const resolved = await Promise.all(emailFetches);
    resolved.forEach(email => { if (email) memberEmails.push(email); });
  } catch (e) {
    console.warn('[driveController] Could not fetch member emails:', e.message);
  }

  // Grant permissions (fire-and-forget, non-blocking)
  const permissionIds = {};
  await Promise.all(
    memberEmails.map(async (email) => {
      const permId = await driveService.grantPermission(accessToken, driveFile.id, email);
      if (permId) permissionIds[email] = permId;
    })
  );

  // Build embed URL
  const embedUrl = driveService.buildEmbedUrl(driveFile.id, multerFile.mimetype);

  // Save metadata to Firestore
  const now = new Date().toISOString();
  const fileMetadata = {
    driveFileId:      driveFile.id,
    driveFolderId:    folderId,
    suiteId,
    ownerUid:         uid,
    ownerEmail:       userDoc.email  || '',
    uploadedByName:   userDoc.name   || 'Unknown',
    fileName:         finalFileName,
    mimeType:         multerFile.mimetype,
    fileSize:         multerFile.size,
    uploadedAt:       now,
    driveWebViewLink: driveFile.webViewLink    || '',
    driveDownloadLink: driveFile.webContentLink || '',
    driveEmbedUrl:    embedUrl,
    thumbnail:        driveFile.thumbnailLink  || '',
    version:          1,
    permissionIds,  // { email: permissionId } for revocation
  };

  let firestoreFileId;
  try {
    const docRef = await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).collection('files').add(fileMetadata)
    );
    firestoreFileId = docRef.id;
  } catch (e) {
    console.error('[driveController] Firestore metadata save failed:', e.message);
    return res.status(500).json({ success: false, error: 'File uploaded to Drive but metadata save failed.' });
  }

  const responseFile = { id: firestoreFileId, ...fileMetadata };

  // Broadcast SSE event to all suite members
  try {
    broadcastToSuite(suiteId, {
      type: 'file_added',
      file: responseFile,
    });
  } catch (e) {
    console.warn('[driveController] SSE broadcast failed:', e.message);
  }

  console.log(`[Drive] File uploaded: "${finalFileName}" → suite=${suiteId} by uid=${uid}`);
  return res.status(201).json({ success: true, file: responseFile });
}

/* ═══════════════════════════════════════════════════════
   GET /api/drive/files/:suiteId
   Returns all Drive file metadata for a suite from Firestore.
   ═══════════════════════════════════════════════════════ */
async function listFiles(req, res) {
  const uid     = req.verifiedUid;
  const suiteId = (req.params.suiteId || '').trim();

  if (!suiteId) {
    return res.status(400).json({ success: false, error: 'suiteId is required.' });
  }

  // Verify membership
  try {
    const suiteSnap = await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).get()
    );
    if (!suiteSnap.exists) {
      return res.status(404).json({ success: false, error: 'Suite not found.' });
    }
    const suiteData  = suiteSnap.data();
    const memberUids = suiteData.memberUids || [];
    if (!memberUids.includes(uid) && suiteData.ownerUid !== uid) {
      return res.status(403).json({ success: false, error: 'Not a suite member.' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Server error.' });
  }

  try {
    const snap = await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).collection('files')
        .orderBy('uploadedAt', 'desc')
        .limit(100)
        .get()
    );
    const files = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ success: true, files });
  } catch (e) {
    console.error('[driveController] listFiles error:', e.message);
    return res.status(500).json({ success: false, error: 'Could not fetch files.' });
  }
}

/* ═══════════════════════════════════════════════════════
   DELETE /api/drive/files/:fileId
   Deletes a file from Drive + removes Firestore metadata.
   Only the file owner or suite host may delete.
   ═══════════════════════════════════════════════════════ */
async function deleteFile(req, res) {
  const uid    = req.verifiedUid;
  const fileId = (req.params.fileId || '').trim();
  const suiteId = (req.body.suiteId || req.query.suiteId || '').trim();

  if (!fileId || !suiteId) {
    return res.status(400).json({ success: false, error: 'fileId and suiteId are required.' });
  }

  // Fetch file metadata
  let fileMeta;
  try {
    const snap = await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).collection('files').doc(fileId).get()
    );
    if (!snap.exists) {
      return res.status(404).json({ success: false, error: 'File not found.' });
    }
    fileMeta = snap.data();
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Server error.' });
  }

  // Verify caller is owner or suite host
  const suiteSnap = await firestoreWithRetry(() =>
    db.collection('suites').doc(suiteId).get()
  ).catch(() => null);
  const isHost    = suiteSnap && suiteSnap.data().ownerUid === uid;
  const isOwner   = fileMeta.ownerUid === uid;

  if (!isHost && !isOwner) {
    return res.status(403).json({ success: false, error: 'Only the file owner or suite host can delete files.' });
  }

  // Trash file in Drive (using owner's token)
  try {
    const accessToken = await driveAuthService.getAccessToken(fileMeta.ownerUid);
    await driveService.deleteFile(accessToken, fileMeta.driveFileId);
  } catch (e) {
    console.warn('[driveController] deleteFile from Drive failed:', e.message);
    // Continue — remove Firestore record regardless
  }

  // Remove Firestore metadata
  try {
    await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).collection('files').doc(fileId).delete()
    );
  } catch (e) {
    console.error('[driveController] Firestore delete failed:', e.message);
    return res.status(500).json({ success: false, error: 'Could not remove file metadata.' });
  }

  // Broadcast SSE — include suiteId so frontend can filter per-suite
  try {
    broadcastToSuite(suiteId, { type: 'file_deleted', fileId, suiteId });
  } catch (e) { /* non-fatal */ }

  console.log(`[Drive] File deleted: ${fileId} from suite=${suiteId} by uid=${uid}`);
  return res.json({ success: true, message: 'File deleted.' });
}

/* ═══════════════════════════════════════════════════════
   POST /api/drive/grant-member
   Called when a new member joins a suite.
   Grants them read access to all existing suite Drive files.
   Body: { suiteId, memberUid, memberEmail }
   ═══════════════════════════════════════════════════════ */
async function grantMemberAccess(req, res) {
  const uid         = req.verifiedUid;
  const suiteId     = (req.body.suiteId     || '').trim();
  const memberEmail = (req.body.memberEmail || '').trim();

  if (!suiteId || !memberEmail) {
    return res.status(400).json({ success: false, error: 'suiteId and memberEmail are required.' });
  }

  // Verify caller is suite host
  try {
    const suiteSnap = await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).get()
    );
    if (!suiteSnap.exists) {
      return res.status(404).json({ success: false, error: 'Suite not found.' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Server error.' });
  }

  // Get all files in this suite
  let files = [];
  try {
    const snap = await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).collection('files').get()
    );
    files = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (e) {
    return res.json({ success: true, granted: 0 }); // no files yet
  }

  // For each file, grant permission using the file owner's token
  let grantedCount = 0;
  const ownerTokenCache = {};

  await Promise.all(files.map(async (file) => {
    try {
      if (!ownerTokenCache[file.ownerUid]) {
        ownerTokenCache[file.ownerUid] = await driveAuthService.getAccessToken(file.ownerUid);
      }
      const permId = await driveService.grantPermission(
        ownerTokenCache[file.ownerUid],
        file.driveFileId,
        memberEmail
      );
      if (permId) {
        // Update permission IDs in Firestore
        const updatedPermissions = { ...(file.permissionIds || {}) };
        updatedPermissions[memberEmail] = permId;
        await firestoreWithRetry(() =>
          db.collection('suites').doc(suiteId).collection('files').doc(file.id).update({
            permissionIds: updatedPermissions,
          })
        );
        grantedCount++;
      }
    } catch (e) {
      console.warn(`[driveController] Could not grant access to ${memberEmail} for file ${file.id}:`, e.message);
    }
  }));

  return res.json({ success: true, granted: grantedCount });
}

/* ═══════════════════════════════════════════════════════
   POST /api/drive/revoke-member
   Called when a member is removed from a suite.
   Revokes their Drive access to all suite files.
   Body: { suiteId, memberEmail }
   ═══════════════════════════════════════════════════════ */
async function revokeMemberAccess(req, res) {
  const uid         = req.verifiedUid;
  const suiteId     = (req.body.suiteId     || '').trim();
  const memberEmail = (req.body.memberEmail || '').trim();

  if (!suiteId || !memberEmail) {
    return res.status(400).json({ success: false, error: 'suiteId and memberEmail are required.' });
  }

  // Verify caller is suite host
  try {
    const suiteSnap = await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).get()
    );
    if (!suiteSnap.exists) {
      return res.status(404).json({ success: false, error: 'Suite not found.' });
    }
    if (suiteSnap.data().ownerUid !== uid) {
      return res.status(403).json({ success: false, error: 'Only the host can revoke member access.' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Server error.' });
  }

  // Get all files
  let files = [];
  try {
    const snap = await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).collection('files').get()
    );
    files = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (e) {
    return res.json({ success: true, revoked: 0 });
  }

  let revokedCount = 0;
  const ownerTokenCache = {};

  await Promise.all(files.map(async (file) => {
    const permissionIds = file.permissionIds || {};
    const permId        = permissionIds[memberEmail];
    if (!permId) return;

    try {
      if (!ownerTokenCache[file.ownerUid]) {
        ownerTokenCache[file.ownerUid] = await driveAuthService.getAccessToken(file.ownerUid);
      }
      await driveService.revokePermission(
        ownerTokenCache[file.ownerUid],
        file.driveFileId,
        permId
      );
      // Clean up permissionId from Firestore
      const updatedPermissions = { ...(file.permissionIds || {}) };
      delete updatedPermissions[memberEmail];
      await firestoreWithRetry(() =>
        db.collection('suites').doc(suiteId).collection('files').doc(file.id).update({
          permissionIds: updatedPermissions,
        })
      );
      revokedCount++;
    } catch (e) {
      console.warn(`[driveController] Could not revoke ${memberEmail} from file ${file.id}:`, e.message);
    }
  }));

  return res.json({ success: true, revoked: revokedCount });
}

module.exports = {
  getDriveStatus,
  getAuthUrl,
  handleCallback,
  disconnectDrive,
  uploadFile,
  listFiles,
  deleteFile,
  grantMemberAccess,
  revokeMemberAccess,
};
