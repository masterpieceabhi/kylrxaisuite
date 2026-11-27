/**
 * W-2 and 1099 availability (US-F10). Read only: the provider prepares and files these forms.
 *   - which years are available per employee (W-2) and per contractor (1099)
 *   - one person's own list
 *   - the PDF, fetched by this server and passed on as bytes: the provider's file link never reaches a browser
 *
 * VERIFY against Gusto:
 *   GET /v1/employees/{id}/forms and GET /v1/contractors/{id}/forms          (list; fields uuid, name, title, year, draft)
 *   GET /v1/employees/{id}/forms/{form_id}/pdf and the contractor equivalent  (returns { uuid, document_url })
 *   that document_url can be fetched without a bearer token for a short time
 */
const X = require('./extras-rules');
const sync = require('./sync');
const contractors = require('./contractors');
const { GustoError } = require('./client');

const fail = (status, code, message) => new GustoError(message, { status, code });
const KINDS = { employee: { link: 'employee', path: 'employees', form: 'w2' }, contractor: { link: 'contractor', path: 'contractors', form: '1099' } };

async function linkFor(ctx, kind, ownerId) {
    const k = KINDS[kind];
    if (!k) throw fail(400, 'validation', 'kind must be employee or contractor');
    const link = await ctx.store.getLink(ctx.orgId, k.link, ownerId);
    return link && link.gustoUuid ? link : null;
}

/** The tax forms of one person, newest first. A person who is not at the provider simply has none. */
async function formsFor(ctx, kind, ownerId) {
    const link = await linkFor(ctx, kind, ownerId);
    if (!link) return [];
    const forms = await ctx.client.get(`/v1/${KINDS[kind].path}/${link.gustoUuid}/forms`);
    return X.taxFormsOf(forms, KINDS[kind].form);
}

/** Everyone at the provider with the years that are ready. One provider call per person; a failure for one person does not hide the others. */
async function availability(ctx) {
    const [people, contractorList, empLinks, conLinks] = await Promise.all([sync.loadPeople(ctx), contractors.loadContractors(ctx), ctx.store.listLinks(ctx.orgId, 'employee'), ctx.store.listLinks(ctx.orgId, 'contractor')]);
    const linked = (links) => new Set(links.filter((l) => l.gustoUuid).map((l) => l.ourId));
    const one = async (kind, id, name) => {
        try { const forms = await formsFor(ctx, kind, id); return { kind, id, name, forms, years: X.yearsOf(forms), error: null }; } catch (e) {
            if (e.code === 'not_connected') throw e;
            return { kind, id, name, forms: [], years: [], error: String(e.message).slice(0, 200) };
        }
    };
    const out = { employees: [], contractors: [] };
    const empIds = linked(empLinks); const conIds = linked(conLinks);
    for (const p of people.filter((x) => empIds.has(x.id)).sort((a, b) => String(a.name).localeCompare(String(b.name)))) out.employees.push(await one('employee', p.id, p.name));
    for (const c of contractorList.filter((x) => conIds.has(x.id)).sort((a, b) => String(a.name).localeCompare(String(b.name)))) out.contractors.push(await one('contractor', c.id, c.name));
    return out;
}

/**
 * The PDF of one form. The form must be on that person's own list (so an id from somebody else's list finds nothing),
 * and what comes back must really be a PDF.
 */
async function pdf(ctx, kind, ownerId, formId) {
    const link = await linkFor(ctx, kind, ownerId);
    if (!link) throw fail(404, 'not_found', 'This form was not found.');
    const list = X.taxFormsOf(await ctx.client.get(`/v1/${KINDS[kind].path}/${link.gustoUuid}/forms`), KINDS[kind].form);
    const form = list.find((f) => f.id === String(formId));
    if (!form) throw fail(404, 'not_found', 'This form was not found.');
    if (form.draft) throw fail(409, 'draft', 'This form is still a draft at the payroll provider.');
    const meta = await ctx.client.get(`/v1/${KINDS[kind].path}/${link.gustoUuid}/forms/${form.id}/pdf`);
    if (!meta || !meta.document_url) throw fail(502, 'gusto_error', 'The payroll provider did not return the file.');
    const file = await ctx.client.download(meta.document_url);
    if (file.buffer.slice(0, 5).toString('latin1') !== '%PDF-') throw fail(502, 'gusto_error', 'The payroll provider did not return a PDF.');
    const label = `${form.kind === 'w2' ? 'W-2' : '1099'}${form.year ? `-${form.year}` : ''}`;
    return { buffer: file.buffer, filename: `${label}.pdf`, form };
}

module.exports = { formsFor, availability, pdf };
