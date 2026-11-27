/**
 * Notice texts (pure rules): a small library of notice templates a company can edit, with simple versions.
 *
 * The starters are FEDERAL notices only and are starting drafts, not legal advice. Every starter, and every
 * edited version that has not been marked as reviewed, is rendered with the banner below at the top.
 * No state-specific text is shipped: state rules differ and change, so a company adds its own with its advisor.
 */
const { parseIsoDate } = require('./us-forms');

const DRAFT_BANNER = 'STARTING DRAFT - have a US compliance advisor review before use.';
const REVIEW_NOTE = 'These are starting drafts of federal notices, not legal advice. Have a US compliance advisor review each one before you use it, and add any state or local notices your advisor says you need.';

const MERGE_FIELDS = [
    { key: 'company_name', label: 'Company name', source: 'filled in from your company record' },
    { key: 'person_name', label: 'Person\'s full name', source: 'filled in from the person you choose' },
    { key: 'person_first_name', label: 'Person\'s first name', source: 'filled in from the person you choose' },
    { key: 'date', label: 'Today\'s date', source: 'filled in when the notice is prepared' },
    { key: 'hr_contact', label: 'Who to contact (name, phone or e-mail)', source: 'from your notice settings' },
    { key: 'plan_name', label: 'Health plan name', source: 'from your notice settings' },
    { key: 'plan_administrator', label: 'Plan administrator and how to reach them', source: 'from your notice settings' }
];
const FIELD_KEYS = MERGE_FIELDS.map((f) => f.key);
const DEFAULT_KEYS = ['hr_contact', 'plan_name', 'plan_administrator'];
const FIELD_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

