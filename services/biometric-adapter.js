/**
 * Biometric vendor-device adapter: INTERFACE STUB ONLY. Biometric clocking is NOT implemented.
 *
 * A real adapter would wrap a certified vendor terminal and must: keep templates on the vendor device or
 * in the vendor's vault (never in our database), return only a yes/no match plus a vendor reference, and
 * delete templates on request. Until one is registered every call reports "unavailable" and the clock
 * falls back to the normal one-tap method. Enabling the method for a place whose rule needs consent or a
 * notice is also blocked until those consents exist (see clock-compliance-rules biometricGuard).
 */
let adapter = null;

const CONTRACT = ['enroll', 'verify', 'deleteTemplate'];

function register(impl) {
    const missing = CONTRACT.filter((m) => typeof (impl || {})[m] !== 'function');
    if (missing.length) throw new Error(`Biometric adapter is missing: ${missing.join(', ')}`);
    adapter = impl;
}

const isAvailable = () => Boolean(adapter);

async function enroll(args) { if (!adapter) throw Object.assign(new Error('Biometric clocking is not implemented'), { code: 'biometric_unavailable' }); return adapter.enroll(args); }
async function verify(args) { if (!adapter) throw Object.assign(new Error('Biometric clocking is not implemented'), { code: 'biometric_unavailable' }); return adapter.verify(args); }
async function deleteTemplate(args) { if (!adapter) return { deleted: false, reason: 'no_adapter' }; return adapter.deleteTemplate(args); }

module.exports = { CONTRACT, register, isAvailable, enroll, verify, deleteTemplate };
