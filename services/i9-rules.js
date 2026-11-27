/**
 * Form I-9 screens for HR (pure, no I/O): the document lists with plain titles, masking of document numbers,
 * Supplement B (reverification and rehire), the per-person row for the list and the upcoming expiries.
 *
 * The lists are the ones services/us-forms.js already validates against; nothing is added here. Which documents
 * are acceptable and when to reverify is decided by USCIS and changes: every screen shows ADVISOR_NOTE.
 */
const forms = require('./us-forms');

const ADVISOR_NOTE = 'This follows the layout of Form I-9. Which documents are acceptable, and who must be checked again and when, is set by USCIS and can change. Confirm with a US compliance advisor.';

const TITLES = {
    us_passport: 'U.S. passport', us_passport_card: 'U.S. passport card', permanent_resident_card: 'Permanent Resident Card (Form I-551)',
    foreign_passport_with_i551: 'Foreign passport with a temporary I-551 stamp', employment_authorization_document: 'Employment Authorization Document (Form I-766)',
    foreign_passport_with_i94: 'Foreign passport with Form I-94', micronesia_marshall_passport: 'Passport from Micronesia or the Marshall Islands with Form I-94',
    drivers_license: 'Driver\'s license', state_id_card: 'State ID card', school_id_with_photo: 'School ID card with a photo', voter_registration_card: 'Voter registration card',
    military_id_card: 'U.S. military card', us_coast_guard_merchant_mariner_card: 'U.S. Coast Guard Merchant Mariner card', native_american_tribal_document: 'Native American tribal document',
    social_security_card_unrestricted: 'Social Security card (without work restrictions)', birth_abstract_or_certificate: 'Birth certificate', us_citizen_id_card: 'U.S. citizen ID card',
    native_american_tribal_document_c: 'Native American tribal document', employment_authorization_dhs: 'Employment authorization document issued by DHS'
};
const titleOf = (type) => TITLES[type] || String(type || '');
const LISTS = { A: forms.I9_LIST_A, B: forms.I9_LIST_B, C: forms.I9_LIST_C };

/** The three lists as { key, label } for the screens */
const documentLists = () => Object.fromEntries(Object.entries(LISTS).map(([k, types]) => [k, types.map((key) => ({ key, label: titleOf(key) }))]));

const SUPPLEMENT_KINDS = ['reverification', 'rehire', 'name_change'];
const SUPPLEMENT_LISTS = ['A', 'C']; // Supplement B takes a List A or a List C document; List B (identity) is never checked again
const METHODS = ['in_person', 'alternative_procedure'];
const MAX_SUPPLEMENTS = 20;

/** The end of a document number that is safe to keep in the clear: never the whole of a short number */
function tailOf(number) {
    const n = String(number || '').trim();
    if (n.length >= 8) return n.slice(-4);
    if (n.length >= 4) return n.slice(-2);
    return '';
}
/** What lists show instead of a document number */
const maskNumber = (tail) => (tail ? `ends in ${tail}` : 'on file');

/** A stored document without its encrypted number, for any screen */
function publicDocument(d) {
    if (!d) return null;
    const { numberEncrypted, number, numberLast4, ...rest } = d;
    return { ...rest, title: rest.title || titleOf(rest.type), numberMasked: maskNumber(numberLast4), hasNumber: Boolean(numberEncrypted) };
}
/** A stored Supplement B entry without its encrypted number */
const publicSupplement = (s) => (s ? { ...s, document: publicDocument(s.document) } : null);
/** Section 2 as the screens may see it */
function publicSection2(s2) {
    if (!s2) return null;
    const { supplementB, ...rest } = s2;
    return { ...rest, listA: publicDocument(s2.listA), listB: publicDocument(s2.listB), listC: publicDocument(s2.listC), supplementB: (supplementB || []).map(publicSupplement) };
}

const text = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

/**
 * Supplement B: a new document when work authorization ends (reverification), a rehire within three years, or a new name.
 * A reverification needs a document; a rehire or a name change may have one.
 */