const STARTERS = [
    {
        key: 'fmla_rights', title: 'Your rights under the Family and Medical Leave Act (FMLA)', scope: 'federal', relatedPosting: 'fmla',
        whenUsed: 'Covered employers give employees general information about FMLA rights (for example in a handbook or at hire). Whether you are covered depends on your size.',
        source: 'U.S. Department of Labor, Wage and Hour Division (dol.gov/agencies/whd/fmla) publishes the official poster and notice forms.',
        body: [
            '{{company_name}} is giving this notice to {{person_name}} on {{date}}.',
            'The Family and Medical Leave Act (FMLA) is a federal law. It lets eligible employees of covered employers take unpaid, job-protected leave for certain family and medical reasons. During FMLA leave, group health coverage continues on the same terms as if the employee had kept working.',
            'Reasons for leave under the federal law include:\n- the birth of a child, and bonding with the newborn\n- a child placed with the employee for adoption or foster care\n- caring for a spouse, child or parent who has a serious health condition\n- the employee\'s own serious health condition that makes the employee unable to do the job\n- certain urgent needs that arise because a family member is on covered military duty, and care for a covered servicemember with a serious injury or illness',
            'In general, an employee is eligible after working for the employer for at least 12 months, with at least 1,250 hours of work in the last 12 months, at a location where the employer has at least 50 employees within 75 miles. An eligible employee may take up to 12 workweeks of leave in a 12-month period, or up to 26 workweeks to care for a covered servicemember.',
            'How to ask for leave at {{company_name}}: tell {{hr_contact}} as early as you can. When the need for leave can be planned, the federal rules generally ask for 30 days of notice. You may be asked for a certification from a health care provider. We will tell you whether you are eligible and what your rights and responsibilities are.',
            'When the leave ends, an employee is generally returned to the same job or an equivalent one. An employer may not interfere with FMLA rights or punish someone for using them.',
            'This notice describes the federal law only. Your state may give you additional leave rights.',
            'Before use, compare this text with the current official notice from the U.S. Department of Labor.'
        ].join('\n\n')
    },
    {
        key: 'cobra_general', title: 'General notice of COBRA continuation coverage rights', scope: 'federal', relatedPosting: null,
        whenUsed: 'Group health plans subject to federal COBRA give this general notice to a covered employee (and covered spouse) when coverage under the plan begins.',
        source: 'U.S. Department of Labor, Employee Benefits Security Administration (dol.gov/agencies/ebsa) publishes a model general notice.',
        body: [
            'To: {{person_name}} (and covered family members)\nFrom: {{company_name}}\nDate: {{date}}\nPlan: {{plan_name}}',
            'You have recently become covered under a group health plan (the Plan). This notice has important information about your right to COBRA continuation coverage, which is a temporary extension of coverage under the Plan. It explains what COBRA continuation coverage is, when it may become available to you and your family, and what you need to do to protect your right to get it.',
            'What is COBRA continuation coverage? It is a continuation of Plan coverage when it would otherwise end because of a life event, called a "qualifying event". After a qualifying event, COBRA continuation coverage must be offered to each person who is a "qualified beneficiary". You, your spouse and your dependent children could become qualified beneficiaries if coverage under the Plan is lost because of the qualifying event. Qualified beneficiaries who choose COBRA continuation coverage usually have to pay for it.',
            'Qualifying events include, for an employee: your hours of employment are reduced, or your employment ends for any reason other than gross misconduct. For a spouse or dependent child they also include: the employee dies; the employee becomes entitled to Medicare; divorce or legal separation; or a child stops being eligible for coverage under the Plan as a dependent child.',
            'Who has to tell the Plan? The employer tells the Plan Administrator when employment ends, hours are reduced, the employee dies, or the employee becomes entitled to Medicare. For the other qualifying events (divorce or legal separation, or a child losing eligibility as a dependent child), you must tell the Plan Administrator within 60 days after the event. Send that notice to: {{plan_administrator}}.',
            'How long does it last? COBRA continuation coverage is temporary. When the qualifying event is the end of employment or a reduction of hours, it generally lasts for up to 18 months. Certain other qualifying events, or a second qualifying event during the first 18 months, may allow up to 36 months. The period can also be extended if a qualified beneficiary is found to be disabled.',
            'Are there other options? Yes. Instead of COBRA continuation coverage, there may be other coverage options for you and your family through the Health Insurance Marketplace, Medicaid, or another group health plan (such as a spouse\'s plan) through a "special enrollment period". Some of these options may cost less than COBRA continuation coverage. You can learn more at www.healthcare.gov.',
            'Keep the Plan informed of address changes. To protect your family\'s rights, let the Plan Administrator know about any changes in the addresses of family members, and keep a copy of any notices you send.',
            'If you have questions about the Plan or your COBRA rights, contact {{hr_contact}} or the Plan Administrator: {{plan_administrator}}.',
            'Federal COBRA generally applies to group health plans of employers with 20 or more employees. A smaller employer may be covered by a state continuation law instead; this draft does not cover state law. Before use, compare this text with the current model general notice from the U.S. Department of Labor and with your plan documents.'
        ].join('\n\n')
    },
    {
        key: 'marketplace_newhire', title: 'New hire notice: Health Insurance Marketplace coverage options', scope: 'federal', relatedPosting: null,
        whenUsed: 'Employers covered by the Fair Labor Standards Act give new employees a notice about the Health Insurance Marketplace, usually within 14 days of the start date.',
        source: 'U.S. Department of Labor, Employee Benefits Security Administration (dol.gov/agencies/ebsa) publishes model notices for employers that do, and do not, offer a health plan.',
        body: [
            'To: {{person_name}}\nFrom: {{company_name}}\nDate: {{date}}',
            'PART A: General information',
            'There is a way to buy health insurance called the Health Insurance Marketplace. This notice gives you some basic information about the Marketplace and about health coverage offered through your job, to help you as you look at options for you and your family.',
            'What is the Health Insurance Marketplace? The Marketplace is designed to help you find health insurance that meets your needs and fits your budget. It offers "one-stop shopping" to find and compare private health insurance options. You may also be eligible for a tax credit that lowers your monthly premium.',
            'Can I save money on my premiums in the Marketplace? You may qualify to save money, but only if your employer does not offer coverage, or offers coverage that is not considered affordable for you or does not meet certain minimum value standards. The savings you may be eligible for depend on your household income.',
            'Does health coverage through my job affect whether I can get savings? Yes. If you have an offer of health coverage from your employer that is considered affordable for you and meets minimum value standards, you will not be eligible for a tax credit through the Marketplace and may wish to enroll in your employer\'s plan. If you buy a plan through the Marketplace instead of accepting coverage offered by your employer, you may lose any employer contribution to the employer-offered coverage. That employer contribution, and your own contribution to employer-offered coverage, is often excluded from income for federal and state income tax purposes.',
            'How can I get more information? For information about coverage offered through your job, check your plan documents or contact {{hr_contact}}. The Marketplace can help you evaluate your coverage options, including your eligibility for coverage through the Marketplace and its cost. Visit www.healthcare.gov for more information, including an online application and contact information for a Health Insurance Marketplace in your area.',
            'PART B: Information about health coverage offered by your employer',
            'Employer name: {{company_name}}\nEmployer Identification Number (EIN): [fill in]\nEmployer address and phone: [fill in]\nWho to contact about employee health coverage: {{hr_contact}}',
            'Does {{company_name}} offer a health plan to some or all employees? [Yes / No - fill in. If yes: which employees are eligible, whether dependents are covered, and the plan name: {{plan_name}}]',
            'Before use, compare this text with the current model notice from the U.S. Department of Labor and complete every [fill in] item.'
        ].join('\n\n')
    }
];

