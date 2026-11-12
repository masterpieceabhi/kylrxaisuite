const express = require("express");
const path = require("path");
const cors = require("cors");
const bodyParser = require("body-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const xss = require("xss");
const hpp = require("hpp");
const morgan = require("morgan");
require('dotenv').config();

// Utils & Middleware
const logger = require("./utils/logger");
const errorHandler = require("./middleware/errorHandler");
const { verifyToken } = require("./middleware/authMiddleware");

// Route Imports
const authRoutes = require("./routes/auth");
const dataRoutes = require("./routes/data");
const notificationRoutes = require("./routes/notifications");
const adminRoutes = require("./routes/admin");

const messageRoutes = require("./routes/messages");
const aiRoutes = require("./routes/ai");
const payrollRoutes = require("./routes/payroll");
const emailRoutes = require("./routes/email");
const automationRoutes = require("./routes/automation");
const assignmentRoutes = require("./routes/assignments");
const alertRoutes = require("./routes/alerts");
const analyticsRoutes = require("./routes/analytics");
const centralDashboardRoutes = require("./routes/central-dashboard");
const taskRoutes = require("./routes/tasks");
const notificationCenterRoutes = require("./routes/notification-center");
const documentTemplatesRoutes = require("./routes/document-templates");
const workflowBuilderRoutes = require("./routes/workflow-builder");
const integrationsRoutes = require("./routes/integrations");
const hrOsRoutes = require("./routes/hr-os");
const policiesRoutes = require("./routes/policies");
const assetsRoutes = require("./routes/assets");
const exitsRoutes = require("./routes/exits");
const managerGoalsRoutes = require("./routes/manager-goals");
const employeeGoalsRoutes = require("./routes/employee-goals");
const customTemplatesRoutes = require("./routes/custom-templates");
const bulkTriggerRoutes = require("./routes/bulk-trigger");
const payrollSettingsRoutes = require("./routes/payroll-settings");
const controlsAcceptanceRoutes = require("./routes/controls-acceptance");

const automationEngine = require("./services/automation-engine");


const app = express();
app.set('trust proxy', 1);
app.use(require('./middleware/observability')); // request ids, JSON request logs, metrics
const PORT = process.env.PORT || 3000;

// 0. Firebase Auth reverse proxy (/__/auth/*, /__/firebase/*) so Google sign-in can use
// signInWithRedirect with this server as authDomain (same-origin, no popup, no third-party
// storage). Registered first so helmet's CSP and the body sanitizer don't touch Google's pages.
const FIREBASE_AUTH_HOST = 'https://kylrxai.firebaseapp.com';
app.use(['/__/auth', '/__/firebase'], async (req, res) => {
    try {
        const upstream = await fetch(FIREBASE_AUTH_HOST + req.originalUrl, {
            method: req.method,
            headers: { 'accept': req.headers.accept || '*/*', 'accept-language': req.headers['accept-language'] || '' },
            redirect: 'manual'
        });
        res.status(upstream.status);
        for (const [key, value] of upstream.headers) {
            if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key)) {
                res.setHeader(key, value);
            }
        }
        res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
        res.status(502).send('Firebase auth proxy error');
    }
});

// 1. CORS Configuration MUST be first to handle OPTIONS preflight
const isAllowedOrigin = (origin) => {
    if (!origin) return true;
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (isLocal) {
        return process.env.NODE_ENV !== 'production';
    }
    const isProductionAllowed =
        /kylrxai\.(firebaseapp|web)\.app$/.test(origin) ||
        /kylrxai\.firebaseapp\.com$/.test(origin) ||
        /app\.kylrxai\.com$/.test(origin);
    return isProductionAllowed;
};

