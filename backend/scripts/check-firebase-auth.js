'use strict';

const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from backend/.env if available
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const KEY_PATH = process.env.FIREBASE_KEY_PATH || './config/serviceAccountKey.json';
const resolvedPath = path.resolve(__dirname, '..', KEY_PATH.replace(/^\.\//, ''));

console.log('----------------------------------------------------');
console.log('🔍 CoLearn Firebase Diagnostic Script');
console.log('----------------------------------------------------');
console.log(`Local Time: ${new Date().toISOString()}`);
console.log(`Service Account Key Path: ${resolvedPath}\n`);

async function checkClockSkew() {
  console.log('1. Checking system clock skew...');
  try {
    const startTime = Date.now();
    const res = await fetch('https://oauth2.googleapis.com', { method: 'HEAD' });
    const endTime = Date.now();
    const serverDateHeader = res.headers.get('date');

    if (!serverDateHeader) {
      throw new Error('Google servers response did not contain a Date header.');
    }

    const serverTime = Date.parse(serverDateHeader);
    const localTime = Math.round((startTime + endTime) / 2);
    const skewSeconds = Math.round(Math.abs(localTime - serverTime) / 1000);

    // OAuth2 tokens allow up to 5 minutes of clock skew
    if (skewSeconds < 300) {
      console.log(`✅ [PASS] System clock is within acceptable skew. (Diff: ${skewSeconds}s)`);
      return true;
    } else {
      console.log(`❌ [FAIL] System clock skew is too high! (Diff: ${skewSeconds}s)`);
      console.log('   → Actionable Advice: Sync your system clock. Large skew (>5m) invalidates JWT signature verification.');
      return false;
    }
  } catch (err) {
    console.log(`❌ [FAIL] Failed to perform clock skew check.`);
    console.error('   → Error details:', err.message);
    console.log('   → Actionable Advice: Check your internet connection or proxy settings.');
    return false;
  }
}

async function checkTokenFetch() {
  console.log('\n2. Checking Google OAuth2 token fetch...');
  try {
    const { cert } = require('firebase-admin/app');
    let serviceAccount;
    try {
      serviceAccount = require(resolvedPath);
    } catch (err) {
      throw new Error(`Could not load service account key JSON from ${resolvedPath}.`);
    }

    const credential = cert(serviceAccount);
    const tokenPromise = credential.getAccessToken();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Token fetch timed out after 5 seconds')), 5000)
    );

    const token = await Promise.race([tokenPromise, timeoutPromise]);
    if (token && token.access_token) {
      console.log(`✅ [PASS] Fresh access token fetched successfully.`);
      console.log(`   - Expires in: ${token.expires_in} seconds`);
      console.log(`   - Token (masked): ${token.access_token.substring(0, 15)}...`);
      return credential;
    } else {
      throw new Error('Token payload was empty or invalid.');
    }
  } catch (err) {
    console.log(`❌ [FAIL] Google OAuth2 token fetch failed.`);
    console.error('   - Full Error:', err);
    console.log('   → Actionable Advice: Check if your local network blocks oauth2.googleapis.com,');
    console.log('     if you are behind a VPN/proxy requiring configuration, or if the service account key has been revoked.');
    return null;
  }
}

async function checkFirestoreRead(credential) {
  console.log('\n3. Checking trivial Firestore read...');
  if (!credential) {
    console.log(`⚠️ [SKIP] Skipping Firestore read check because token fetch failed.`);
    return false;
  }

  try {
    const { initializeApp } = require('firebase-admin/app');
    const { getFirestore } = require('firebase-admin/firestore');

    initializeApp({
      credential,
    });

    const db = getFirestore();
    const readPromise = db.collection('users').limit(1).get();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Firestore query timed out after 5 seconds')), 5000)
    );

    const snap = await Promise.race([readPromise, timeoutPromise]);
    console.log(`✅ [PASS] Trivial Firestore read succeeded.`);
    console.log(`   - Documents retrieved: ${snap.size}`);
    return true;
  } catch (err) {
    console.log(`❌ [FAIL] Firestore read failed.`);
    console.error('   - Full Error:', err);
    console.log('   → Actionable Advice: Verify network connectivity to firestore.googleapis.com.');
    console.log('     Verify that the database/project exists and that the service account has permission (e.g. Cloud Datastore User role).');
    return false;
  }
}

async function run() {
  const clockOk = await checkClockSkew();
  const credential = await checkTokenFetch();
  const firestoreOk = await checkFirestoreRead(credential);

  console.log('\n----------------------------------------------------');
  console.log('📊 Diagnostic Summary:');
  console.log(`   - Clock Sync Check:      ${clockOk ? 'PASS' : 'FAIL'}`);
  console.log(`   - Token Exchange Check:  ${credential ? 'PASS' : 'FAIL'}`);
  console.log(`   - Firestore Read Check:  ${firestoreOk ? 'PASS' : 'FAIL'}`);
  console.log('----------------------------------------------------');

  if (clockOk && credential && firestoreOk) {
    console.log('🎉 All checks passed! The Firebase credentials and network path are fully functional.');
  } else {
    console.log('⚠️ Some checks failed. Please review the actionable advice above to troubleshoot.');
  }
}

run();