const STARTER_KEYS = STARTERS.map((s) => s.key);
const starter = (key) => STARTERS.find((s) => s.key === key) || null;
const KEY_RE = /^[a-z][a-z0-9_]{2,49}$/;

/** Merge fields used in a text; { known, unknown } */
function fieldsIn(text) {
    const used = [...new Set([...String(text || '').matchAll(FIELD_RE)].map((m) => m[1]))];
    return { known: used.filter((k) => FIELD_KEYS.includes(k)), unknown: used.filter((k) => !FIELD_KEYS.includes(k)) };
}

/** A key for a company's own template, made from its title: "Texas pay day notice" -> "custom_texas_pay_day_notice" */
function keyFromTitle(title, taken = []) {
    const base = `custom_${String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36) || 'notice'}`;
    let key = base; let n = 2;
    while (taken.includes(key) || STARTER_KEYS.includes(key)) key = `${base}_${n++}`;
    return key;
}

function validateTemplate(input) {
    const b = input || {}; const errors = []; const value = {};
    const title = String(b.title || '').trim();
    if (title.length < 3 || title.length > 120) errors.push('title must be 3 to 120 characters'); else value.title = title;
    const body = String(b.body || '').replace(/\r\n/g, '\n').trim();
    if (body.length < 20) errors.push('the text is too short (at least 20 characters)');
    else if (body.length > 20000) errors.push('the text is too long (20,000 characters at most)');
    else value.body = body;
    const { unknown } = fieldsIn(body);
    if (unknown.length) errors.push(`unknown fill-in ${unknown.map((u) => `{{${u}}}`).join(', ')}. Use only: ${FIELD_KEYS.map((k) => `{{${k}}}`).join(', ')}`);
    if (/\{\{(?![^{}]*\}\})|\{\{\s*\}\}/.test(body)) errors.push('a fill-in is not closed: write it as {{name}}');
    const note = String(b.changeNote || '').trim();
    if (note.length > 200) errors.push('changeNote can be at most 200 characters'); else if (note) value.changeNote = note;
    return { errors, value };
}

const validKey = (key) => KEY_RE.test(String(key || ''));

/**
 * The next stored document when a template is saved. `current` is the company's stored copy or null.
 * Saving the same title and text again changes nothing. A new version is never "reviewed".
 */
function nextVersion(current, value, { key, orgId, actor, now }) {
    if (current && current.title === value.title && current.body === value.body) return { changed: false, doc: current };
    const history = current ? [...(current.history || []), { version: current.version, title: current.title, body: current.body, savedAt: current.updatedAt, savedBy: current.updatedBy || null, changeNote: current.changeNote || null, reviewed: current.reviewed || null }].slice(-20) : [];
    return {
        changed: true,
        doc: {
            orgId, key, title: value.title, body: value.body, version: current ? current.version + 1 : 1, starter: STARTER_KEYS.includes(key),
            changeNote: value.changeNote || null, reviewed: null, createdAt: current ? current.createdAt : now, updatedAt: now, updatedBy: actor || null, history
        }
    };
}

