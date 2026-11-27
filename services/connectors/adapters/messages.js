/** Human-readable text for events, used by the Slack and Teams adapters (pure) */
const person = (d) => d.display_name || d.person_name || d.person_id || 'someone';

const FORMATTERS = {
    'person.created': (d) => ({ title: 'New employee added', lines: [`${person(d)}${d.job_title ? ` (${d.job_title})` : ''}`, d.hire_date ? `Start date: ${d.hire_date}` : null] }),
    'person.updated': (d) => ({ title: 'Employee record updated', lines: [`${person(d)}`, d.changed_fields && d.changed_fields.length ? `Changed: ${d.changed_fields.join(', ')}` : null] }),
    'person.terminated': (d) => ({ title: 'Employee terminated', lines: [`${person(d)}`, d.termination_date ? `Last day: ${d.termination_date}` : null] }),
    'person.reactivated': (d) => ({ title: 'Employee reactivated', lines: [`${person(d)}`] }),
    'leave.requested': (d) => ({ title: 'Time off requested', lines: [`${person(d)}: ${d.leave_type || 'time off'}`, d.start_date ? `${d.start_date}${d.end_date && d.end_date !== d.start_date ? ` to ${d.end_date}` : ''}${d.hours ? ` (${d.hours} h)` : ''}` : null] }),
    'leave.approved': (d) => ({ title: 'Time off approved', lines: [`${person(d)}: ${d.leave_type || 'time off'}`, d.start_date ? `${d.start_date}${d.end_date && d.end_date !== d.start_date ? ` to ${d.end_date}` : ''}` : null] }),
    'leave.denied': (d) => ({ title: 'Time off denied', lines: [`${person(d)}`] }),
    'timesheet.approved': (d) => ({ title: 'Timesheet approved', lines: [`${person(d)}: week of ${d.week_start}`, d.worked_hours !== undefined ? `${d.worked_hours} hours` : null] }),
    'timesheet.submitted': (d) => ({ title: 'Timesheet submitted', lines: [`${person(d)}: week of ${d.week_start}`] }),
    'document.signed': (d) => ({ title: 'Document signed', lines: [`${person(d)}`, d.document_id ? `Document ${d.document_id}` : null] }),
    'payroll.run.completed': (d) => ({ title: 'Payroll run completed', lines: [d.pay_date ? `Pay date: ${d.pay_date}` : null] }),
    'connector.sync.failed': (d) => ({ title: 'Integration sync failed', lines: [`${d.connector || 'connector'}: ${Array.isArray(d.errors) ? d.errors.length : 0} error(s)`] }),
    'webhook.test': (d) => ({ title: 'Test event', lines: [d.message || 'Hello from Kylrx'] })
};

function describeEvent(event) {
    const f = FORMATTERS[event.type];
    const r = f ? f(event.data || {}) : { title: event.type, lines: [] };
    return { title: r.title, lines: r.lines.filter(Boolean), type: event.type, id: event.id, at: event.created_at };
}

/** Which channel for an event: routes can be exact types, "person.*" or "*" */
function routeFor(routes, type, fallback) {
    const r = routes || {};
    if (r[type]) return r[type];
    const dot = type.indexOf('.');
    if (dot > 0 && r[`${type.slice(0, dot)}.*`]) return r[`${type.slice(0, dot)}.*`];
    return r['*'] || fallback || null;
}

module.exports = { describeEvent, routeFor };
