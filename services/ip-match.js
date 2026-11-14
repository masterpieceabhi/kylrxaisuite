/**
 * Network address matching (pure, no I/O, no packages): is this IPv4/IPv6 address inside a list of allowed
 * networks? Used by the clock-in limit by network address (services/clock-compliance-rules.js).
 *
 * A network is a single address ("203.0.113.7", "2001:db8::1") or a CIDR range ("203.0.113.0/24", "2001:db8::/32").
 * IPv4 addresses that arrive in IPv6 clothing ("::ffff:203.0.113.7") are treated as IPv4.
 */

const MAX_NETWORKS = 50;
const V4_MAPPED_PREFIX = 0xffffn << 32n; // ::ffff:0:0/96

/** "203.0.113.7" -> BigInt, or null */
function parseIpv4(text) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text || ''));
    if (!m) return null;
    let n = 0n;
    for (let i = 1; i <= 4; i++) {
        if (m[i].length > 1 && m[i][0] === '0') return null; // no leading zeros (they are read as octal by some systems)
        const part = Number(m[i]);
        if (part > 255) return null;
        n = (n << 8n) | BigInt(part);
    }
    return n;
}

/** "2001:db8::1" -> BigInt (128 bits), or null. Accepts "::", an IPv4 tail and a zone id ("fe80::1%eth0"). */
function parseIpv6(text) {
    let s = String(text || '').trim().toLowerCase();
    const zone = s.indexOf('%');
    if (zone !== -1) s = s.slice(0, zone);
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null;
    // an IPv4 tail counts as two groups
    const lastColon = s.lastIndexOf(':');
    const tail = s.slice(lastColon + 1);
    if (tail.includes('.')) {
        const v4 = parseIpv4(tail);
        if (v4 === null) return null;
        s = `${s.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const groupsOf = (part) => (part === '' ? [] : part.split(':'));
    const head = groupsOf(halves[0]);
    const rest = halves.length === 2 ? groupsOf(halves[1]) : [];
    const missing = 8 - head.length - rest.length;
    if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
    const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
    let n = 0n;
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        n = (n << 16n) | BigInt(parseInt(g, 16));
    }
    return n;
}

/** Any address -> { version: 4|6, value: BigInt }, or null. An IPv4-mapped IPv6 address comes back as version 4. */
function parseAddress(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    const v4 = parseIpv4(s);
    if (v4 !== null) return { version: 4, value: v4 };
    const v6 = parseIpv6(s);
    if (v6 === null) return null;
    if ((v6 >> 32n) === 0xffffn) return { version: 4, value: v6 & 0xffffffffn };
    return { version: 6, value: v6 };
}

const formatV4 = (n) => [24n, 16n, 8n, 0n].map((shift) => String((n >> shift) & 0xffn)).join('.');
function formatV6(n) {
    const groups = [];
    for (let i = 7; i >= 0; i--) groups.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
    // shorten the longest run of zero groups (two or more) to "::"
    let best = { at: -1, len: 0 }; let run = { at: -1, len: 0 };
    groups.forEach((g, i) => {
        if (g === '0') { run = run.at === -1 ? { at: i, len: 1 } : { at: run.at, len: run.len + 1 }; if (run.len > best.len) best = { ...run }; } else run = { at: -1, len: 0 };
    });
    if (best.len < 2) return groups.join(':');
    return `${groups.slice(0, best.at).join(':')}::${groups.slice(best.at + best.len).join(':')}`;
}

/**
 * One allowed network -> { version, base, bits, text }, or null when it cannot be read.
 * The base is cleaned to the start of the range ("10.1.2.3/8" becomes "10.0.0.0/8").
 */
function parseNetwork(text) {
    const s = String(text || '').trim();
    if (!s || s.length > 64) return null;
    const slash = s.indexOf('/');
    const addrText = slash === -1 ? s : s.slice(0, slash);
    const rawV6 = parseIpv4(addrText) === null ? parseIpv6(addrText) : null;
    const addr = parseAddress(addrText);
    if (!addr) return null;
    const width = addr.version === 4 ? 32 : 128;
    let bits = width;
    if (slash !== -1) {
        const b = s.slice(slash + 1);
        if (!/^\d{1,3}$/.test(b)) return null;
        bits = Number(b);
        // a range written on an IPv4-mapped IPv6 address ("::ffff:10.0.0.0/104") counts its bits from the IPv6 side
        if (addr.version === 4 && rawV6 !== null) bits -= 96;
        if (bits < 0 || bits > width) return null;
    }
    const hostBits = BigInt(width - bits);
    const base = (addr.value >> hostBits) << hostBits;
    const shown = addr.version === 4 ? formatV4(base) : formatV6(base);
    return { version: addr.version, base, bits, text: bits === width ? shown : `${shown}/${bits}` };
}

/** Is the address inside this one network? */
function inNetwork(address, network) {
    const a = typeof address === 'string' ? parseAddress(address) : address;
    const n = typeof network === 'string' ? parseNetwork(network) : network;
    if (!a || !n || a.version !== n.version) return false;
    const hostBits = BigInt((n.version === 4 ? 32 : 128) - n.bits);
    return (a.value >> hostBits) === (n.base >> hostBits);
}

/** Is the address inside any network of the list? An address that cannot be read is never inside. */
function addressInNetworks(address, networks) {
    const a = parseAddress(address);
    if (!a) return false;
    return (networks || []).some((n) => inNetwork(a, n));
}

/**
 * Cleans a list the company typed (an array, or text with one network per line or comma).
 * Returns { errors, value } where value is the list in its tidy spelling, without repeats.
 */
function validateNetworks(input, max = MAX_NETWORKS) {
    const errors = [];
    const items = (Array.isArray(input) ? input : String(input || '').split(/[\n,;]+/)).map((x) => String(x || '').trim()).filter(Boolean);
    const value = [];
    for (const item of items) {
        const n = parseNetwork(item);
        if (!n) { errors.push(`"${item.slice(0, 60)}" is not a network address. Use an address like 203.0.113.7 or a range like 203.0.113.0/24.`); continue; }
        if (n.bits === 0) { errors.push(`"${item.slice(0, 60)}" allows every address. Turn the limit off instead.`); continue; }
        if (!value.includes(n.text)) value.push(n.text);
    }
    if (value.length > max) errors.push(`List at most ${max} networks`);
    return { errors, value: value.slice(0, max) };
}

/** The address as it should be shown and stored ("::ffff:203.0.113.7" -> "203.0.113.7"); null when unreadable */
function tidyAddress(text) {
    const a = parseAddress(text);
    if (!a) return null;
    return a.version === 4 ? formatV4(a.value) : formatV6(a.value);
}

module.exports = { MAX_NETWORKS, parseIpv4, parseIpv6, parseAddress, parseNetwork, inNetwork, addressInNetworks, validateNetworks, tidyAddress };