function validateSupplementB(input, { todayIso } = {}) {
    const errors = []; const b = input || {}; const value = {};
    if (!SUPPLEMENT_KINDS.includes(b.kind)) errors.push(`kind must be one of: ${SUPPLEMENT_KINDS.join(', ')}`); else value.kind = b.kind;

    if (value.kind === 'rehire') {
        if (!forms.parseIsoDate(b.rehireDate)) errors.push('rehireDate (YYYY-MM-DD) is required for a rehire'); else value.rehireDate = b.rehireDate;
    }
    const newName = text(b.newName, 120);
    if (value.kind === 'name_change' && !newName) errors.push('newName is required for a name change');
    if (newName) value.newName = newName;

    const d = b.document;
    const hasDoc = Boolean(d && typeof d === 'object' && (d.type || d.number || d.list));
    if (value.kind === 'reverification' && !hasDoc) errors.push('A reverification needs the new document (List A or List C)');
    if (hasDoc) {
        if (!SUPPLEMENT_LISTS.includes(d.list)) errors.push('document.list must be A or C');
        else {
            const r = forms.validateDocument(d, LISTS[d.list], 'document');
            // the issuing authority is not asked for on Supplement B
            errors.push(...r.errors.filter((e) => !/issuingAuthority/.test(e)));
            value.document = { list: d.list, ...r.value, title: text(r.value.title, 120) || titleOf(r.value.type), issuingAuthority: text(r.value.issuingAuthority, 120) || null, number: text(r.value.number, 60) };
        }
    }

    if (!forms.parseIsoDate(b.examinedOn)) errors.push('examinedOn (YYYY-MM-DD) is required');
    else if (todayIso && b.examinedOn > todayIso) errors.push('examinedOn cannot be in the future');
    else value.examinedOn = b.examinedOn;
    const method = b.examinationMethod === undefined || b.examinationMethod === '' ? 'in_person' : b.examinationMethod;
    if (!METHODS.includes(method)) errors.push('examinationMethod must be in_person or alternative_procedure'); else value.examinationMethod = method;
    const signer = text(b.signerName, 120);
    if (!signer) errors.push('signerName is required'); else value.signerName = signer;
    const title = text(b.signerTitle, 120); if (title) value.signerTitle = title;
    if (b.certification !== true) errors.push('certification is required (the employer attests the document appears genuine)');
    return { errors, value: errors.length ? null : value };
}

const daysBetween = (fromIso, toIso) => Math.round((forms.parseIsoDate(toIso) - forms.parseIsoDate(fromIso)) / 86400000);

/**
 * One person's line in the HR list. `person` = { id, data } (a stored person), firstDay their first day of work (or null).
 * No document number appears here, only how it ends.
 */
function listRow(person, firstDay, todayIso, options = {}) {
    const d = person.data || {};
    const i9 = (d.usForms && d.usForms.i9) || {};
    const s1 = i9.section1 || null; const s2 = i9.section2 || null;
    const st = forms.onboardingStatus({ firstDay, w4: (d.usForms || {}).w4, i9, todayIso, options });
    const section2Late = Boolean(s2 && st.i9Section2Due && s2.examinedOn > st.i9Section2Due);
    const documents = s2 ? ['listA', 'listB', 'listC'].filter((k) => s2[k]).map((k) => {
        const doc = publicDocument(s2[k]);
        return { list: k.slice(-1), title: doc.title, numberMasked: doc.numberMasked, expiresOn: doc.expiresOn || null };
    }) : [];
    const newest = forms.latestSupplementDocument(s2);
    const rehire = i9.rehire && i9.rehire.action ? { action: i9.rehire.action, reason: i9.rehire.reason || null, startDate: i9.rehire.startDate || null } : null;
    let next = 'none';
    if (!s1) next = 'waiting_section1';
    else if (!s2) next = 'section2';
    else if (rehire) next = rehire.action === 'new_i9' ? 'new_form' : 'rehire';
    else if (st.flags.includes('i9_reverification_overdue') || st.flags.includes('i9_reverification_soon')) next = 'reverify';
    return {
        id: person.id, employeeId: d.employeeId || person.id, name: d.name || null, firstDay: firstDay || null,
        i9State: st.i9State, section1SignedOn: s1 && s1.signedAt ? String(s1.signedAt).slice(0, 10) : null, section1Due: st.i9Section1Due,
        citizenshipStatus: s1 ? s1.citizenshipStatus || null : null,
        section2Due: st.i9Section2Due, section2ExaminedOn: s2 ? s2.examinedOn || null : null, section2Late,
        section2DaysLeft: !s2 && st.i9Section2Due ? daysBetween(todayIso, st.i9Section2Due) : null,
        section1Overdue: st.flags.includes('i9_section1_overdue'), section2Overdue: st.flags.includes('i9_section2_overdue'),
        documents, supplements: s2 && Array.isArray(s2.supplementB) ? s2.supplementB.length : 0,
        latestDocument: newest ? { title: newest.document.title || titleOf(newest.document.type), numberMasked: maskNumber(newest.document.numberLast4), expiresOn: newest.document.expiresOn || null, examinedOn: newest.examinedOn } : null,
        reverifyOn: st.reverifyOn, reverifyDaysLeft: st.reverifyOn ? daysBetween(todayIso, st.reverifyOn) : null,
        reverifyOverdue: st.flags.includes('i9_reverification_overdue'), rehire, next
    };
}

