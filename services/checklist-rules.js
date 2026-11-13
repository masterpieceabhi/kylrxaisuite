/**
 * Onboarding, offboarding and rehire checklists. Pure rules, no I/O.
 *
 * A checklist is a list of tasks with an owner (employee, HR or manager) and a due date counted
 * from an anchor date (the start date, the last day, or the rehire date). Some tasks complete
 * themselves from data in the system (for example "W-4 filed"); the rest are ticked by a person.
 * Deadlines marked "check your state" differ by state and must be confirmed by a compliance advisor.
 */
const { addBusinessDays, parseIsoDate, isoDate } = require('./us-forms');

const ASSIGNEES = ['employee', 'hr', 'manager'];
const KINDS = ['onboarding', 'offboarding', 'rehire'];

// offset = calendar days from the anchor; business = business days from the anchor
const TEMPLATES = {
    onboarding: [
        { key: 'w4', title: 'Fill in your tax form (W-4)', assignee: 'employee', offset: 0, required: true, auto: 'w4' },
        { key: 'i9_section1', title: 'Fill in your work eligibility form (I-9, Section 1)', assignee: 'employee', offset: 0, required: true, auto: 'i9_section1' },
        { key: 'direct_deposit', title: 'Add your bank account for direct deposit', assignee: 'employee', offset: 5, required: true, auto: 'direct_deposit' },
        { key: 'handbook', title: 'Read the employee handbook', assignee: 'employee', offset: 3, required: true },
        { key: 'emergency_contact', title: 'Give HR an emergency contact', assignee: 'employee', offset: 3, required: false },
        { key: 'i9_section2', title: 'Check the new hire\'s documents (I-9, Section 2)', assignee: 'hr', business: 3, required: true, auto: 'i9_section2', help: 'Due 3 business days after the first day' },
        { key: 'manager_told', title: 'Tell the new hire who their manager is', assignee: 'hr', offset: 0, required: true },
        { key: 'kiosk_pin', title: 'Give a time-clock PIN if they use the shared tablet', assignee: 'hr', offset: 0, required: false, auto: 'kiosk_pin' },
        { key: 'equipment', title: 'Hand over uniform, keys or equipment', assignee: 'hr', offset: 0, required: false },
        { key: 'payroll_added', title: 'Add the person to payroll', assignee: 'hr', offset: 5, required: true },
        { key: 'new_hire_report', title: 'File the state new-hire report', assignee: 'hr', offset: 20, required: true, help: 'Check your state\'s deadline: it is commonly about 20 days' }
    ],
    offboarding: [
        { key: 'handover', title: 'Hand over current work to someone else', assignee: 'manager', offset: -3, required: false },
        { key: 'exit_interview', title: 'Hold an exit conversation', assignee: 'hr', offset: -2, required: false },
        { key: 'final_timesheet', title: 'Check the final timesheet and hours', assignee: 'hr', offset: 0, required: true },
        { key: 'equipment_back', title: 'Collect keys, uniform and equipment', assignee: 'hr', offset: 0, required: true },
        { key: 'access_removed', title: 'Turn off system access', assignee: 'hr', offset: 0, required: true, auto: 'login_disabled' },
        { key: 'final_pay', title: 'Prepare the final paycheck', assignee: 'hr', offset: 0, required: true, help: 'Check your state\'s final-pay deadline: some states require payment on the last day' },
        { key: 'leave_payout', title: 'Pay out unused leave if your policy or state requires it', assignee: 'hr', offset: 0, required: true },
        { key: 'benefits_notice', title: 'Send the benefits and COBRA notice if they were enrolled', assignee: 'hr', offset: 5, required: false },
        { key: 'i9_retention', title: 'Keep the I-9 until its retention date', assignee: 'hr', offset: 7, required: false }
    ],
    rehire: [
        { key: 'i9_review', title: 'Review the I-9: update Section 3 or complete a new form', assignee: 'hr', offset: 0, required: true, help: 'A new I-9 is usually needed when the earlier one is more than 3 years old' },
        { key: 'w4_refresh', title: 'Update your tax form (W-4)', assignee: 'employee', offset: 0, required: true },
        { key: 'direct_deposit', title: 'Check your bank account for direct deposit', assignee: 'employee', offset: 3, required: true, auto: 'direct_deposit' },
        { key: 'manager_told', title: 'Tell the person who their manager is', assignee: 'hr', offset: 0, required: true },
        { key: 'kiosk_pin', title: 'Give a time-clock PIN if they use the shared tablet', assignee: 'hr', offset: 0, required: false, auto: 'kiosk_pin' },
        { key: 'payroll_added', title: 'Add the person back to payroll', assignee: 'hr', offset: 3, required: true },
        { key: 'new_hire_report', title: 'File the state new-hire report', assignee: 'hr', offset: 20, required: true, help: 'Check your state\'s deadline' }
    ]
};

