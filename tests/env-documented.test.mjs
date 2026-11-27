// Every setting the server reads is mentioned in .env.example, so a person setting up a server can find it.
// The search is by text (process.env.NAME) through the folders the running server is made of. It does not cover
// settings read by scripts/, tests/ or the browser pages, nor names built at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOLDERS = ['routes', 'services', 'controllers', 'middleware', 'config', 'utils'];
// Set by the operating system or the host, not by whoever sets the server up
const NOT_OURS = new Set(['HOME', 'USERPROFILE', 'DEBUG', 'GIT_SHA', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'TZ', 'PATH', 'PWD']);

function files(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') files(p, out); } else if (/\.(js|mjs)$/.test(e.name) && !/\.test\.(js|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
}

test('every setting the server reads is mentioned in .env.example', () => {
    const read = new Map();
    for (const f of [path.join(root, 'server.js'), ...FOLDERS.flatMap((d) => files(path.join(root, d)))]) {
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) if (!read.has(m[1])) read.set(m[1], path.relative(root, f));
    }
    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    const mentioned = new Set(example.match(/[A-Z][A-Z0-9_]{2,}/g) || []);
    const missing = [...read.entries()].filter(([name]) => !NOT_OURS.has(name) && !mentioned.has(name)).map(([name, file]) => `${name} (read in ${file})`);
    assert.deepEqual(missing, [], 'add these to .env.example with one line saying what they do');
    assert.ok(read.size > 40, 'the search found the settings at all');
});
