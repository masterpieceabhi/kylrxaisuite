/**
 * Keeps server-side files from being handed out as static files.
 *
 * The pages live in the same folder as the server code, and the whole folder is served by express.static.
 * Without this guard anyone could download the server's source, the Firestore rules, scripts, stored data
 * files and the log files. This runs just before express.static and answers 404 for anything a browser
 * has no reason to load. API routes are not affected.
 *
 * Adding a page that loads a new file from services/ or utils/? Add it to ALLOWED below.
 * tests/static-guard.test.mjs fails with the file's name if you forget.
 */
const path = require('path');

/** Folders no page loads anything from (checked by scripts/static-audit.js) */
const DENIED_FOLDERS = new Set(['config', 'controllers', 'data', 'docs', 'functions', 'logs', 'middleware', 'migrations', 'modules', 'node_modules', 'root_configs', 'routes', 'scripts', 'tests', 'types']);

/** Folders that hold mostly server code, where only these browser files may be served */
const ALLOWED = {
    services: new Set(['atomic-counter-service.js', 'attendance-policy-parser.js', 'cost-center-parser.js', 'employee-finance-parser.js', 'employee-finance-service.js', 'employee-type-parser.js', 'employee-type-service.js',
        'rbac-ui-controller.js', 'salary-structure-parser.js', 'salary-structure-service.js', 'shift-parser.js', 'statutory-compliance-ui-controller.js', 'sub-department-parser.js', 'template-parser-service.js']),
    utils: new Set(['sortable.min.js', 'xlsx.full.min.js'])
};

/** Files in the app's own folder that are server code, settings, scripts or working files */
const DENIED_ROOT_FILES = new Set(['server.js', 'package.json', 'package-lock.json', 'firebase.json', 'firestore.indexes.json', 'tsconfig.json', 'ids.json', 'requirements.txt', 'runtime.txt',
    'scan_db.js', 'send_live_test.js', 'sync_firebase_backend.js', 'compare_hrms_sidebars.js', 'inject_hrms_scrollbar.js']);
const DENIED_ROOT_PATTERNS = [/^check_.*\.js$/, /^test[._-].*$/, /^trigger.*\.js$/, /^seed_.*\.js$/];

/** File types a browser never needs from this app, wherever they are */
const DENIED_EXTENSIONS = new Set(['.log', '.rules', '.py', '.md', '.doc', '.docx', '.bak', '.env', '.pem', '.key', '.p12', '.sh', '.bat', '.ps1', '.sql', '.jsonl', '.mjs', '.ts', '.map', '.lock', '.yml', '.yaml']);

/** Should this URL path be refused? */
function isBlocked(urlPath) {
    let p;
    try { p = decodeURIComponent(String(urlPath || '')); } catch (_) { return true; } // malformed escapes
    if (p.includes('\0')) return true;
    // Windows treats \ as a separator and file names without regard to case, so compare the way the disk does
    p = path.posix.normalize(`/${p.replace(/\\/g, '/')}`).toLowerCase();
    const parts = p.split('/').filter(Boolean);
    if (!parts.length) return false;
    if (parts[0] === 'api') return false;
    if (parts.some((s) => s.startsWith('.') || s === '..')) return true; // .env, .git, .claude and friends
    // trailing dots and spaces are ignored by Windows ("server.js." opens server.js)
    const clean = parts.map((s) => s.replace(/[. ]+$/, ''));
    const name = clean[clean.length - 1];
    if (DENIED_EXTENSIONS.has(path.posix.extname(name))) return true;
    if (clean.length === 1) return DENIED_ROOT_FILES.has(name) || DENIED_ROOT_PATTERNS.some((re) => re.test(name));
    if (DENIED_FOLDERS.has(clean[0])) return true;
    if (ALLOWED[clean[0]]) return !(clean.length === 2 && ALLOWED[clean[0]].has(name));
    return false;
}

function staticGuard(req, res, next) {
    if ((req.method === 'GET' || req.method === 'HEAD') && isBlocked(req.path)) return res.status(404).type('text/plain').send('Not found');
    return next();
}

module.exports = staticGuard;
module.exports.isBlocked = isBlocked;
module.exports.DENIED_FOLDERS = DENIED_FOLDERS;
module.exports.ALLOWED = ALLOWED;
