/**
 * Paging for lists that are built in memory and used to be cut at a fixed size.
 *
 *   GET /api/us/leave/requests?limit=50              the first 50, with nextCursor when there are more
 *   GET /api/us/leave/requests?limit=50&cursor=...   the next 50
 *
 * Without `limit` a list answers as it always did (up to its old cap), so existing pages are unchanged; it now also
 * says when there is more (`nextCursor`), instead of silently dropping the rest.
 *
 * The cursor is a position in the list as it is sorted on the server. It is good for stepping through a list that
 * is not being reordered at that moment; a client that needs an exact snapshot asks again from the start.
 */
const MIN = 1;

const encode = (offset) => Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
function decode(cursor) {
    if (typeof cursor !== 'string' || !cursor || cursor.length > 40) return 0;
    let text;
    try { text = Buffer.from(cursor, 'base64url').toString('utf8'); } catch (_) { return 0; }
    const m = /^o:(\d{1,9})$/.exec(text);
    return m ? Number(m[1]) : 0;
}

/**
 * rows: the whole sorted list. query: req.query. cap: the most one answer may hold (the list's old fixed size).
 * map: optional, applied to the rows of this page only.
 * Returns { data, limit, nextCursor } to spread into the answer (nextCursor is null on the last page).
 */
function pageFields(rows, query, cap, map) {
    const list = Array.isArray(rows) ? rows : [];
    const q = query || {};
    const asked = Number.parseInt(q.limit, 10);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, MIN), cap) : cap;
    const offset = Math.min(decode(q.cursor), list.length);
    const slice = list.slice(offset, offset + limit);
    const next = offset + slice.length;
    return { data: typeof map === 'function' ? slice.map((r) => map(r)) : slice, limit, nextCursor: next < list.length ? encode(next) : null };
}

module.exports = { pageFields, _encode: encode, _decode: decode };