/** People whose work authorization ends within `windowDays` (or already has), soonest first */
function upcomingExpiries(rows, windowDays = 90) {
    return rows.filter((r) => r.reverifyOn && r.reverifyDaysLeft <= windowDays)
        .map((r) => ({ id: r.id, employeeId: r.employeeId, name: r.name, reverifyOn: r.reverifyOn, daysLeft: r.reverifyDaysLeft, overdue: r.reverifyDaysLeft < 0, canRecord: r.i9State === 'complete' }))
        .sort((a, b) => a.daysLeft - b.daysLeft);
}

function summarize(rows) {
    return {
        total: rows.length,
        complete: rows.filter((r) => r.i9State === 'complete').length,
        waitingSection1: rows.filter((r) => r.i9State === 'not_started').length,
        section2ToDo: rows.filter((r) => r.i9State === 'section1_done').length,
        section2Overdue: rows.filter((r) => r.section2Overdue).length,
        reverifySoon: rows.filter((r) => r.reverifyOn && r.reverifyDaysLeft >= 0 && r.reverifyDaysLeft <= 90).length,
        reverifyOverdue: rows.filter((r) => r.reverifyOverdue).length,
        rehires: rows.filter((r) => r.rehire).length
    };
}

/** Which stored number a reveal request points at: { stored } or { error } */
function findNumber(i9, which, supplementId) {
    const s2 = (i9 && i9.section2) || null;
    if (which === 'section1') return { stored: i9 && i9.section1 ? i9.section1.authorizationNumberEncrypted || null : null };
    if (['listA', 'listB', 'listC'].includes(which)) return { stored: s2 && s2[which] ? s2[which].numberEncrypted || null : null };
    if (which === 'supplement') {
        const s = s2 && Array.isArray(s2.supplementB) ? s2.supplementB.find((x) => x.id === supplementId) : null;
        return { stored: s && s.document ? s.document.numberEncrypted || null : null };
    }
    return { error: 'which must be section1, listA, listB, listC or supplement' };
}

const COPY_CATEGORY = 'i9_document';
const COPY_CATEGORY_LABEL = 'Form I-9 document copy';
const COPY_PARTS = ['section2', 'supplement'];

/** Checks the details sent with a document copy (the file itself is checked by the vault rules) */
function validateCopyMeta(input) {
    const errors = []; const b = input || {};
    const part = b.part || 'section2';
    if (!COPY_PARTS.includes(part)) errors.push('part must be section2 or supplement');
    if (!['A', 'B', 'C'].includes(b.list)) errors.push('list must be A, B or C');
    if (part === 'supplement' && !text(b.supplementId, 64)) errors.push('supplementId is required for a Supplement B copy');
    return { errors, value: errors.length ? null : { part, list: b.list, supplementId: part === 'supplement' ? text(b.supplementId, 64) : null, title: text(b.title, 120) || null } };
}

/* ---------------------------------- what the forms can start from ---------------------------------- */

/** The signer's own job title for "Your job title" on Section 2 and Supplement B (the people screens keep it in usProfile; older records at the top) */
const signerTitleOf = (user) => text((user && ((user.usProfile && user.usProfile.jobTitle) || user.jobTitle)) || '', 120);

/**
 * Section 2 starts each document's expiry from what Section 1 already says: the person stated the date their
 * permission to work ends, which is the end date on their Employment Authorization Document. Section 2 only: a
 * reverification (Supplement B) is a new card with a later date, so nothing is offered there. HR can change it.
 */
function section2Prefill(section1) {
    const s1 = section1 || {};
    const ends = s1.citizenshipStatus === 'alien_authorized_to_work' && forms.parseIsoDate(s1.workAuthorizationExpires) ? s1.workAuthorizationExpires : null;
    return { expiresOn: ends ? { employment_authorization_document: ends } : {} };
}

module.exports = {
    ADVISOR_NOTE, signerTitleOf, section2Prefill, TITLES, titleOf, documentLists, SUPPLEMENT_KINDS, SUPPLEMENT_LISTS, METHODS, MAX_SUPPLEMENTS, tailOf, maskNumber,
    publicDocument, publicSupplement, publicSection2, validateSupplementB, listRow, upcomingExpiries, summarize, findNumber,
    COPY_CATEGORY, COPY_CATEGORY_LABEL, COPY_PARTS, validateCopyMeta, daysBetween
};
