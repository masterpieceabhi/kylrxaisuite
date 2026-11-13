/** Builds the OpenAPI 3.0 document for /api/v1 from the route table in routes/api-v1.js */
const { SCOPES } = require('./api-auth');

const str = { type: 'string' }; const nstr = { type: 'string', nullable: true };
const date = { type: 'string', format: 'date', nullable: true }; const dt = { type: 'string', format: 'date-time', nullable: true };
const num = { type: 'number', nullable: true };
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });

const schemas = {
    Error: obj({ error: obj({ type: str, code: str, message: str, details: { type: 'array', items: {} }, request_id: str }) }),
    Person: obj({
        object: { type: 'string', enum: ['person'] }, schema_version: str, id: str, employee_number: nstr, status: { type: 'string', enum: ['active', 'inactive', 'pending', 'terminated'] },
        first_name: nstr, last_name: nstr, preferred_name: nstr, display_name: nstr, work_email: nstr, phone: nstr, hire_date: date, termination_date: date,
        job: obj({ title: nstr, org_unit_id: nstr, org_unit_name: nstr, location_id: nstr, manager_id: nstr, employment_type: nstr, classification: nstr, flsa_status: nstr }),
        work_state: nstr, compensation: { ...obj({ pay_type: nstr, pay_rate: num, pay_frequency: nstr, currency: str }), nullable: true, description: 'Only with the pay:read scope' },
        created_at: dt, updated_at: dt
    }),
    PersonInput: obj({
        first_name: str, last_name: str, preferred_name: str, work_email: { type: 'string', format: 'email' }, phone: str, hire_date: { type: 'string', format: 'date' },
        job: obj({ title: str, org_unit_name: str, manager_id: str }), status: { type: 'string', enum: ['active', 'inactive', 'terminated'] }, termination_date: date
    }),
    Job: obj({ object: { type: 'string', enum: ['job'] }, id: str, person_id: str, is_primary: { type: 'boolean' }, title: nstr, org_unit_id: nstr, location_id: nstr, manager_id: nstr, employment_type: nstr, classification: nstr, flsa_status: nstr, start_date: date, end_date: date, status: str, compensation: { type: 'object', nullable: true, description: 'Only with pay:read' }, updated_at: dt }),
    OrgUnit: obj({ object: { type: 'string', enum: ['org_unit'] }, id: str, name: str, code: nstr, type: str, parent_id: nstr, head_person_id: nstr, headcount: { type: 'integer' }, updated_at: dt }),
    Location: obj({ object: { type: 'string', enum: ['location'] }, id: str, name: str, type: str, address: obj({ line1: nstr, line2: nstr, city: nstr, state: nstr, postal_code: nstr, country: str }), time_zone: nstr, headcount: { type: 'integer' }, updated_at: dt }),
    TimeEntry: obj({ object: { type: 'string', enum: ['time_entry'] }, id: str, period: { type: 'string', enum: ['week', 'day'] }, person_id: str, employee_number: nstr, date: { type: 'string', format: 'date' }, end_date: { type: 'string', format: 'date' }, status: str, hours: obj({ worked: num, regular: num, overtime: num, double_time: num }), approved_at: dt, updated_at: dt }),
    TimeEntryInput: obj({ person_id: str, type: { type: 'string', enum: ['in', 'out', 'break_start', 'break_end'] }, at: { type: 'string', format: 'date-time' } }, ['person_id', 'type']),
    LeaveRequest: obj({ object: { type: 'string', enum: ['leave_request'] }, id: str, person_id: str, policy_id: nstr, policy_name: nstr, leave_type: nstr, start_date: date, end_date: date, dates: { type: 'array', items: str }, hours: num, hours_per_day: num, status: str, decided_at: dt, decided_by: nstr, created_at: dt, updated_at: dt }),
    LeaveBalance: obj({ object: { type: 'string', enum: ['leave_balance'] }, id: str, person_id: str, policy_id: str, policy_name: nstr, leave_type: nstr, as_of: date, available_hours: num, balance_hours: num, accrued_this_year_hours: num, pending_hours: num }),
    PayResult: obj({ object: { type: 'string', enum: ['pay_result'] }, id: str, person_id: nstr, pay_period: obj({ start: date, end: date }), pay_date: date, status: nstr, currency: str, gross: num, net: num, employee_taxes: num, employer_taxes: num, deductions: num, hours: num, updated_at: dt }),
    Document: obj({ object: { type: 'string', enum: ['document'] }, id: str, scope: str, category: str, title: nstr, person_id: nstr, file_name: nstr, mime_type: nstr, size_bytes: num, checksum_sha256: nstr, expires_on: date, retain_until: date, uploaded_at: dt }),
    Webhook: obj({ id: str, url: str, description: str, events: { type: 'array', items: str }, active: { type: 'boolean' }, secret_last4: nstr, created_at: dt }),
    WebhookInput: obj({ url: { type: 'string', format: 'uri' }, events: { type: 'array', items: str }, description: str }, ['url']),
    ListMeta: obj({ next_cursor: nstr, has_more: { type: 'boolean' } })
};

