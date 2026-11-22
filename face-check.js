/*
 * On-device face check for face clock-in (punch.html).
 *
 * Matching runs in this browser. The face template is encrypted with a key that cannot be exported (kept in
 * IndexedDB) and it never leaves this phone. A punch carries only the outcome: { matched, liveness }.
 * The face library and its models load from jsDelivr at a pinned version, only when this page needs them.
 *
 * Exposes window.OnnFace: loadLib, enroll, check, hasTemplate, remove.
 */
(function () {
    'use strict';
    const VERSION = '1.7.14';
    const LIB = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${VERSION}/dist/face-api.js`;
    const MODELS = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${VERSION}/model/`;
    // Euclidean distance between two face descriptors: lower is stricter. A pair under this value counts as the same person.
    const MATCH_DISTANCE = 0.5;
    const MATCH_HITS = 3;          // frames that must match, so one lucky frame does not pass
    const EAR_CLOSED = 0.2;        // eye aspect ratio below this = eyes closed
    const EAR_OPEN = 0.27;         // above this after a close = eyes open again (a blink)
    const DB = 'onnhr-face';

    let libPromise = null;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) * (v - b[i]), 0));

    function loadLib() {
        if (window.faceapi && faceapi.nets.tinyFaceDetector.isLoaded && faceapi.nets.faceRecognitionNet.isLoaded) return Promise.resolve();
        if (libPromise) return libPromise;
        libPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = LIB; s.async = true; s.crossOrigin = 'anonymous';
            s.onload = async () => {
                try {
                    await Promise.all([
                        faceapi.nets.tinyFaceDetector.loadFromUri(MODELS),
                        faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODELS),
                        faceapi.nets.faceRecognitionNet.loadFromUri(MODELS)
                    ]);
                    resolve();
                } catch (e) { libPromise = null; reject(e); }
            };
            s.onerror = () => { libPromise = null; reject(new Error('face library did not load')); };
            document.head.appendChild(s);
        });
        return libPromise;
    }

    /* ---------- local encrypted storage ---------- */
    function openDb() {
        return new Promise((resolve, reject) => {
            const r = indexedDB.open(DB, 1);
            r.onupgradeneeded = () => { r.result.createObjectStore('keys'); r.result.createObjectStore('templates'); };
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    }
    // runs one request in a transaction and resolves with its result once the transaction has committed
    async function run(store, mode, makeRequest) {
        const d = await openDb();
        return new Promise((resolve, reject) => {
            const t = d.transaction(store, mode);
            const req = makeRequest(t.objectStore(store));
            t.oncomplete = () => { d.close(); resolve(req.result); };
            t.onerror = () => { d.close(); reject(t.error); };
            t.onabort = () => { d.close(); reject(t.error || new Error('aborted')); };
        });
    }
    async function aesKey() {
        let key = await run('keys', 'readonly', (s) => s.get('k'));
        if (!key) {
            key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            await run('keys', 'readwrite', (s) => s.put(key, 'k'));
        }
        return key;
    }
    async function saveTemplate(uid, descriptor) {
        const key = await aesKey();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Float32Array(descriptor).buffer);
        await run('templates', 'readwrite', (s) => s.put({ iv, ct, savedAt: new Date().toISOString() }, uid));
    }
    async function readTemplate(uid) {
        const rec = await run('templates', 'readonly', (s) => s.get(uid));
        if (!rec) return null;
        const key = await aesKey();
        const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct);
        return Array.from(new Float32Array(buf));
    }
    async function hasTemplate(uid) {
        return Boolean(await run('templates', 'readonly', (s) => s.count(uid)));
    }
    async function remove(uid) {
        await run('templates', 'readwrite', (s) => s.delete(uid));
    }

    /* ---------- detection ---------- */
    const detectorOpts = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
    async function detect(video) {
        return faceapi.detectSingleFace(video, detectorOpts()).withFaceLandmarks(true).withFaceDescriptor();
    }
    // eye aspect ratio from the six landmark points around one eye
    function eyeRatio(p) {
        const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
        return (d(p[1], p[5]) + d(p[2], p[4])) / (2 * d(p[0], p[3]));
    }

    /**
     * Setup: take several pictures, check they agree with each other, and save the average as this phone's template.
     * Resolves { ok: true } or { ok: false, reason: 'no_face' | 'unsteady' }.
     */
    async function enroll(uid, video, samples = 5) {
        await loadLib();
        const got = [];
        for (let i = 0; i < 40 && got.length < samples; i++) {
            const r = await detect(video);
            if (r) got.push(Array.from(r.descriptor));
            await wait(250);
        }
        if (got.length < samples) return { ok: false, reason: 'no_face' };
        const avg = got[0].map((_, j) => got.reduce((s, d) => s + d[j], 0) / got.length);
        if (Math.max(...got.map((d) => dist(d, avg))) > MATCH_DISTANCE) return { ok: false, reason: 'unsteady' };
        await saveTemplate(uid, avg);
        return { ok: true };
    }

    /**
     * Punch check: the person must blink (liveness) while the face matches the saved template.
     * Resolves { matched, liveness }, or null when this phone has no face set up.
     */
    async function check(uid, video, timeoutMs = 7000) {
        await loadLib();
        const tpl = await readTemplate(uid);
        if (!tpl) return null;
        const started = Date.now();
        let hits = 0, closed = false, blinked = false;
        while (Date.now() - started < timeoutMs) {
            const r = await detect(video);
            if (r) {
                if (dist(Array.from(r.descriptor), tpl) < MATCH_DISTANCE) hits += 1;
                const pts = r.landmarks.positions;
                const e = (eyeRatio(pts.slice(36, 42)) + eyeRatio(pts.slice(42, 48))) / 2;
                if (e < EAR_CLOSED) closed = true;
                else if (closed && e > EAR_OPEN) blinked = true;
            }
            if (blinked && hits >= MATCH_HITS) break;
            await wait(120);
        }
        return { matched: hits >= MATCH_HITS, liveness: blinked };
    }

    window.OnnFace = { loadLib, enroll, check, hasTemplate, remove, MATCH_DISTANCE };
})();
