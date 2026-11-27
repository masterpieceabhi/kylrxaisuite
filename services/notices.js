/**
 * In-app notices for one person: "your time off was approved", "your week was sent back", "a document is waiting".
 *
 * They are kept in the collection the schedule notices already use (`schedule_notices`), so a person has ONE list
 * whatever the notice is about, read at GET /api/us/me/notices (and still at /api/us/schedule/notices).
 *
 * A notice is a courtesy on top of something already saved: writing one never throws and never fails the request
 * that caused it. Nothing here sends email or a push message.
 */
const COLLECTION = 'schedule_notices';
const clip = (s, n) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * @param {string} orgId
 * @param {string} userId  who the notice is for
 * @param {string} type    a short fixed word the client app can use to pick an icon or a screen, e.g. "leave_approved"
 * @param {string} title   a few words
 * @param {string} message one or two plain sentences
 * @param {object} [extra] small ids the app can open (requestId, weekStart ...); never personal data
 */
async function notify(orgId, userId, type, title, message, extra = {}) {
    if (!orgId || !userId || !type) return false;
    try {
        const { rawCollection } = require('../config/firebase');
        await rawCollection(COLLECTION).add({ ...extra, orgId, userId: String(userId), type: clip(type, 60), title: clip(title, 120), message: clip(message, 500), read: false, createdAt: new Date().toISOString() });
        return true;
    } catch (e) {
        try { require('../utils/logger').warn(`A notice could not be saved: ${e.message}`); } catch (_) { /* logging must not throw */ }
        return false;
    }
}

module.exports = { notify, COLLECTION };