function validateReview(input, todayIso) {
    const b = input || {}; const errors = []; const value = {};
    const name = String(b.reviewerName || '').trim();
    if (name.length < 2 || name.length > 120) errors.push('reviewerName is required (who reviewed it)'); else value.reviewerName = name;
    const on = String(b.reviewedOn || todayIso || '');
    if (!parseIsoDate(on)) errors.push('reviewedOn must be a real date (YYYY-MM-DD)');
    else if (todayIso && on > todayIso) errors.push('reviewedOn cannot be in the future');
    else value.reviewedOn = on;
    if (b.note) { const n = String(b.note).trim(); if (n.length > 300) errors.push('note can be at most 300 characters'); else value.note = n; }
    return { errors, value };
}

/** Is this version still a draft (not yet reviewed)? Starters that were never saved are always drafts. */
const isDraft = (doc) => !doc || !doc.reviewed || doc.reviewed.version !== doc.version;

/** The template a company sees for a key: its own copy, or the untouched starter (version 0) */
function effective(key, stored) {
    if (stored) return { ...stored, draft: isDraft(stored), customised: true };
    const s = starter(key);
    if (!s) return null;
    return { key: s.key, title: s.title, body: s.body, version: 0, starter: true, reviewed: null, draft: true, customised: false, history: [], updatedAt: null };
}

/** Row for the library list */
function summary(t, attachedTo = []) {
    const s = starter(t.key);
    return {
        key: t.key, title: t.title, version: t.version, starter: Boolean(s), customised: t.customised !== false && t.version > 0, draft: t.draft !== false,
        scope: s ? s.scope : 'company', whenUsed: s ? s.whenUsed : null, source: s ? s.source : null, relatedPosting: s ? s.relatedPosting : null,
        reviewed: t.reviewed || null, updatedAt: t.updatedAt || null, fields: fieldsIn(t.body).known, attachedTo, mark: t.draft !== false ? DRAFT_BANNER : null
    };
}

/** Long US date for a YYYY-MM-DD day: "March 9, 2026" */
function longDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return '';
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** Values for the fill-ins from what the system knows; anything given in `extra` wins */
function mergeValues({ companyName, personName, today, defaults = {}, extra = {} }) {
    const clean = (v) => String(v === undefined || v === null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
    const person = clean(personName);
    const out = { company_name: clean(companyName), person_name: person, person_first_name: person.split(/\s+/)[0] || '', date: longDate(today) };
    for (const k of DEFAULT_KEYS) out[k] = clean(defaults[k]);
    for (const [k, v] of Object.entries(extra || {})) if (FIELD_KEYS.includes(k) && clean(v)) out[k] = clean(v);
    return out;
}

/**
 * Fills a template. A fill-in with no value stays visible as [label] so nobody sends a notice with a hole in it.
 * Returns { title, text, missing, draft }.
 */
function render(template, values) {
    const missing = new Set();
    const label = (k) => (MERGE_FIELDS.find((f) => f.key === k) || { label: k }).label;
    const text = String(template.body).replace(FIELD_RE, (m, k) => {
        if (!FIELD_KEYS.includes(k)) return m;
        const v = values && values[k];
        if (v === undefined || v === null || String(v).trim() === '') { missing.add(k); return `[${label(k)}]`; }
        return String(v);
    });
    const draft = template.version > 0 ? isDraft(template) : true; // an untouched starter is always a draft
    return { title: template.title, text: draft ? `${DRAFT_BANNER}\n\n${text}` : text, missing: [...missing], draft };
}

function validateDefaults(input) {
    const b = input || {}; const errors = []; const value = {};
    for (const k of DEFAULT_KEYS) {
        if (b[k] === undefined) continue;
        const v = String(b[k] === null ? '' : b[k]).replace(/[\r\n]+/g, ' ').trim();
        if (v.length > 300) errors.push(`${k} can be at most 300 characters`); else value[k] = v;
    }
    return { errors, value };
}

module.exports = {
    DRAFT_BANNER, REVIEW_NOTE, MERGE_FIELDS, FIELD_KEYS, DEFAULT_KEYS, STARTERS, STARTER_KEYS, starter, fieldsIn, keyFromTitle, validKey, validateTemplate,
    nextVersion, validateReview, isDraft, effective, summary, longDate, mergeValues, render, validateDefaults
};