function addDays(iso, n) {
    const d = parseIsoDate(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return isoDate(d);
}

/** A built-in task tied to a form or a legal step (it completes itself from data, or is required) cannot be switched off */
const canSwitchOff = (t) => !t.auto && !t.required;

/**
 * A company's changes to the built-in lists: { onboarding: { off: [keys], extra: [tasks] }, ... }.
 * Only optional built-in tasks can be switched off; extra tasks are added after the built-in ones.
 */
function validateTemplateSettings(input) {
    const errors = []; const value = {};
    const b = input && typeof input === 'object' ? input : {};
    for (const kind of KINDS) {
        const k = b[kind] && typeof b[kind] === 'object' ? b[kind] : {};
        const builtIn = new Map(TEMPLATES[kind].map((t) => [t.key, t]));
        const off = [];
        for (const key of Array.isArray(k.off) ? [...new Set(k.off.map(String))] : []) {
            const t = builtIn.get(key);
            if (!t) errors.push(`${kind}: "${key}" is not a built-in task`);
            else if (!canSwitchOff(t)) errors.push(`${kind}: "${t.title}" cannot be switched off`);
            else off.push(key);
        }
        const extra = [];
        const list = Array.isArray(k.extra) ? k.extra : [];
        if (list.length > 30) errors.push(`${kind}: at most 30 added tasks`);
        list.slice(0, 30).forEach((t, i) => {
            const title = String((t && t.title) || '').replace(/[<>]/g, '').trim();
            const offset = Number(t && t.offset);
            if (title.length < 3) errors.push(`${kind}: added task ${i + 1} needs a title`);
            else if (!ASSIGNEES.includes(t.assignee)) errors.push(`${kind}: "${title}" needs who does it (${ASSIGNEES.join(', ')})`);
            else if (!Number.isInteger(offset) || offset < -60 || offset > 365) errors.push(`${kind}: "${title}" due days must be a whole number from -60 to 365`);
            else {
                const given = String((t && t.key) || '');
                const key = /^x_[a-z0-9]{4,16}$/.test(given) && !extra.some((e) => e.key === given) ? given : `x_${(Date.now() + i).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
                extra.push({ key, title: title.slice(0, 120), assignee: t.assignee, offset, required: t.required === true, help: String((t && t.help) || '').replace(/[<>]/g, '').trim().slice(0, 200) || null });
            }
        });
        value[kind] = { off, extra };
    }
    return { errors, value: errors.length ? null : value };
}

/** The task templates a company uses for one kind: built-in ones (minus those switched off) then its own */
function templatesFor(kind, custom) {
    const c = (custom && custom[kind]) || {};
    const off = new Set(Array.isArray(c.off) ? c.off : []);
    return [...TEMPLATES[kind].filter((t) => !(off.has(t.key) && canSwitchOff(t))), ...(Array.isArray(c.extra) ? c.extra : [])];
}

/** What the editor shows: every built-in task with whether it is on and whether it can be switched off, plus the company's own */
function describeTemplates(custom) {
    const out = {};
    for (const kind of KINDS) {
        const c = (custom && custom[kind]) || {}; const off = new Set(c.off || []);
        out[kind] = { builtIn: TEMPLATES[kind].map((t) => ({ key: t.key, title: t.title, assignee: t.assignee, required: t.required, due: t.business !== undefined ? `${t.business} business days` : `${t.offset || 0} days`, canSwitchOff: canSwitchOff(t), on: !(off.has(t.key) && canSwitchOff(t)), help: t.help || null })), extra: c.extra || [] };
    }
    return out;
}

/** Tasks for a checklist kind, with due dates counted from the anchor date. options.custom holds the company's template changes. */
function buildChecklist(kind, anchorIso, options = {}) {
    if (!TEMPLATES[kind]) throw new Error(`Unknown checklist kind: ${kind}`);
    if (!parseIsoDate(anchorIso)) throw new Error('anchor date must be YYYY-MM-DD');
    return templatesFor(kind, options.custom).map((t) => ({
        id: t.key, title: t.title, assignee: t.assignee, required: t.required, auto: t.auto || null, help: t.help || null,
        dueDate: t.business !== undefined ? addBusinessDays(anchorIso, t.business, options) : addDays(anchorIso, t.offset || 0),
        status: 'open', note: null, doneAt: null, doneBy: null, custom: false
    }));
}

function validateCustomTask(input, todayIso) {
    const errors = [];
    const b = input || {};
    const title = String(b.title || '').trim();
    if (!title) errors.push('title is required');
    if (!ASSIGNEES.includes(b.assignee)) errors.push(`assignee must be one of: ${ASSIGNEES.join(', ')}`);
    const due = b.dueDate || todayIso;
    if (!parseIsoDate(due)) errors.push('dueDate must be YYYY-MM-DD');
    return {
        errors,
        value: errors.length ? null : {
            id: `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: title.slice(0, 120), assignee: b.assignee,
            required: b.required === true, auto: null, help: null, dueDate: due, status: 'open', note: null, doneAt: null, doneBy: null, custom: true
        }
    };
}

/**
 * Adds live state to the tasks: done (ticked, or completed by data), overdue and due soon.
 * facts = { w4, i9_section1, i9_section2, direct_deposit, kiosk_pin, login_disabled } booleans.
 */
function evaluate(tasks, facts, todayIso) {
    const soonLimit = addDays(todayIso, 2);
    const rows = tasks.map((t) => {
        const doneByData = Boolean(t.auto && facts && facts[t.auto]);
        const done = t.status === 'done' || doneByData;
        const skipped = t.status === 'skipped';
        const open = !done && !skipped;
        return { ...t, done, doneByData, skipped, overdue: open && t.dueDate < todayIso, dueSoon: open && t.dueDate >= todayIso && t.dueDate <= soonLimit };
    });
    const required = rows.filter((r) => r.required && !r.skipped);
    const doneRequired = required.filter((r) => r.done).length;
    return {
        tasks: rows,
        summary: {
            total: rows.length, done: rows.filter((r) => r.done).length,
            required: required.length, doneRequired,
            percent: required.length ? Math.round((doneRequired / required.length) * 100) : 100,
            overdue: rows.filter((r) => r.overdue).length, complete: required.length === doneRequired
        }
    };
}

/** Which person can tick a task: its owner, or HR for anything */
function canComplete(task, role, isSelf) {
    const r = String(role || '').toLowerCase().replace(/[\s_-]+/g, '');
    const hr = ['superadmin', 'admin', 'hradmin', 'hrms', 'hrpayroll'].includes(r);
    if (hr) return true;
    if (task.assignee === 'employee') return isSelf;
    if (task.assignee === 'manager') return r === 'manager';
    return false;
}

module.exports = { validateTemplateSettings, templatesFor, describeTemplates, ASSIGNEES, KINDS, TEMPLATES, buildChecklist, validateCustomTask, evaluate, canComplete };