const parameters = {
    limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, description: 'Page size' },
    cursor: { name: 'cursor', in: 'query', schema: str, description: 'Opaque cursor from the previous page (next_cursor)' },
    updated_since: { name: 'updated_since', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Only records changed after this ISO 8601 time' },
    id: { name: 'id', in: 'path', required: true, schema: str },
    idem: { name: 'Idempotency-Key', in: 'header', schema: str, description: 'Any unique string (up to 255 chars). A retry with the same key and body returns the first response.' },
    ifMatch: { name: 'If-Match', in: 'header', schema: str, description: 'ETag from a previous GET; the update fails with 412 if the record changed' }
};

function build(routes, { baseUrl = '' } = {}) {
    const paths = {};
    for (const r of routes) {
        if (r.hidden) continue;
        const p = r.path.replace(/:([A-Za-z_]+)/g, '{$1}');
        const params = [];
        for (const name of r.pathParams || (r.path.match(/:([A-Za-z_]+)/g) || []).map((m) => m.slice(1))) params.push({ name, in: 'path', required: true, schema: str });
        for (const q of r.query || []) params.push(typeof q === 'string' ? (parameters[q] || { name: q, in: 'query', schema: str }) : q);
        if (r.write) { params.push({ $ref: '#/components/parameters/idem' }); if (r.ifMatch) params.push({ $ref: '#/components/parameters/ifMatch' }); }
        const okSchema = r.list ? obj({ data: { type: 'array', items: ref(r.response) }, next_cursor: nstr, has_more: { type: 'boolean' } })
            : r.rawResponse || (r.response ? obj({ data: ref(r.response) }) : obj({}));
        const op = {
            operationId: r.id, summary: r.summary, tags: [r.tag], parameters: params,
            ...(r.scope ? { security: [{ ApiKey: [r.scope] }, { OAuth2: [r.scope] }], 'x-required-scope': r.scope } : { security: [] }),
            ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(r.body) } } } } : {}),
            responses: {
                [r.status || 200]: { description: 'Success', ...(r.status === 204 ? {} : { content: { 'application/json': { schema: okSchema } } }) },
                ...(r.scope ? { 401: { description: 'Missing, invalid, expired or revoked credentials', content: { 'application/json': { schema: ref('Error') } } }, 403: { description: 'The key lacks the required scope', content: { 'application/json': { schema: ref('Error') } } }, 429: { description: 'Rate limit exceeded (see Retry-After)', content: { 'application/json': { schema: ref('Error') } } } } : {}),
                ...(r.write ? { 400: { description: 'Validation failed', content: { 'application/json': { schema: ref('Error') } } }, 409: { description: 'Conflict', content: { 'application/json': { schema: ref('Error') } } }, 412: { description: 'If-Match did not match', content: { 'application/json': { schema: ref('Error') } } } } : {}),
                ...(r.path.includes(':') ? { 404: { description: 'Not found (or belongs to another company)', content: { 'application/json': { schema: ref('Error') } } } } : {})
            }
        };
        (paths[p] = paths[p] || {})[r.method.toLowerCase()] = op;
    }
    return {
        openapi: '3.0.3',
        info: {
            title: 'Kylrx HR API', version: '1.0.0',
            description: 'Read and write HR data for one company. Authenticate with an API key or an OAuth 2.0 access token (Authorization: Bearer ...). Every response carries X-Request-Id; list endpoints are cursor-paginated and support updated_since; writes accept Idempotency-Key; single records carry an ETag. Dates are ISO 8601 (dates as YYYY-MM-DD, times in UTC). Sensitive data (SSN, bank, medical, EEO, date of birth, home address) is never exposed; pay fields need the pay:read scope.'
        },
        servers: [{ url: `${baseUrl}/api/v1` }],
        tags: [...new Set(routes.filter((r) => !r.hidden).map((r) => r.tag))].map((name) => ({ name })),
        paths,
        components: {
            securitySchemes: {
                ApiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'kylrx_<prefix>_<secret>', description: 'API key created by a company admin' },
                OAuth2: {
                    type: 'oauth2', description: 'Client credentials (own company) or authorization code with PKCE (partner apps; a company admin approves the scopes)',
                    flows: {
                        clientCredentials: { tokenUrl: `${baseUrl}/oauth/token`, scopes: SCOPES },
                        authorizationCode: { authorizationUrl: `${baseUrl}/oauth-consent.html`, tokenUrl: `${baseUrl}/oauth/token`, refreshUrl: `${baseUrl}/oauth/token`, scopes: SCOPES }
                    }
                }
            },
            parameters, schemas,
            headers: {
                'X-Request-Id': { schema: str, description: 'Quote this when contacting support' },
                'RateLimit-Limit': { schema: { type: 'integer' } }, 'RateLimit-Remaining': { schema: { type: 'integer' } }, 'RateLimit-Reset': { schema: { type: 'integer' }, description: 'Seconds until the window resets' }
            }
        }
    };
}

module.exports = { build, schemas };
