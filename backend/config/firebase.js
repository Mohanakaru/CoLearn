'use strict';
/**
 * Firebase Admin SDK – initialisation
 * ─────────────────────────────────────────────────────────────────
 * Reads the service-account key from the path specified in .env and
 * exports ready-to-use `auth` and `db` (Firestore) references.
 *
 * Compatible with firebase-admin v12+ (modular-style top-level exports).
 */

const {
  initializeApp,
  getApps,
  cert,
} = require('firebase-admin/app');

const { getAuth }      = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const path             = require('path');

/* ── Load service-account key ────────────────────────────────── */
const KEY_PATH     = process.env.FIREBASE_KEY_PATH || './config/serviceAccountKey.json';
const resolvedPath = path.resolve(__dirname, '..', KEY_PATH.replace(/^\.\//, ''));

let serviceAccount;
try {
  serviceAccount = require(resolvedPath);
} catch (e) {
  console.error(`\n❌  Firebase: Cannot load service-account key at: ${resolvedPath}`);
  console.error('   → Download it from Firebase Console → Project Settings → Service Accounts');
  console.error('   → Select Node.js, click "Generate new private key".');
  console.error('   → Place the JSON at backend/config/serviceAccountKey.json');
  console.error('   → Or set FIREBASE_KEY_PATH in backend/.env if the path differs.\n');
  process.exit(1);
}

const credentialInstance = cert(serviceAccount);

/* ── Initialise only once (safe for nodemon hot-reloads) ─────── */
if (getApps().length === 0) {
  initializeApp({
    credential: credentialInstance,
  });
  console.log(`🔥  Firebase Admin initialised (project: ${serviceAccount.project_id})`);
}

const auth = getAuth();
const db   = getFirestore();

async function warmUpFirebase() {
  console.log('🔄  Firebase: Warming up Auth token...');
  try {
    const token = await credentialInstance.getAccessToken();
    console.log('✅  Firebase: Auth token warmed up successfully.');
    return token;
  } catch (err) {
    console.error('❌  Firebase: Failed to fetch access token during warm-up.');
    console.error('Full Error:', {
      message: err.message,
      code: err.code,
      stack: err.stack,
      ...err
    });
    throw err;
  }
}

async function firestoreWithRetry(operation, maxRetries = 2, retryDelayMs = 300) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      const isUnauthenticated =
        err.code === 16 ||
        err.code === 'UNAUTHENTICATED' ||
        (err.message || '').includes('UNAUTHENTICATED') ||
        (err.message || '').includes('invalid authentication credentials');

      if (isUnauthenticated && attempt < maxRetries) {
        const wait = retryDelayMs * (attempt + 1);
        console.warn(
          `[Firestore] UNAUTHENTICATED on attempt ${attempt + 1} — retrying in ${wait}ms…`
        );
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      // Non-auth error or retries exhausted
      throw err;
    }
  }
}

module.exports = { auth, db, warmUpFirebase, firestoreWithRetry };
