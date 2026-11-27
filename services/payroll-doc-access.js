/**
 * Who may list or download a person's payslips and other pay documents (pure, no I/O).
 *
 *   - the person themself (the signed-in id is the document's employeeId), or
 *   - a role that is allowed to see pay: services/permissions.js 'people.read_pay'
 *     (owner, HR admin, payroll admin, accountant, auditor; the older India names Admin, Super Admin,
 *     HRMS and hr_payroll map onto owner / HR admin there)
 *   - and always inside one company: the person and the document must belong to the caller's company.
 * A manager or an executive is not a pay role: they see only their own documents.
 */
const { can } = require('./permissions');
const { ownerOrgId } = require('../config/tenant');

/** The signed-in person is asking for their own documents */
function isOwn(user, employeeId) {
    return Boolean(user && user.id && employeeId) && String(user.id) === String(employeeId);
}

/** First gate, needs no database: themself, or a role that may see pay */
function mayAskFor(user, employeeId) {
    return isOwn(user, employeeId) || can(user, 'people.read_pay');
}

/** A stored record (person, pay document, batch, run) belongs to the caller's company. Records from before companies existed belong to the first company. */
function inCompany(callerOrgId, record) {
    return Boolean(callerOrgId) && Boolean(record) && ownerOrgId(record) === callerOrgId;
}

/**
 * The whole decision for one pay document.
 *   person: the stored person the documents belong to, or null when there is no such person record
 *   doc:    the stored pay document (optional; leave out when only deciding about the person)
 * Returns { ok: true } or { ok: false, status, error }.
 */
function decide({ user, callerOrgId, employeeId, person = null, doc }) {
    if (!mayAskFor(user, employeeId)) return { ok: false, status: 403, error: 'You may only see your own pay documents' };
    if (!callerOrgId) return { ok: false, status: 403, error: 'Your account is not linked to a company' };
    if (person && !inCompany(callerOrgId, person)) return { ok: false, status: 403, error: 'That person is not in your company' };
    if (doc !== undefined) {
        // another company's document is reported as missing, so its existence is not revealed
        if (!doc || !inCompany(callerOrgId, doc)) return { ok: false, status: 404, error: 'Payroll document not found' };
        if (String(doc.employeeId) !== String(employeeId)) return { ok: false, status: 403, error: 'Not authorized for this document' };
    }
    return { ok: true };
}

module.exports = { isOwn, mayAskFor, inCompany, decide };
