'use strict';
/**
 * driveService.js – Google Drive file operations
 * ─────────────────────────────────────────────────────────────────
 *  Handles all Drive API interactions:
 *    • Folder creation / reuse per suite
 *    • Streaming file upload
 *    • File permissions (grant/revoke per suite member)
 *    • File listing
 *    • File deletion
 *
 *  PERFORMANCE:
 *    • Folder IDs are cached in Firestore (suites/{id}.driveFolderId)
 *    • No Drive search performed on every upload
 *    • Streaming upload — file data never fully buffered in memory
 */

const { google }           = require('googleapis');
const { PassThrough }      = require('stream');
const { db, firestoreWithRetry } = require('../config/firebase');

/* ── Drive client factory ────────────────────────────────────────── */
function createDriveClient(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth });
}

/* ── Sanitize folder name ────────────────────────────────────────── */
function sanitizeFolderName(suiteName) {
  // Replace invalid chars, trim, max 100 chars
  return (suiteName || 'Unnamed')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
    .slice(0, 80)
    .concat('_Files_from_CoLearn');
}

/* ══════════════════════════════════════════════════════════════════
   getOrCreateSuiteFolder
   Returns the Drive folder ID for this suite.
   Caches in Firestore to avoid repeated Drive searches.
   ══════════════════════════════════════════════════════════════════ */
async function getOrCreateSuiteFolder(accessToken, suiteId, suiteName) {
  const drive = createDriveClient(accessToken);

  // 1. Check Firestore cache first
  try {
    const suiteSnap = await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).get()
    );
    if (suiteSnap.exists) {
      const data = suiteSnap.data();
      if (data.driveFolderId) {
        // Verify the folder still exists in Drive
        try {
          await drive.files.get({
            fileId: data.driveFolderId,
            fields: 'id,name,trashed',
          });
          const folderData = (await drive.files.get({
            fileId: data.driveFolderId,
            fields: 'id,name,trashed',
          })).data;

          if (!folderData.trashed) {
            console.log(`[Drive] Reusing cached folder: ${data.driveFolderId} for suite=${suiteId}`);
            return data.driveFolderId;
          }
        } catch (e) {
          // Folder not found or deleted — create new one
          console.warn(`[Drive] Cached folder ${data.driveFolderId} no longer accessible, creating new one.`);
        }
      }
    }
  } catch (e) {
    console.warn('[Drive] Could not check Firestore folder cache:', e.message);
  }

  // 2. Create new folder in Drive
  const folderName = sanitizeFolderName(suiteName);

  // First: search for existing folder with the same name (idempotent)
  let existingFolderId = null;
  try {
    const searchRes = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}' and trashed=false`,
      fields: 'files(id,name)',
      spaces: 'drive',
      pageSize: 1,
    });
    if (searchRes.data.files && searchRes.data.files.length > 0) {
      existingFolderId = searchRes.data.files[0].id;
      console.log(`[Drive] Found existing folder "${folderName}": ${existingFolderId}`);
    }
  } catch (e) {
    console.warn('[Drive] Folder search failed, will create new:', e.message);
  }

  let folderId;
  if (existingFolderId) {
    folderId = existingFolderId;
  } else {
    // Create folder
    const folderRes = await drive.files.create({
      requestBody: {
        name:     folderName,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });
    folderId = folderRes.data.id;
    console.log(`[Drive] Created new folder "${folderName}": ${folderId}`);
  }

  // 3. Persist folder ID to Firestore
  try {
    await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).update({
        driveFolderId:   folderId,
        driveFolderName: folderName,
        driveUpdatedAt:  new Date().toISOString(),
      })
    );
  } catch (e) {
    console.warn('[Drive] Could not cache folder ID in Firestore:', e.message);
  }

  return folderId;
}

/* ══════════════════════════════════════════════════════════════════
   uploadFile
   Streams file data to Google Drive.
   Uses resumable upload for reliability on large files.
   Returns Drive file metadata.
   ══════════════════════════════════════════════════════════════════ */
async function uploadFile(accessToken, folderId, fileStream, fileName, mimeType, fileSize) {
  const drive = createDriveClient(accessToken);

  // Use a PassThrough stream to pipe req stream to Drive
  const passThrough = new PassThrough();
  fileStream.pipe(passThrough);

  let uploadRes;
  try {
    uploadRes = await drive.files.create({
      requestBody: {
        name:    fileName,
        parents: [folderId],
      },
      media: {
        mimeType: mimeType || 'application/octet-stream',
        body:     passThrough,
      },
      fields: 'id,name,mimeType,size,webViewLink,webContentLink,thumbnailLink,createdTime',
      // Use resumable upload for files > 5MB
      uploadType: fileSize && fileSize > 5 * 1024 * 1024 ? 'resumable' : 'multipart',
    });
  } catch (e) {
    console.error('[Drive] File upload failed:', e.message);
    throw new Error(`Drive upload failed: ${e.message}`);
  }

  return uploadRes.data;
}

