import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Q = require('../qr-mini.js');
const guard = require('../middleware/static-guard.js');

const pack = (m) => m.map((r) => BigInt(`0b${r.map((c) => (c ? 1 : 0)).join('')}`).toString(36)).join('.');

// These three patterns were read back correctly by an independent QR reader (OpenCV's) when this file was written.
// If the maker changes its output for them, read the new output with a real reader before updating these lines.
const KNOWN = [
    ['HELLO', '18qrj.mwch.wqql.wrbx.wr4t.my4h.18prz.64g.okqh.51kf.vdki.142xc.84p2.5vv.18qkq.muci.wrcl.woaz.wqk8.mvgg.18p2t'],
    ['https://app.example.com/join.html#c=q3Zx_8Jk-2LmN0pQrStUvWxYz1A2b3C4d5E6f7G8h9I', '1qufvnnj.w7f3oe9.1a1zpxel.19wn5d99.1a0itz6l.w4cgvnl.1qt5f2wv.1sjk00.13dwr6on.1ebki9kq.ienqgup.3v0x1j.1cbzjv4x.15km8fq0.u7zbhb1.1kafdxim.1jxiph7q.lwps7j8.1qz7inll.tn74z21.z75muws.97px8k4.1n5190ix.mt93cu6.qj7d6pu.19m9l7gc.1ixxgnen.16kojjam.18438hz0.76l2c7.1qv70rbl.w8c6r69.1a10nldc.1a1o06dl.19yau8pd.w5ti9r3.1qstsai5'],
    ['x'.repeat(130), '5ia3bvtz0f.2tcchxtoox.41ko8xzty5.41h5jwdv19.41ny0rlen1.2tw74e23i9.5iicojrr7j.gdhommf4.449ff1a7i4.4ytkiezhe6.2qy3iyknmj.49h8vk810x.4xjn8zvf50.2spwj267da.3iev1autgb.388xyiedrl.u2cuqfmg4.2sl9qqrff2.3j57ftnwrf.2silciv0oh.21hxuw9vtw.5aonq9prke.1die6saigr.4caxifbrip.8gfgexavo.4cer72sbvi.2rkblfrpq3.46rjdp5hn5.1voyvx8d9w.2v0b7psdwu.449btg10p7.1xc2nei8i8.1yauev64ad.42yivwqoha.5ifgifljnv.23s868stqp.3sycvffnzo.1xpi9uqtm6.1juwdjrfez.2gno1tysgh.4x8vz63lys.fbtgpbmm.5ib3oj4a57.2tw0na2n0x.41p4do5at0.41kvtnct31.41k1k75nc8.2tovvi4m2p.5ieqo2h4lz']
];

test('known patterns (checked with an independent reader) are still produced', () => {
    for (const [text, packed] of KNOWN) assert.equal(pack(Q.matrix(text)), packed, text.slice(0, 30));
});

test('size grows with the text; too long returns null instead of a wrong code', () => {
    const size = (n) => { const m = Q.matrix('x'.repeat(n)); return m ? m.length : null; };
    // byte capacity at level M for versions 1 to 10
    const caps = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    caps.forEach((cap, i) => { assert.equal(size(cap), 21 + 4 * i, `fits ${cap}`); if (i < 9) assert.equal(size(cap + 1), 25 + 4 * i, `needs the next size at ${cap + 1}`); });
    assert.equal(Q.MAX_BYTES, 213); assert.equal(size(214), null); assert.equal(Q.svg('x'.repeat(500)), null);
    assert.equal(Q.matrix('ñ'.repeat(8)).length, 25); // 16 bytes in UTF-8, not 8
});

test('every code is square and has the three corner squares, the timing lines and the fixed dark dot', () => {
    for (const text of ['', 'a', 'https://app.example.com/join.html#s=abc', 'x'.repeat(200)]) {
        const m = Q.matrix(text); const n = m.length;
        assert.ok(m.every((r) => r.length === n && r.every((c) => typeof c === 'boolean')));
        const finder = (x0, y0) => { for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) { const d = Math.max(Math.abs(x - 3), Math.abs(y - 3)); assert.equal(m[y0 + y][x0 + x], d !== 2, `finder at ${x0},${y0}`); } };
        finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
        for (let i = 8; i < n - 8; i++) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
        assert.equal(m[n - 8][8], true);
        // the two copies of the format bits agree
        const a = [0, 1, 2, 3, 4, 5, 7, 8].map((y) => m[y][8]); const b = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => m[8][n - k]);
        assert.deepEqual(a, b);
    }
});

test('the same text gives the same code; different text gives a different one', () => {
    assert.equal(pack(Q.matrix('abc')), pack(Q.matrix('abc')));
    assert.notEqual(pack(Q.matrix('abc')), pack(Q.matrix('abd')));
});

test('svg: one white square, one path, a quiet border, nothing from the text itself in the markup', () => {
    const svg = Q.svg('https://x.example/join.html#c=<script>', { size: 200 });
    assert.match(svg, /^<svg [^>]*viewBox="0 0 (\d+) \1" width="200" height="200"/);
    assert.equal(svg.includes('script'), false);
    assert.equal((svg.match(/<path /g) || []).length, 1);
    const n = Q.matrix('https://x.example/join.html#c=<script>').length;
    assert.ok(svg.includes(`viewBox="0 0 ${n + 8} ${n + 8}"`)); // 4 modules of margin on each side
});

test('the page can load the file (it is not refused by the static guard)', () => {
    assert.equal(guard.isBlocked('/qr-mini.js'), false);
    assert.equal(guard.isBlocked('/join.html'), false);
    assert.equal(guard.isBlocked('/set-password.html'), false);
    assert.equal(guard.isBlocked('/admin-us-team-import.html'), false);
    assert.equal(guard.isBlocked('/services/team-import-rules.js'), true); // server code stays on the server
    assert.equal(guard.isBlocked('/services/access-link-rules.js'), true);
});
