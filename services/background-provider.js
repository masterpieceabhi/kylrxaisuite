/**
 * Background-check provider adapter. Every provider implements:
 *   order({ candidate: { id, firstName, lastName, email }, package })  -> { reference, status: 'in_progress' }
 *   fetchResult(reference, candidate)                                    -> { status: 'in_progress' | 'complete', result?: 'clear' | 'consider', reportReference? }
 * Only the MOCK provider exists: no real vendor is called. A real adapter (Checkr, Sterling, ...) would
 * need an API key held encrypted in the company's integration settings and its own contract with the vendor.
 */
const crypto = require('crypto');

const mock = {
    name: 'mock',
    async order({ candidate }) {
        return { reference: `MOCK-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, status: 'in_progress', candidateId: candidate && candidate.id };
    },
    /** A last name that contains "consider" gives a consider result so the adverse-action path can be tested */
    async fetchResult(reference, candidate) {
        const flagged = /consider/i.test(String((candidate && candidate.lastName) || ''));
        return { status: 'complete', result: flagged ? 'consider' : 'clear', reportReference: reference };
    }
};

const PROVIDERS = { mock };
const AVAILABLE = Object.keys(PROVIDERS);

function getProvider(name) {
    const p = PROVIDERS[String(name || 'mock')];
    if (!p) throw new Error(`Background-check provider "${name}" is not configured. Available: ${AVAILABLE.join(', ')}`);
    return p;
}

module.exports = { AVAILABLE, getProvider };
