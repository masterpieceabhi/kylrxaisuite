/**
 * Which files do the pages load from the app folder?
 *
 * Starts from every HTML page in the app's folder and follows what each page and script loads
 * (src, href, import, fetch, url()). Used by tests/static-guard.test.mjs to make sure the static-file
 * guard never blocks a file a page needs, and by hand to see what the guard should cover:
 *
 *   node scripts/static-audit.js            a summary by folder
 *   node scripts/static-audit.js --urls     every file the pages load, one per line
 */
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['node_modules', '.git', 'logs']);

function pagesAndAssets(root) {
    const top = fs.readdirSync(root, { withFileTypes: true });
    const isFile = (rel) => { try { return fs.statSync(path.join(root, rel)).isFile(); } catch (_) { return false; } };
    const norm = (from, ref) => {
        let r = ref.split('#')[0].split('?')[0].trim();
        if (!r || /^(https?:|data:|mailto:|tel:|javascript:|blob:|\/\/)/i.test(r)) return null;
        if (/[{}$<>`\s]/.test(r)) return null;
        r = r.startsWith('/') ? r.slice(1) : path.posix.join(path.posix.dirname(from), r);
        r = path.posix.normalize(r);
        return r.startsWith('..') ? null : r;
    };
    const patterns = [/(?:src|href|action|data-src|poster)\s*=\s*["']([^"']+)["']/gi, /(?:from|import)\s*\(?\s*["']([^"']+)["']/g, /(?:fetch|importScripts|Worker|open)\(\s*["'`]([^"'`]+)["'`]/g, /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
        /["'`]((?:\.{0,2}\/)?[A-Za-z0-9_\-./]+\.(?:html|js|css|json|png|jpe?g|gif|svg|webp|ico|mp3|wav|woff2?|ttf|xlsx|csv|pdf))["'`]/g];
    const refsIn = (rel) => {
        const text = fs.readFileSync(path.join(root, rel), 'utf8'); const out = new Set();
        for (const re of patterns) { re.lastIndex = 0; let m; while ((m = re.exec(text))) { const n = norm(rel, m[1]); if (n) out.add(n); } }
        return out;
    };
    const pages = top.filter((d) => d.isFile() && d.name.endsWith('.html')).map((d) => d.name);
    const used = new Set(pages); const queue = [...pages];
    while (queue.length) {
        const rel = queue.shift();
        if (!/\.(html|js|css)$/i.test(rel)) continue;
        let refs; try { refs = refsIn(rel); } catch (_) { continue; }
        for (const r of refs) if (isFile(r) && !used.has(r) && !SKIP.has(r.split('/')[0])) { used.add(r); queue.push(r); }
    }
    return { pages, used: [...used].sort(), folders: top.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name), rootFiles: top.filter((d) => d.isFile() && !d.name.startsWith('.')).map((d) => d.name) };
}

module.exports = { pagesAndAssets };

if (require.main === module) {
    const root = path.resolve(__dirname, '..');
    const { pages, used, folders, rootFiles } = pagesAndAssets(root);
    if (process.argv.includes('--urls')) { console.log(used.join('\n')); process.exit(0); }
    const { isBlocked } = require('../middleware/static-guard');
    const byTop = {};
    for (const u of used) { const t = u.includes('/') ? `${u.split('/')[0]}/` : '(app folder)'; (byTop[t] = byTop[t] || []).push(u); }
    console.log(`${pages.length} pages load ${used.length} files`);
    for (const [t, list] of Object.entries(byTop).sort()) console.log(`  ${t.padEnd(14)} ${list.length}`);
    console.log(`folders no page loads from: ${folders.filter((d) => !byTop[`${d}/`]).join(', ')}`);
    const wronglyBlocked = used.filter((u) => isBlocked(`/${u}`));
    console.log(wronglyBlocked.length ? `BLOCKED BUT NEEDED BY A PAGE:\n  ${wronglyBlocked.join('\n  ')}` : 'the guard blocks nothing a page loads');
    const open = rootFiles.filter((f) => !used.includes(f) && !isBlocked(`/${f}`));
    console.log(`files in the app folder that no page loads and the guard still serves: ${open.length}${open.length ? `\n  ${open.join(', ')}` : ''}`);
}
