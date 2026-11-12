/**
 * Carrier feed adapter interface (future work). A real adapter sends an enrollment file
 * (for example EDI 834 or the carrier's own CSV) and reads back confirmations. Real carrier
 * credentials are needed for that; none are stored here. Two implementations ship:
 *   - stub: refuses every call with a clear "not configured" result (the default)
 *   - mock: records what would be sent, for tests and demos
 *
 * Interface every adapter must implement:
 *   name                          string
 *   sendEnrollmentFeed(feed)      -> { success, accepted?, rejected?, reference?, error? }
 *   fetchConfirmations(reference) -> { success, items?, error? }
 *   describe()                    -> { name, configured, mode }
 */

const INTERFACE = ['sendEnrollmentFeed', 'fetchConfirmations', 'describe'];

function assertAdapter(adapter) {
    const missing = INTERFACE.filter((m) => typeof adapter[m] !== 'function');
    if (missing.length) throw new Error(`Carrier adapter is missing: ${missing.join(', ')}`);
    return adapter;
}

const stubAdapter = {
    name: 'stub',
    async sendEnrollmentFeed() { return { success: false, error: 'No carrier is connected. Real carrier credentials are required.' }; },
    async fetchConfirmations() { return { success: false, error: 'No carrier is connected. Real carrier credentials are required.' }; },
    describe() { return { name: 'stub', configured: false, mode: 'disabled' }; }
};

function createMockAdapter() {
    const sent = [];
    return {
        name: 'mock',
        sent,
        async sendEnrollmentFeed(feed) {
            const rows = (feed && feed.rows) || [];
            const reference = `mock_${sent.length + 1}`;
            const rejected = rows.filter((r) => !r.employeeId && !r.userId).map((r) => ({ name: r.name, error: 'missing employee id' }));
            sent.push({ reference, rows, at: new Date().toISOString() });
            return { success: true, accepted: rows.length - rejected.length, rejected, reference };
        },
        async fetchConfirmations(reference) {
            const hit = sent.find((s) => s.reference === reference);
            if (!hit) return { success: false, error: 'Unknown reference' };
            return { success: true, items: hit.rows.map((r) => ({ userId: r.userId, planName: r.planName, status: 'confirmed' })) };
        },
        describe() { return { name: 'mock', configured: true, mode: 'mock' }; }
    };
}

let mock = null;
function getAdapter(name) {
    if (name === 'mock') { mock = mock || createMockAdapter(); return assertAdapter(mock); }
    return assertAdapter(stubAdapter);
}

module.exports = { INTERFACE, assertAdapter, stubAdapter, createMockAdapter, getAdapter };
