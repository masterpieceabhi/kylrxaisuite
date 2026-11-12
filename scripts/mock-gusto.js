/**
 * Starts the mock Gusto server for local development and tests.
 *   node scripts/mock-gusto.js            (port 4010, or MOCK_GUSTO_PORT)
 * Test-only controls live under /__mock (expire tokens, inject 429/409/500, tamper webhooks ...).
 */
const { createMockGusto } = require('../services/gusto/mock-server');

const port = Number(process.env.MOCK_GUSTO_PORT || process.argv[2] || 4010);
const mock = createMockGusto({ verbose: process.env.MOCK_GUSTO_VERBOSE === '1' });
mock.listen(port).then(({ url }) => {
    console.log(`Mock Gusto listening on ${url}  (client id mock-client-id / secret mock-client-secret)`);
}).catch((e) => { console.error('Mock Gusto failed to start:', e.message); process.exit(1); });
process.on('SIGINT', () => mock.close().then(() => process.exit(0)));
