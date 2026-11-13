/**
 * Checks this server's settings before a production start.
 *   npm run check:production
 * Reads the environment (and .env if there is one). Prints the names of settings only, never their values.
 * Exits with code 1 when something must be fixed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
try { require('dotenv').config({ quiet: true }); } catch (_) { /* dotenv is optional here */ }
const { checkProductionEnv } = require('../services/production-check');

function canWrite(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.write-test-${process.pid}`);
        fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
        return true;
    } catch (_) { return false; }
}

const result = checkProductionEnv(process.env, { appDir: path.resolve(__dirname, '..'), canWrite });
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) result.problems.push(`Node ${process.versions.node} is too old. Use Node 20 or newer (tested on 24).`);

console.log(`Production settings check on ${os.hostname()} (Node ${process.versions.node})`);
console.log(result.problems.length ? `\nMust fix (${result.problems.length}):` : '\nNothing that must be fixed.');
for (const p of result.problems) console.log(`  - ${p}`);
if (result.warnings.length) { console.log(`\nDecide (${result.warnings.length}):`); for (const w of result.warnings) console.log(`  - ${w}`); }
process.exit(result.problems.length ? 1 : 0);
