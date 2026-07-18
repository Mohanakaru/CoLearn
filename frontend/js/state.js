/* ── Global application state ────────────────────────────────── */
const AppState = {
  /**
   * Logged-in user profile received from the backend.
   * Shape: { uid, name, email, username }
   * null when no user is logged in.
   */
  currentUser:  null,

  currentSuite: null,

  // Auth initialization flag — true once session restore attempt is done
  authReady: false,

  // Workspace
  micOn:          true,
  camOn:          true,
  chatOpen:       false,
  sidebarOpen:    true,
  wsCurrentState: 'invite',   // 'invite' | 'docs' | 'whiteboard'
  docPage:        1,
  DOC_PAGES:      5,

  // OTP flow (signup)
  otpSent:        false,
  otpExpiry:      0,
  otpTimerHandle: null,

  // Forgot-password 3-step flow
  resetEmail:       '',   // email confirmed to exist
  resetOtpVerified: false, // true after OTP is verified in step 2

  /* ── Session persistence helpers ─────────────────────────── */

  /**
   * Saves the current user and suite to localStorage so they
   * survive a page refresh.
   */
  saveSession() {
    try {
      if (this.currentUser) {
        localStorage.setItem('fs_user', JSON.stringify(this.currentUser));
      }
      if (this.currentSuite) {
        localStorage.setItem('fs_suite', JSON.stringify(this.currentSuite));
      }
    } catch (e) {
      console.warn('[AppState] Could not save session to localStorage:', e.message);
    }
  },

  /**
   * Restores user and suite from localStorage.
   * Returns true if a user was restored, false otherwise.
   */
  restoreSession() {
    try {
      const userRaw  = localStorage.getItem('fs_user');
      const suiteRaw = localStorage.getItem('fs_suite');

      if (userRaw) {
        const user = JSON.parse(userRaw);
        // Basic validation
        if (user && user.uid && user.email) {
          this.currentUser = user;
        }
      }
      if (suiteRaw) {
        const suite = JSON.parse(suiteRaw);
        if (suite && suite.id) {
          this.currentSuite = suite;
        }
      }
    } catch (e) {
      console.warn('[AppState] Could not restore session:', e.message);
      this.currentUser  = null;
      this.currentSuite = null;
    }
    this.authReady = true;
    return !!this.currentUser;
  },

  /**
   * Clears the session from localStorage (called on logout).
   */
  clearSession() {
    try {
      localStorage.removeItem('fs_user');
      localStorage.removeItem('fs_suite');
    } catch (e) {
      console.warn('[AppState] Could not clear session:', e.message);
    }
    this.currentUser  = null;
    this.currentSuite = null;
  },

  /**
   * Saves only the suite portion of the session.
   */
  saveSuite(suite) {
    this.currentSuite = suite;
    try {
      if (suite) {
        localStorage.setItem('fs_suite', JSON.stringify(suite));
      } else {
        localStorage.removeItem('fs_suite');
      }
    } catch (e) {}
  },
};