/* ══════════════════════════════════════════════════════════════════
   grantPermission
   Grants reader access to a specific email address.
   Returns the permission ID (for later revocation).
   ══════════════════════════════════════════════════════════════════ */
async function grantPermission(accessToken, driveFileId, emailAddress) {
  const drive = createDriveClient(accessToken);

  try {
    const permRes = await drive.permissions.create({
      fileId: driveFileId,
      requestBody: {
        type:         'user',
        role:         'reader',
        emailAddress: emailAddress,
      },
      fields: 'id',
      // Suppress email notification from Google
      sendNotificationEmail: false,
    });
    return permRes.data.id;
  } catch (e) {
    // Don't throw — a failed permission grant shouldn't block upload
    console.warn(`[Drive] Could not grant permission to ${emailAddress} for ${driveFileId}:`, e.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════
   revokePermission
   Removes a user's reader access from a Drive file.
   ══════════════════════════════════════════════════════════════════ */
async function revokePermission(accessToken, driveFileId, permissionId) {
  if (!permissionId) return;
  const drive = createDriveClient(accessToken);

  try {
    await drive.permissions.delete({
      fileId:       driveFileId,
      permissionId: permissionId,
    });
  } catch (e) {
    console.warn(`[Drive] Could not revoke permission ${permissionId} from ${driveFileId}:`, e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════
   grantFolderPermission
   Grants reader access to the entire suite folder.
   Used when a new member joins.
   ══════════════════════════════════════════════════════════════════ */
async function grantFolderPermission(accessToken, folderId, emailAddress) {
  return grantPermission(accessToken, folderId, emailAddress);
}

/* ══════════════════════════════════════════════════════════════════
   listFilesInFolder
   Lists files inside a Drive folder by folder ID.
   Returns minimal metadata.
   ══════════════════════════════════════════════════════════════════ */
async function listFilesInFolder(accessToken, folderId) {
  const drive = createDriveClient(accessToken);

  try {
    const res = await drive.files.list({
      q:      `'${folderId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType,size,webViewLink,webContentLink,thumbnailLink,createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 100,
    });
    return res.data.files || [];
  } catch (e) {
    console.error('[Drive] listFilesInFolder failed:', e.message);
    throw new Error('Could not list Drive files.');
  }
}

/* ══════════════════════════════════════════════════════════════════
   deleteFile
   Permanently deletes a file from Drive (moves to Trash first).
   ══════════════════════════════════════════════════════════════════ */
async function deleteFile(accessToken, driveFileId) {
  const drive = createDriveClient(accessToken);

  try {
    // Move to trash (recoverable) rather than permanent delete
    await drive.files.update({
      fileId:      driveFileId,
      requestBody: { trashed: true },
    });
    console.log(`[Drive] File trashed: ${driveFileId}`);
  } catch (e) {
    console.error('[Drive] deleteFile failed:', e.message);
    throw new Error(`Could not delete Drive file: ${e.message}`);
  }
}

/* ══════════════════════════════════════════════════════════════════
   buildEmbedUrl
   Returns the best embed URL for a given Drive file.
   ══════════════════════════════════════════════════════════════════ */
function buildEmbedUrl(driveFileId, mimeType) {
  const m = (mimeType || '').toLowerCase();

  if (m.includes('pdf')) {
    return `https://drive.google.com/file/d/${driveFileId}/preview`;
  }
  if (m.includes('word') || m.includes('document')) {
    return `https://docs.google.com/document/d/${driveFileId}/preview`;
  }
  if (m.includes('presentation') || m.includes('pptx') || m.includes('ppt')) {
    return `https://docs.google.com/presentation/d/${driveFileId}/preview`;
  }
  if (m.includes('spreadsheet') || m.includes('xlsx') || m.includes('xls') || m.includes('csv')) {
    return `https://docs.google.com/spreadsheets/d/${driveFileId}/preview`;
  }
  // For images, videos, text, audio — frontend handles direct embed
  // Fallback: generic Drive viewer
  return `https://drive.google.com/file/d/${driveFileId}/preview`;
}

module.exports = {
  getOrCreateSuiteFolder,
  uploadFile,
  grantPermission,
  revokePermission,
  grantFolderPermission,
  listFilesInFolder,
  deleteFile,
  buildEmbedUrl,
  sanitizeFolderName,
};
