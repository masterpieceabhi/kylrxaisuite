/**
 * Event bus for integrations. Core routes call:
 *
 *     require('../services/events').emit(orgId, 'person.created', { person_id, ... })
 *
 * emit() is fire-and-forget and NEVER throws or rejects: it writes one `event_outbox` document and
 * returns the event id. A worker (services/webhooks.js) fans the outbox out to webhook endpoints
 * and event-driven connectors (Slack, Teams). Delivery failures can never affect the caller.
 *
 * Payloads should be small, canonical (snake_case) and free of sensitive data; they are passed
 * through the canonical forbidden-key filter before they are stored.
 */
const crypto = require('crypto');
const { stripForbidden } = require('./canonical');

/** Event catalog (documented in docs/EVENTS.md). Payload keys listed are the stable ones. */
const CATALOG = {
    'person.created': { description: 'A person was added', payload: ['person_id', 'employee_number', 'display_name', 'work_email', 'hire_date', 'job_title', 'source'] },
    'person.updated': { description: 'A person\'s basic fields changed', payload: ['person_id', 'changed_fields', 'source'] },
    'person.terminated': { description: 'A person was terminated or deactivated', payload: ['person_id', 'termination_date', 'source'] },
    'person.reactivated': { description: 'A deactivated person was reactivated', payload: ['person_id', 'source'] },
    'leave.requested': { description: 'A time-off request was submitted', payload: ['request_id', 'person_id', 'leave_type', 'start_date', 'end_date', 'hours'] },
    'leave.approved': { description: 'A time-off request was approved', payload: ['request_id', 'person_id', 'leave_type', 'start_date', 'end_date', 'hours'] },
    'leave.denied': { description: 'A time-off request was denied', payload: ['request_id', 'person_id'] },
    'leave.cancelled': { description: 'A time-off request was cancelled', payload: ['request_id', 'person_id'] },
    'timesheet.submitted': { description: 'A weekly timesheet was submitted for approval', payload: ['person_id', 'week_start', 'worked_hours'] },
    'timesheet.approved': { description: 'A weekly timesheet was approved', payload: ['person_id', 'week_start', 'worked_hours', 'overtime_hours'] },
    'timesheet.rejected': { description: 'A weekly timesheet was sent back', payload: ['person_id', 'week_start'] },
    'document.uploaded': { description: 'A document was added to the vault', payload: ['document_id', 'category', 'person_id'] },
    'document.signed': { description: 'A document was signed', payload: ['document_id', 'person_id', 'signed_at'] },
    'payroll.run.completed': { description: 'A payroll run finished (placeholder until the payroll provider module ships)', payload: ['run_id', 'pay_date', 'period_start', 'period_end'] },
    'connector.sync.failed': { description: 'A connector sync run ended with errors', payload: ['connection_id', 'connector', 'errors'] },
    'webhook.test': { description: 'Sent when an admin presses "Send test event"', payload: ['message'] }
};

const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Does a subscription filter list match this event type? ("*", "person.*", exact) */
function matchesEvent(filters, type) {
    if (!Array.isArray(filters) || filters.length === 0) return true;
    return filters.some((f) => f === '*' || f === type || (f.endsWith('.*') && type.startsWith(f.slice(0, -1))));
}

const eventId = () => `evt_${crypto.randomBytes(12).toString('hex')}`;

/** Builds the stored/ delivered envelope (pure) */
function buildEvent(orgId, type, payload, now = new Date()) {
    return {
        id: eventId(), type, api_version: 'v1', created_at: now.toISOString(), org_id: orgId,
        data: stripForbidden(payload && typeof payload === 'object' ? JSON.parse(JSON.stringify(payload)) : {})
    };
}

/** Fire-and-forget. Returns the event id (or null if the arguments were unusable). Never throws. */
function emit(orgId, type, payload) {
    try {
        if (!orgId || typeof type !== 'string' || !EVENT_TYPE.test(type)) return null;
        const event = buildEvent(orgId, type, payload);
        const { rawCollection } = require('../config/firebase');
        if (typeof rawCollection !== 'function') return event.id;
        Promise.resolve(rawCollection('event_outbox').doc(event.id).set({ orgId, type, event, status: 'pending', createdAt: event.created_at, attempts: 0 }))
            .then(() => { try { require('./webhooks').kick(); } catch (_) { /* worker not loaded */ } })
            .catch((e) => { try { require('../utils/logger').warn(`events.emit write failed: ${e.message}`); } catch (_) { /* ignore */ } });
        return event.id;
    } catch (_) {
        return null;
    }
}

module.exports = { emit, buildEvent, matchesEvent, CATALOG, EVENT_TYPE };