app.use(cors({
    origin: function(origin, callback) {
        if (!origin || isAllowedOrigin(origin)) {
            return callback(null, true);
        }
        const corsError = new Error('Not allowed by CORS');
        corsError.statusCode = 403;
        corsError.status = 403;
        return callback(corsError);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true
}));

// Security Middlewares
// 2. Set Security HTTP Headers with Dev-Friendly CSP
app.use(helmet({
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: {
        directives: {
            "default-src":      ["'self'"],
            "script-src":       ["'self'", "'unsafe-inline'", "https://www.gstatic.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://apis.google.com", "https://cdn.tailwindcss.com"],
            "script-src-attr":  ["'unsafe-inline'"],   // ← allows onclick/onchange attributes (was defaulting to 'none')
            "style-src":        ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
            "img-src":          ["'self'", "data:", "https:"],
            "connect-src":      ["'self'", "https://*.gstatic.com", "https://*.googleapis.com", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://firestore.googleapis.com", "wss://*.firebaseio.com", "https://*.firebaseapp.com", "http://localhost:*", "http://127.0.0.1:*", "https://unpkg.com", "https://cdn.jsdelivr.net"],
            "font-src":         ["'self'", "https://fonts.gstatic.com", "data:"],
            "frame-src":        ["'self'", "https://kylrxai.firebaseapp.com", "https://*.firebaseapp.com", "https://accounts.google.com", "https://apis.google.com"],
            "object-src":       ["'none'"],
            "upgrade-insecure-requests": null,
        },
    },
}));

// 3. Rate Limiting (100 requests per 15 mins for external clients, relaxed for localhost / tests)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: process.env.NODE_ENV === 'test' ? 10000 : 2000,
    skip: (req) => {
        if (process.env.NODE_ENV === 'test') return true;
        if (process.env.NODE_ENV === 'production') return false;
        return req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
    },
    message: { success: false, error: "Too many requests from this IP, please try again in 15 minutes." }
});
app.use('/api', limiter);

// 4. Body Parser
app.use(express.json({ limit: '10mb' })); // Increased from 10kb to 10mb to support bulk triggering cohorts
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// 5. Prevent Parameter Pollution
app.use(hpp());

// 6. XSS Sanitization with maintained 'xss' package
function sanitizeValue(value) {
    if (typeof value === 'string') {
        return xss(value);
    }
    if (Array.isArray(value)) {
        return value.map(sanitizeValue);
    }
    if (value !== null && typeof value === 'object') {
        const sanitized = {};
        for (const key of Object.keys(value)) {
            sanitized[key] = sanitizeValue(value[key]);
        }
        return sanitized;
    }
    return value;
}

app.use((req, res, next) => {
    // Passwords are never rendered, and escaping them would make the stored password differ from what the user typed
    const rawPassword = req.path === '/api/auth/register-organization' && req.body ? req.body.password : undefined;
    if (req.body) req.body = sanitizeValue(req.body);
    if (rawPassword !== undefined) req.body.password = rawPassword;
    if (req.query) req.query = sanitizeValue(req.query);
    if (req.params) req.params = sanitizeValue(req.params);
    next();
});

// Request Logging
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));

// Tenant isolation: every API request only sees its own organization's Firestore data
app.use('/api', require('./middleware/tenantContext'));

// Professional Root Status
app.get("/", (req, res) => {
    // Browsers get the landing page; API clients still get the JSON status
    if (req.accepts(['json', 'html']) === 'html') {
        return res.sendFile(path.join(__dirname, 'index.html'));
    }
    res.json({
        status: "success",
        service: "HRFlow Backend API",
        version: "3.0.0 (Enterprise)",
        message: "All services are securely operational",
        timestamp: new Date().toISOString()
    });
});

