/**
 * A small QR code maker with no outside service and no library (browser and Node).
 *
 * Used to show a join link or a set-up link as a QR code a phone camera can read. Nothing leaves the page.
 * Limits, on purpose: text is stored as UTF-8 bytes, error correction level M, sizes ("versions") 1 to 10,
 * which is up to 213 bytes. A link of this app is about 80 to 110 bytes. Longer text returns null and the
 * page shows the link alone.
 *
 *   QrMini.matrix(text)        -> array of rows of true (dark) / false, or null when the text is too long
 *   QrMini.svg(text, options)  -> an <svg> string (options: size in px, margin in modules), or null
 */
(function (root) {
    'use strict';

    // Per version 1..10 at level M: error-correction bytes per block, number of blocks
    var ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
    var BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
    var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
    var MAX_VERSION = 10;

    function rawModules(ver) {
        var n = (16 * ver + 128) * ver + 64;
        if (ver >= 2) { var a = Math.floor(ver / 7) + 2; n -= (25 * a - 10) * a - 55; if (ver >= 7) n -= 36; }
        return n;
    }
    function dataCodewords(ver) { return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver]; }

    function utf8(text) {
        var out = []; var s = unescape(encodeURIComponent(String(text)));
        for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
        return out;
    }

    // Reed-Solomon over GF(256) with the QR polynomial 0x11D
    function mul(x, y) { var z = 0; for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; }
    function divisor(degree) {
        var r = []; var i; for (i = 0; i < degree - 1; i++) r.push(0); r.push(1);
        var rootv = 1;
        for (i = 0; i < degree; i++) {
            for (var j = 0; j < r.length; j++) { r[j] = mul(r[j], rootv); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
            rootv = mul(rootv, 2);
        }
        return r;
    }
    function remainder(data, div) {
        var r = div.map(function () { return 0; });
        data.forEach(function (b) { var f = b ^ r.shift(); r.push(0); div.forEach(function (c, i) { r[i] ^= mul(c, f); }); });
        return r;
    }

    function codewords(bytes, ver) {
        var cap = dataCodewords(ver); var bits = [];
        var push = function (val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
        push(4, 4); push(bytes.length, ver <= 9 ? 8 : 16);
        bytes.forEach(function (b) { push(b, 8); });
        push(0, Math.min(4, cap * 8 - bits.length));
        while (bits.length % 8) bits.push(0);
        var data = [];
        for (var i = 0; i < bits.length; i += 8) { var v = 0; for (var k = 0; k < 8; k++) v = (v << 1) | bits[i + k]; data.push(v); }
        for (var pad = 0xEC; data.length < cap; pad ^= 0xEC ^ 0x11) data.push(pad);

        // split into blocks, add error correction, interleave
        var numBlocks = BLOCKS[ver]; var eccLen = ECC_PER_BLOCK[ver]; var rawCw = Math.floor(rawModules(ver) / 8);
        var numShort = numBlocks - rawCw % numBlocks; var shortLen = Math.floor(rawCw / numBlocks);
        var blocks = []; var div = divisor(eccLen); var at = 0;
        for (var b = 0; b < numBlocks; b++) {
            var dat = data.slice(at, at + shortLen - eccLen + (b < numShort ? 0 : 1)); at += dat.length;
            var ecc = remainder(dat, div);
            if (b < numShort) dat.push(0);
            blocks.push(dat.concat(ecc));
        }
        var out = [];
        for (var c = 0; c < blocks[0].length; c++) {
            for (var j = 0; j < blocks.length; j++) { if (c !== shortLen - eccLen || j >= numShort) out.push(blocks[j][c]); }
        }
        return out;
    }

    function build(ver, cw) {
        var size = ver * 4 + 17; var m = []; var fn = []; var x; var y; var i;
        for (y = 0; y < size; y++) { m.push([]); fn.push([]); for (x = 0; x < size; x++) { m[y].push(false); fn[y].push(false); } }
        var set = function (px, py, dark) { m[py][px] = dark; fn[py][px] = true; };

        for (i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
        var finder = function (cx, cy) {
            for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
                var d = Math.max(Math.abs(dx), Math.abs(dy)); var xx = cx + dx; var yy = cy + dy;
                if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, d !== 2 && d !== 4);
            }
        };
        finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
        var pos = ALIGN[ver]; var n = pos.length;
        for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) {
            if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
            for (var ady = -2; ady <= 2; ady++) for (var adx = -2; adx <= 2; adx++) set(pos[a] + adx, pos[b] + ady, Math.max(Math.abs(adx), Math.abs(ady)) !== 1);
        }
        var bit = function (v, k) { return ((v >>> k) & 1) !== 0; };
        var format = function (mask) {
            var data = (0 << 3) | mask; // level M is 00
            var rem = data; for (var k = 0; k < 10; k++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
            var bits = ((data << 10) | rem) ^ 0x5412;
            for (k = 0; k <= 5; k++) set(8, k, bit(bits, k));
            set(8, 7, bit(bits, 6)); set(8, 8, bit(bits, 7)); set(7, 8, bit(bits, 8));
            for (k = 9; k < 15; k++) set(14 - k, 8, bit(bits, k));
            for (k = 0; k < 8; k++) set(size - 1 - k, 8, bit(bits, k));
            for (k = 8; k < 15; k++) set(8, size - 15 + k, bit(bits, k));
            set(8, size - 8, true);
        };
        format(0);
        if (ver >= 7) {
            var rem = ver; for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
            var vbits = (ver << 12) | rem;
            for (i = 0; i < 18; i++) { var p = size - 11 + (i % 3); var q = Math.floor(i / 3); set(p, q, bit(vbits, i)); set(q, p, bit(vbits, i)); }
        }

        // data, in the zigzag from the bottom right
        var k2 = 0;
        for (var right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (var vert = 0; vert < size; vert++) {
                for (var j = 0; j < 2; j++) {
                    x = right - j; var up = ((right + 1) & 2) === 0; y = up ? size - 1 - vert : vert;
                    if (!fn[y][x] && k2 < cw.length * 8) { m[y][x] = bit(cw[k2 >>> 3], 7 - (k2 & 7)); k2++; }
                }
            }
        }

        var MASKS = [
            function (px, py) { return (px + py) % 2 === 0; }, function (px, py) { return py % 2 === 0; }, function (px) { return px % 3 === 0; },
            function (px, py) { return (px + py) % 3 === 0; }, function (px, py) { return (Math.floor(px / 3) + Math.floor(py / 2)) % 2 === 0; },
            function (px, py) { return (px * py) % 2 + (px * py) % 3 === 0; }, function (px, py) { return ((px * py) % 2 + (px * py) % 3) % 2 === 0; },
            function (px, py) { return ((px + py) % 2 + (px * py) % 3) % 2 === 0; }
        ];
        var apply = function (mask) { for (var yy = 0; yy < size; yy++) for (var xx = 0; xx < size; xx++) if (!fn[yy][xx] && MASKS[mask](xx, yy)) m[yy][xx] = !m[yy][xx]; };
        // how hard the pattern is to read: long runs, 2x2 blocks, and too much of one color (the usual scoring)
        var penalty = function () {
            var score = 0; var dark = 0; var xx; var yy;
            for (yy = 0; yy < size; yy++) {
                var runX = 1; var runY = 1;
                for (xx = 0; xx < size; xx++) {
                    if (m[yy][xx]) dark++;
                    if (xx > 0) {
                        if (m[yy][xx] === m[yy][xx - 1]) { runX++; if (runX === 5) score += 3; else if (runX > 5) score++; } else runX = 1;
                        if (m[xx][yy] === m[xx - 1][yy]) { runY++; if (runY === 5) score += 3; else if (runY > 5) score++; } else runY = 1;
                        if (yy > 0 && m[yy][xx] === m[yy][xx - 1] && m[yy][xx] === m[yy - 1][xx] && m[yy][xx] === m[yy - 1][xx - 1]) score += 3;
                    }
                }
            }
            // rows and columns that look like the corner squares (dark-light-dark dark dark-light-dark next to 4 light) confuse readers
            for (yy = 0; yy < size; yy++) {
                var row = ''; var colm = '';
                for (xx = 0; xx < size; xx++) { row += m[yy][xx] ? '1' : '0'; colm += m[xx][yy] ? '1' : '0'; }
                [row, colm].forEach(function (line) {
                    for (var at = line.indexOf('10111010000'); at !== -1; at = line.indexOf('10111010000', at + 1)) score += 40;
                    for (at = line.indexOf('00001011101'); at !== -1; at = line.indexOf('00001011101', at + 1)) score += 40;
                });
            }
            score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
            return score;
        };
        var best = 0; var bestScore = Infinity;
        for (var mk = 0; mk < 8; mk++) { apply(mk); format(mk); var s = penalty(); if (s < bestScore) { bestScore = s; best = mk; } apply(mk); }
        apply(best); format(best);
        return m;
    }

    function matrix(text) {
        var bytes = utf8(text);
        for (var ver = 1; ver <= MAX_VERSION; ver++) {
            if (bytes.length <= dataCodewords(ver) - (ver <= 9 ? 2 : 3)) return build(ver, codewords(bytes, ver));
        }
        return null;
    }

    function svg(text, options) {
        var m = matrix(text); if (!m) return null;
        var o = options || {}; var margin = o.margin === undefined ? 4 : o.margin; var px = o.size || 240; var n = m.length + margin * 2; var d = '';
        for (var y = 0; y < m.length; y++) for (var x = 0; x < m.length; x++) if (m[y][x]) d += 'M' + (x + margin) + ' ' + (y + margin) + 'h1v1h-1z';
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" width="' + px + '" height="' + px + '" shape-rendering="crispEdges" role="img" aria-label="QR code">'
            + '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
    }

    var api = { matrix: matrix, svg: svg, MAX_BYTES: dataCodewords(MAX_VERSION) - 3 };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.QrMini = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
