'use strict';

const nodemailer = require('nodemailer');

const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'CoLearn';

let transporter = null;
let emailConfigured = false;

function init() {
  if (SMTP_USER && SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      tls: { rejectUnauthorized: false },
    });
    emailConfigured = true;
    console.log(`📧  Email configured → ${SMTP_USER}`);
  } else {
    console.warn('⚠️   SMTP not configured – OTPs will print to console.');
    console.warn('     Set SMTP_USER and SMTP_PASS in backend/.env');
  }
}

module.exports = { init, get transporter() { return transporter; }, get configured() { return emailConfigured; }, SMTP_USER, FROM_NAME };