// Firebase Backend Health & Status
app.get("/api/firebase/status", verifyToken, async (req, res) => {
    try {
        const { db } = require('./config/firebase');
        const collections = ['users', 'employees', 'attendance', 'activities', 'system_intelligence'];
        const collectionCounts = {};
        for (const coll of collections) {
            try {
                const snap = await db.collection(coll).limit(20).get();
                collectionCounts[coll] = snap.size;
            } catch (e) {
                collectionCounts[coll] = 0;
            }
        }
        res.json({
            success: true,
            status: "connected",
            service: "Firebase Admin SDK",
            projectId: "kylrxai",
            storageBucket: "kylrxai.firebasestorage.app",
            clientEmail: "firebase-adminsdk-fbsvc@kylrxai.iam.gserviceaccount.com",
            collections: collectionCounts,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Serve static files from workspace root
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/api/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString() }));
// Whether Firestore currently accepts writes; the browser checks this before direct writes
app.get('/api/firestore/write-status', async (req, res) => {
    const status = await require('./config/firestore-write').writeStatus();
    res.json({ success: true, ...status });
});

// Resets this site in the visitor's browser: localStorage, IndexedDB (Firebase login session and
// Firestore's queue of unconfirmed writes), cookies and cache. Used to drop writes that were
// queued while the Firestore quota was exhausted.
app.get('/reset-browser-data', (req, res) => {
    res.set('Clear-Site-Data', '"cache", "cookies", "storage"');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Browser data cleared</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 16px;color:#0f172a">
<h2>Kylrx browser data cleared</h2>
<p>Saved logins, cached data and any queued (unconfirmed) Firebase saves for this site were removed from this browser.</p>
<p><a href="/login.html" style="color:#2563eb;font-weight:600">Go to login</a></p>
</body></html>`);
});
app.use(express.static(__dirname));

// Route Wiring
app.use("/api/auth", authRoutes);
app.use("/api/data", dataRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin", adminRoutes);

app.use("/api/messages", messageRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/payroll-runs", payrollRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/automations", automationRoutes);
app.use("/api/assignments", assignmentRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/central-dashboard", centralDashboardRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/notification-center", notificationCenterRoutes);
app.use("/api/document-templates", documentTemplatesRoutes);
app.use("/api/workflow-builder", workflowBuilderRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api/hr-os", hrOsRoutes);
app.use("/api/policies", policiesRoutes);
app.use("/api/assets", assetsRoutes);
app.use("/api/exits", exitsRoutes);
app.use("/api/org", require("./routes/org"));
app.use("/api/us", require("./routes/us-hr"));
app.use("/api/us", require("./routes/us-forms"));
app.use("/api/us", require("./routes/us-people"));
app.use("/api/time", require("./routes/time"));
app.use("/api/time", require("./routes/time-approval"));
app.use("/api/us", require("./routes/us-leave"));
app.use("/api/us", require("./routes/us-checklists"));
app.use("/api/us", require("./routes/us-offboarding"));
app.use("/api/us", require("./routes/us-reports"));
app.use("/api/us", require("./routes/us-vault"));
app.use("/api/us", require("./routes/us-compliance"));
app.use("/api/us", require("./routes/us-billing"));
app.use("/api/us", require("./routes/us-privacy"));
app.use("/api/us", require("./routes/us-audit"));
app.use("/api/us", require("./routes/us-retention"));
app.use("/api", require("./routes/ops")); // health/deep, metrics, status, billing webhook, platform operator
app.use("/api/us", require("./routes/us-benefits"));
app.use("/api/us", require("./routes/us-leave-cases"));
app.use("/api/us", require("./routes/us-wages"));
app.use("/api/us", require("./routes/us-tips"));
app.use("/api/us", require("./routes/us-people-data"));
app.use("/api/us", require("./routes/us-hiring"));
app.use("/api/us", require("./routes/us-esign"));
// PUBLIC (no login): careers page and e-signature page APIs, rate limited inside the router
app.use("/api/public", require("./routes/public-recruiting"));
app.use("/api/us", require("./routes/us-clock-policy"));
app.use("/api/us", require("./routes/us-schedule"));
app.use("/api/sso", require("./routes/sso"));
app.use("/api/support", require("./routes/support-access"));
app.use("/api/us/integrations", require("./routes/us-integrations")); // API keys, OAuth apps, webhooks, SCIM tokens, connectors
app.use("/api/us/gusto", require("./routes/us-gusto")); // payroll through Gusto: connect, company setup, people sync, payroll runs
app.use("/api/webhooks/gusto", require("./routes/us-gusto").webhookReceiver); // public: checked by Gusto's signature
app.use("/api/v1", require("./routes/api-v1")); // public REST API (API key or OAuth token; no catch-all, so /api/v1/esic etc. still resolve)
app.use("/oauth", require("./routes/oauth")); // OAuth 2.0 token and revocation
app.use("/scim/v2", require("./routes/scim")); // SCIM 2.0 provisioning (Okta, Entra ID, Google Workspace)
app.use("/api/manager-goals", managerGoalsRoutes);
app.use("/api/employee-goals", employeeGoalsRoutes);
app.use("/api/custom-templates", customTemplatesRoutes);
app.use("/api/bulk-trigger", bulkTriggerRoutes);
app.use("/api/payroll-settings", payrollSettingsRoutes);
app.use("/api/controls-acceptance", controlsAcceptanceRoutes);

// ─────────────────────────────────────────────
// Dynamic ESM Route Registration (Reconciliation, ESIC, Gratuity, NPS, Compliance, PF)
// ─────────────────────────────────────────────
async function registerDynamicRoutes(targetApp = app) {
  try {
    const { default: reconciliationRoutes } = await import('./routes/reconciliation.mjs');
    targetApp.use('/api/reconciliation', reconciliationRoutes);
    logger.info('[ReconciliationEngine] Routes registered at /api/reconciliation');
  } catch (err) {
    logger.error('[ReconciliationEngine] Failed to load reconciliation routes:', err.message);
  }

  try {
    const { default: esicRoutes } = await import('./routes/esic.mjs');
    targetApp.use('/api/v1/esic', esicRoutes);
    targetApp.use('/api/esic', esicRoutes);
    logger.info('[EsicAutomationEngine] Routes registered at /api/v1/esic and /api/esic');
  } catch (err) {
    logger.error('[EsicAutomationEngine] Failed to load ESIC routes:', err.message);
  }

  try {
    const { default: gratuityRoutes } = await import('./routes/gratuity.mjs');
    targetApp.use('/api/v1/gratuity', gratuityRoutes);
    targetApp.use('/api/gratuity', gratuityRoutes);
    logger.info('[GratuityAutomationEngine] Routes registered at /api/v1/gratuity and /api/gratuity');
  } catch (err) {
    logger.error('[GratuityAutomationEngine] Failed to load Gratuity routes:', err.message);
  }

  try {
    const { default: npsRoutes } = await import('./routes/nps.mjs');
    targetApp.use('/api/v1/nps', npsRoutes);
    targetApp.use('/api/nps', npsRoutes);
    logger.info('[CorporateNpsAutomationEngine] Routes registered at /api/v1/nps and /api/nps');
  } catch (err) {
    logger.error('[CorporateNpsAutomationEngine] Failed to load NPS routes:', err.message);
  }

  try {
    const { default: unifiedComplianceRoutes } = await import('./routes/unified-compliance.mjs');
    targetApp.use('/api/v1/compliance', unifiedComplianceRoutes);
    targetApp.use('/api/compliance', unifiedComplianceRoutes);
    logger.info('[UnifiedStatutoryOrchestrator] Routes registered at /api/v1/compliance and /api/compliance');
  } catch (err) {
    logger.error('[UnifiedStatutoryOrchestrator] Failed to load Compliance routes:', err.message);
  }

  try {
    const { default: pfComplianceRoutes } = await import('./routes/pf-compliance.mjs');
    targetApp.use('/api/v1/pf', pfComplianceRoutes);
    targetApp.use('/api/pf', pfComplianceRoutes);
    logger.info('[PfEcrAutomationEngine] Routes registered at /api/v1/pf and /api/pf');
  } catch (err) {
    logger.error('[PfEcrAutomationEngine] Failed to load PF routes:', err.message);
  }

  // Unhandled Route Fallback (ONLY registered AFTER all routes are registered!)
  targetApp.use((req, res, next) => {
    res.status(404);
    const err = new Error(`Can't find ${req.originalUrl} on this server!`);
    err.statusCode = 404;
    err.status = 404;
    next(err);
  });

  // Global Error Handler
  targetApp.use(errorHandler);
}

const dynamicRoutesLoaded = registerDynamicRoutes(app);

async function startServer() {
  await dynamicRoutesLoaded;

  try {
    const eventBus = require('./services/event-bus');
    const { globalEsicAutomationEngine } = await import('./services/esic-automation-engine.mjs');
    globalEsicAutomationEngine.attachPayrollFinalizedListener(eventBus);
    logger.info('[EsicAutomationEngine] Attached PAYROLL_FINALIZED listener on EventBus');
  } catch (e) {
    logger.warn('[EsicAutomationEngine] Could not wire EventBus listener:', e.message);
  }

  try {
    const eventBus = require('./services/event-bus');
    const { globalGratuityAutomationEngine } = await import('./services/gratuity-automation-engine.mjs');
    globalGratuityAutomationEngine.attachEventListeners(eventBus);
    logger.info('[GratuityAutomationEngine] Attached Exit & PAYROLL_FINALIZED listeners on EventBus');
  } catch (e) {
    logger.warn('[GratuityAutomationEngine] Could not wire EventBus listeners:', e.message);
  }

  try {
    const eventBus = require('./services/event-bus');
    const { globalCorporateNpsAutomationEngine } = await import('./services/corporate-nps-automation-engine.mjs');
    globalCorporateNpsAutomationEngine.attachPayrollFinalizedListener(eventBus);
    logger.info('[CorporateNpsAutomationEngine] Attached PAYROLL_FINALIZED listener on EventBus');
  } catch (e) {
    logger.warn('[CorporateNpsAutomationEngine] Could not wire EventBus listener:', e.message);
  }

  try {
    const { db } = require('./config/firebase');
    const eventBus = require('./services/event-bus');
    const { globalUnifiedStatutoryOrchestrator } = await import('./services/unified-statutory-orchestration-service.mjs');
    globalUnifiedStatutoryOrchestrator.attachPayrollRunsListener(db);
    globalUnifiedStatutoryOrchestrator.attachEventBusListener(eventBus);
    logger.info('[UnifiedStatutoryOrchestrator] Master trigger attached to Firebase payroll_runs & EventBus');
  } catch (e) {
    logger.warn('[UnifiedStatutoryOrchestrator] Could not attach master trigger:', e.message);
  }

  try {
    const eventBus = require('./services/event-bus');
    const { globalPfEcrAutomationEngine } = await import('./services/pf-ecr-automation-engine.mjs');
    globalPfEcrAutomationEngine.attachEventBusListener(eventBus);
    logger.info('[PfEcrAutomationEngine] EventBus listener wired to PAYROLL_FINALIZED');
  } catch (e) {
    logger.warn('[PfEcrAutomationEngine] Could not wire EventBus listener:', e.message);
  }

  // Start Server
  app.listen(PORT, () => {
    logger.info(`🚀 Secure HRFlow Enterprise Backend running on http://localhost:${PORT}`);
    console.log(`🚀 Secure HRFlow Enterprise Backend running on http://localhost:${PORT}`);
    
    // Register HR Module Adapters into Central Automation Engine
    const moduleRegistry = require('./services/automation-module-registry');
    try {
      moduleRegistry.registerModule(require('./modules/onboarding-module-adapter'));
      moduleRegistry.registerModule(require('./modules/leave-attendance-module-adapter'));
      moduleRegistry.registerModule(require('./modules/exit-module-adapter'));
      moduleRegistry.registerModule(require('./modules/payroll-module-adapter'));
      moduleRegistry.registerModule(require('./modules/statutory-module-adapter'));
      moduleRegistry.registerModule(require('./modules/policy-module-adapter'));
      logger.info('[UnifiedAutomationEngine] Successfully registered 6 HR module adapters into central engine.');
    } catch (regErr) {
      logger.error('[UnifiedAutomationEngine] Failed to register some module adapters:', regErr);
    }
    
    // Initialize the centralized automation engine
    automationEngine.start();

    // Outbound webhooks (event outbox -> signed deliveries with retries) and scheduled connector syncs
    try {
      require('./services/webhooks').start();
      require('./services/connectors/runtime').startScheduler();
      if (require('./routes/us-gusto').startJobs()) logger.info('[Gusto] Event poll job started');
      logger.info('[Integrations] Webhook delivery worker and connector scheduler started');
    } catch (intErr) {
      logger.error(`[Integrations] Could not start background workers: ${intErr.message}`);
    }

    // Onboarding Document submission Reminder scheduler (Twice daily: every 12 hours)
    const { runReminderJob } = require("./utils/reminder-scheduler");
    setInterval(() => {
      runReminderJob().catch(err => console.error("Error in scheduled reminder job:", err));
    }, 12 * 60 * 60 * 1000);
  });
}

// Handle Uncaught Exceptions and Unhandled Rejections globally to guarantee ZERO-CRASH
process.on('uncaughtException', (err) => {
    logger.error(`UNCAUGHT EXCEPTION: ${err ? (err.name || 'Error') : 'Unknown'} - ${err ? (err.message || err) : 'No message'}`, { stack: err ? err.stack : undefined });
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    logger.error(`UNHANDLED REJECTION: ${err.name} - ${err.message}`, { stack: err.stack });
});

if (require.main === module) {
    startServer();
}

module.exports = { app, startServer, registerDynamicRoutes, dynamicRoutesLoaded };


