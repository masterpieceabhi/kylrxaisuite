const express = require('express');
const router = express.Router();
const { register, registerOrganization, login, refreshToken, unlockAccount, verifyMfa, resendMfa } = require('../controllers/authController');

// Rate limiting specifically for Auth
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 mins
    // 10 attempts. The local end-to-end run signs up and signs in more often than that from one machine; it may raise
    // the limit, but only on a server that runs against the emulators and is not production (services/local-demo.js).
    max: require('../services/local-demo').relaxedLimit(process.env, 10),
    message: { success: false, error: 'Too many authentication attempts, please try again later' }
});

router.post('/signup', authLimiter, register);
router.post('/register-organization', authLimiter, registerOrganization);
router.post('/login', authLimiter, login);
router.post('/refresh-token', refreshToken);
router.post('/verify-mfa', verifyMfa);
router.post('/verify-otp', verifyMfa);
router.post('/resend-mfa', resendMfa);

const { verifyToken, authorize } = require('../middleware/authMiddleware');

// Admin-only unlock endpoint (protected with verifyToken and Admin role)
router.get('/unlock/:email', verifyToken, authorize('Admin', 'Super Admin'), unlockAccount);

// Local demo sign-in helper for the quick sign-in buttons on localhost. The route is only added when the server runs
// against the Firebase emulators and NODE_ENV is not production; it also answers only to this machine (services/local-demo.js).
const localDemo = require('../services/local-demo');
if (localDemo.enabled(process.env)) router.get('/dev-demo-login', localDemo.handler);

// New people setting up their sign-in (personal set-up links, the company join link) and "choose a new password"
// after a temporary one: /team/setup/*, /team/join/*, /password-status, /change-password (routes/team-access-public.js)
router.use(require('./team-access-public'));

module.exports = router;
