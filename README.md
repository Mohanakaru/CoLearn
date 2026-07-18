# 🔗 CoLearn – Collaborative Study Suite

A real-time collaborative study platform. Create or join suites, annotate shared documents, draw on a multi-page whiteboard, and chat with your study group. Runs on your local network so friends on the same Wi-Fi can join.

---

## 📁 Project Structure

```
CoLearn/
├── backend/                  ← Node.js / Express API server
│   ├── server.js             ← Entry point
│   ├── package.json
│   ├── .env.example          ← Copy to .env and fill in SMTP credentials
│   ├── config/
│   │   └── email.js          ← Nodemailer transporter setup
│   ├── models/
│   │   └── store.js          ← In-memory user + OTP store
│   ├── services/
│   │   └── emailService.js   ← OTP email sender (HTML branded)
│   ├── controllers/
│   │   └── authController.js ← sendOTP, verifyOTP, health
│   ├── routes/
│   │   └── auth.js           ← POST /api/send-otp, /api/verify-otp, GET /api/health
│   └── middleware/
│       └── errorHandler.js   ← Global Express error handler
│
└── frontend/                 ← Static SPA (HTML + CSS + JS)
    ├── index.html            ← All 6 views (SPA shell)
    ├── css/
    │   └── styles.css        ← Brand tokens + all component styles
    └── js/
        ├── config.js         ← API_BASE, constants
        ├── state.js          ← Global app state
        ├── utils.js          ← showAlert, toast, modal helpers
        ├── api.js            ← fetch() wrappers for backend API
        ├── whiteboard.js     ← HTML5 Canvas whiteboard engine
        ├── router.js         ← navigate() + keyboard shortcuts
        └── views/
            ├── login.js
            ├── signup.js     ← OTP countdown, password strength
            ├── forgot.js
            ├── dashboard.js
            └── workspace.js  ← sidebar, chat, docs, taskbar, Google Drive
```

---

## 🚀 How to Run (Terminal Steps)

### Step 1 – Install backend dependencies

```bash
cd CoLearn/backend
npm install
```

### Step 2 – (Optional) Configure email for OTP delivery

```bash
# Copy the example env file
copy .env.example .env
```

Then open `.env` and fill in:

```env
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_16_char_app_password
```

> **How to get a Gmail App Password:**
> 1. Enable 2-Factor Authentication on your Google account
> 2. Visit: https://myaccount.google.com/apppasswords
> 3. Generate a password for "Mail"
> 4. Paste the 16-character code into `.env`

> ⚠️ If you **skip this step**, OTPs will be printed to the server console instead (great for local testing).

### Step 3 – Start the server

```bash
node server.js
```

Or, for auto-reload on code changes (requires nodemon):

```bash
npm run dev
```

### Step 4 – Open in browser

| Device | URL |
|--------|-----|
| This computer | http://localhost:3000 |
| Friend on same Wi-Fi | http://\<YOUR_IP\>:3000 |

> Your LAN IP is printed in the terminal when the server starts.

---

## 🔑 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/health` | Server health check |
| `POST` | `/api/send-otp` | Generate & send OTP to email |
| `POST` | `/api/verify-otp` | Validate OTP (60 s TTL, one-time use) |

---

## 🧪 Test Credentials (built-in)

| Username / Email | Password |
|-----------------|----------|
| `test` | `test` |
| `admin` | `admin` |
| `alexj` / `alex@example.com` | `pass123` |
| `priyas` / `priya@example.com` | `pass123` |

---

## ✨ Features

- **Sign Up** with real email OTP verification (60 s timer, random code each time)
- **Password & Confirm Password** with live strength meter
- **Forgot Password** via OTP reset
- **5 existing suites** + create permanent/quick suites
- **Workspace**: sidebar member list, private admission queue
- **Document viewer** with page navigation (synced from Google Drive mock)
- **Shared whiteboard** (multi-page, pen/eraser, color, size, save PNG)
- **Suite chat** with simulated peer replies
- **LAN multiplayer** — share the network URL with friends on the same Wi-Fi
