/**
 * Team import for US companies (pure, no I/O).
 *
 * A new company pastes rows from Excel or Google Sheets, or picks a CSV / Excel file exported from its old payroll tool.
 * This module reads the pasted text, guesses which of their columns is which of our fields, understands the common ways
 * dates, money, states and yes/no style values are written, and says in plain words what is wrong with each row.
 * The routes then hand the good rows to the same validation and creation the "add one employee" form uses.
 *
 * IMPORTANT: the header synonym lists below are GUESSES written from general knowledge of how payroll tools (Gusto, ADP,
 * QuickBooks, Paychex and similar) name their export columns. They were not checked against real export files, and
 * those tools rename columns from time to time. That is why the page always shows the guess and lets the user change it.
 *
 * Social Security numbers: a column that looks like SSNs is reported (ssnColumns) and is never imported unless the
 * caller says so explicitly (options.ssn === 'import').
 */
const V = require('./us-validation');
const { parseIsoDate } = require('./us-forms');

const MAX_ROWS = 500;
const MAX_COLUMNS = 80;
const MAX_CELL = 300;

/** Our fields, in the order the page shows them. `profile` fields belong to the US profile. */
const FIELDS = [
    { key: 'first_name', label: 'First name', required: true },
    { key: 'last_name', label: 'Last name', required: true },
    { key: 'full_name', label: 'Full name (we split it)' },
    { key: 'middle_name', label: 'Middle name', profile: true },
    { key: 'email', label: 'Email', required: true },
    { key: 'phone', label: 'Phone' },
    { key: 'start_date', label: 'First day of work', required: true },
    { key: 'job_title', label: 'Job title' },
    { key: 'department', label: 'Department' },
    { key: 'role', label: 'Role in this app' },
    { key: 'employee_number', label: 'Employee number (from your old system)' },
    { key: 'work_state', label: 'Work state', profile: true },
    { key: 'classification', label: 'W-2 employee or 1099 contractor', profile: true },
    { key: 'flsa_status', label: 'Overtime status (exempt or non-exempt)', profile: true },
    { key: 'employment_type', label: 'Full time or part time', profile: true },
    { key: 'pay_type', label: 'Pay type (hourly or salary)', profile: true },
    { key: 'pay_rate', label: 'Pay rate', profile: true },
    { key: 'pay_frequency', label: 'How often paid', profile: true },
    { key: 'date_of_birth', label: 'Date of birth', profile: true },
    { key: 'address_line1', label: 'Home address', profile: true },
    { key: 'address_line2', label: 'Apartment or unit', profile: true },
    { key: 'city', label: 'City', profile: true },
    { key: 'state', label: 'Home state', profile: true },
    { key: 'zip', label: 'ZIP code', profile: true },
    { key: 'ssn', label: 'Social Security number', profile: true, sensitive: true }
];
const FIELD_KEYS = FIELDS.map((f) => f.key);
const LABELS = Object.fromEntries(FIELDS.map((f) => [f.key, f.label]));
const IGNORE = 'ignore';

/**
 * Header names seen in payroll exports, lower case with everything but letters and digits removed.
 * GUESSES from general knowledge (see the note at the top of this file).
 */
const SYNONYMS = {
    first_name: ['firstname', 'first', 'fname', 'givenname', 'legalfirstname', 'employeefirstname', 'preferredfirstname', 'forename', 'nombre', 'firstnamelegal', 'workerfirstname'],
    last_name: ['lastname', 'last', 'lname', 'surname', 'familyname', 'legallastname', 'employeelastname', 'apellido', 'apellidos', 'lastnamelegal', 'workerlastname'],
    full_name: ['name', 'fullname', 'employeename', 'employee', 'legalname', 'payeename', 'workername', 'associatename', 'displayname', 'staffname', 'teammember', 'employeefullname', 'worker', 'associate', 'namelastfirst', 'lastnamefirstname', 'payrollname', 'preferredname'],
    middle_name: ['middlename', 'middleinitial', 'mi', 'middle', 'legalmiddlename'],
    email: ['email', 'emailaddress', 'workemail', 'personalemail', 'employeeemail', 'homeemail', 'primaryemail', 'contactemail', 'emailwork', 'emailpersonal', 'workemailaddress', 'personalemailaddress', 'correo', 'correoelectronico'],
    phone: ['phone', 'phonenumber', 'mobile', 'mobilephone', 'mobilenumber', 'cell', 'cellphone', 'cellnumber', 'homephone', 'workphone', 'primaryphone', 'telephone', 'contactnumber', 'personalphone', 'personalmobile', 'telefono'],
    start_date: ['startdate', 'hiredate', 'dateofhire', 'datehired', 'originalhiredate', 'employmentstartdate', 'firstday', 'firstdayofwork', 'joiningdate', 'dateofjoining', 'servicedate', 'started', 'hired', 'employeestartdate', 'mostrecenthiredate', 'hiredon', 'fechadeinicio'],
    job_title: ['jobtitle', 'title', 'position', 'positiontitle', 'job', 'occupation', 'jobname', 'designation', 'jobtitledescription', 'workertitle', 'businesstitle', 'puesto'],
    department: ['department', 'dept', 'departmentname', 'homedepartment', 'team', 'division', 'homedepartmentdescription', 'departmentdescription', 'departamento'],
    role: ['role', 'accessrole', 'permission', 'permissionlevel', 'userrole', 'accesslevel', 'systemrole', 'approle', 'accountrole'],
    employee_number: ['employeenumber', 'employeeid', 'empid', 'employeeno', 'empno', 'filenumber', 'associateid', 'positionid', 'payrollid', 'badgenumber', 'workerid', 'employeecode', 'id', 'clocknumber', 'employeenum', 'payrollnumber', 'badgeid', 'filenum'],
    work_state: ['workstate', 'stateworkedin', 'workedinstate', 'worklocationstate', 'taxstate', 'workstatecode', 'suistate', 'workedstate', 'statetax', 'workedinstatetaxcode', 'workinstate'],
    classification: ['classification', 'workertype', 'taxform', 'w21099', 'workercategory', 'employeeorcontractor', 'workerclassification', 'taxclassification', 'employeetype', 'contractor'],
    flsa_status: ['flsastatus', 'flsa', 'flsaclassification', 'exemptstatus', 'overtimestatus', 'exempt', 'overtimeeligible', 'flsacode', 'flsadescription', 'exemptnonexempt', 'overtime'],
    employment_type: ['employmenttype', 'fulltimeparttime', 'ftpt', 'fullorparttime', 'fullparttime', 'workerstatus', 'employmentstatus', 'ptft', 'fullpart', 'employmentcategory', 'workschedule'],
    pay_type: ['paytype', 'compensationtype', 'payratetype', 'ratetype', 'wagetype', 'salaryorhourly', 'hourlyorsalary', 'employeepaytype', 'paybasis', 'payunit', 'rateper', 'rateunit', 'per', 'regularpayratedescription', 'compensationper', 'paymentunit', 'salaryhourly'],
    pay_rate: ['payrate', 'rate', 'hourlyrate', 'wage', 'salary', 'annualsalary', 'compensation', 'basepay', 'basesalary', 'regularpayrate', 'regularpayrateamount', 'rateamount', 'payamount', 'hourlywage', 'amount', 'rate1', 'compensationamount', 'wagerate', 'currentrate', 'ratesalary'],
    pay_frequency: ['payfrequency', 'payschedule', 'frequency', 'payperiod', 'paycycle', 'payfrequencycode', 'payfrequencydescription', 'paidevery', 'payperiodfrequency'],
    date_of_birth: ['dateofbirth', 'dob', 'birthdate', 'birthday', 'birth', 'fechadenacimiento', 'borndate'],
    address_line1: ['address', 'addressline1', 'address1', 'street', 'streetaddress', 'homeaddress', 'street1', 'addressstreet', 'line1', 'mailingaddress', 'residentialaddress', 'streetaddress1', 'homeaddressline1', 'legaladdress', 'primaryaddress', 'primaryaddressline1', 'addressone'],
    address_line2: ['addressline2', 'address2', 'apt', 'suite', 'unit', 'street2', 'line2', 'streetaddress2', 'apartment', 'aptsuite', 'homeaddressline2', 'primaryaddressline2', 'addresstwo'],
    city: ['city', 'town', 'homecity', 'addresscity', 'primaryaddresscity', 'ciudad'],
    state: ['state', 'homestate', 'addressstate', 'province', 'stateprovince', 'residentstate', 'stateofresidence', 'livedinstate', 'primaryaddressstate', 'stateorprovince', 'livedinstatecode', 'estado'],
    zip: ['zip', 'zipcode', 'postalcode', 'postal', 'postcode', 'homezip', 'addresszip', 'zippostalcode', 'primaryaddresszip', 'zipcode5', 'codigopostal'],
    ssn: ['ssn', 'socialsecuritynumber', 'socialsecurity', 'taxid', 'taxpayerid', 'taxidssn', 'ssnitin', 'social', 'itin', 'ssnumber', 'socsec', 'tin', 'socialsecurityno', 'ssno', 'taxidnumber', 'ssntaxid', 'socialsecuritynum', 'sin', 'taxidtype ssn']
};
Object.keys(SYNONYMS).forEach((k) => { SYNONYMS[k] = SYNONYMS[k].map((s) => s.replace(/[^a-z0-9]/g, '')); });

/** Columns about somebody else or about money accounts: never guessed, the user can still map them by hand */
const NOT_THE_PERSON = /(manager|supervisor|reportsto|emergency|spouse|dependent|beneficiary|bank|routing|account|termination|terminated|enddate|rehire|lastpaid|lastday|previous|former|maiden|company|employer|client|worklocationname)/;

/** Short names that turn up inside unrelated headers ("payrollname" holds "lname"); they only count as the whole header */
const TOO_LOOSE = new Set(['fname', 'lname', 'first', 'hired', 'birth', 'social', 'amount', 'worker', 'exempt', 'street', 'title']);

const normHeader = (h) => String(h === undefined || h === null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
const cell = (v) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_CELL);

// ---------------------------------------------------------------------------------------------------------- reading text

/**
 * Text copied from Excel or Google Sheets (tabs between cells) or CSV text (commas, quotes) -> rows of cells.
 * Cells in quotes may hold tabs, commas, line breaks and doubled quotes.
 */
function parsePasted(text) {
    const src = String(text === undefined || text === null ? '' : text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (!src.trim()) return [];
    const firstLine = src.split('\n').find((l) => l.trim()) || '';
    const count = (ch) => firstLine.split(ch).length - 1;
    const sep = count('\t') > 0 ? '\t' : (count(';') > count(',') ? ';' : ',');
    const rows = []; let row = []; let cur = ''; let quoted = false; let wasQuoted = false;
    const endCell = () => { row.push(wasQuoted ? cur : cur.trim()); cur = ''; wasQuoted = false; };
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false; } else cur += ch;
        } else if (ch === '"' && cur.trim() === '') { quoted = true; wasQuoted = true; cur = ''; } else if (ch === sep) endCell();
        else if (ch === '\n') { endCell(); rows.push(row); row = []; } else cur += ch;
    }
    endCell(); rows.push(row);
    return rows.map((r) => r.map(cell)).filter((r) => r.some((c) => c !== ''));
}

/** Trims every cell, drops empty rows, makes every row the same width, and enforces the size limits */
function cleanTable(table) {
    const errors = [];
    if (!Array.isArray(table)) return { errors: ['Nothing to read'], rows: [] };
    let rows = table.filter((r) => Array.isArray(r)).map((r) => r.slice(0, MAX_COLUMNS + 1).map(cell)).filter((r) => r.some((c) => c !== ''));
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (width > MAX_COLUMNS) errors.push(`That sheet has more than ${MAX_COLUMNS} columns. Delete the columns you do not need and try again.`);
    if (rows.length > MAX_ROWS + 1) errors.push(`At most ${MAX_ROWS} people at a time. Split the sheet and add the rest in a second round.`);
    rows = rows.map((r) => { const out = r.slice(); while (out.length < width) out.push(''); return out; });
    return { errors, rows };
}

// ------------------------------------------------------------------------------------------------------- reading values

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;
const SSN_DASHED = /^\d{3}[- ]\d{2}[- ]\d{4}$/;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    ene: 1, abr: 4, ago: 8, dic: 12, enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

const pad = (n) => String(n).padStart(2, '0');
function iso(y, m, d) {
    const s = `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
    return parseIsoDate(s) ? s : null;
}

/** A two-digit year: a birth year is never in the future; other dates may be up to 5 years ahead */
function fullYear(yy, birth, todayYear) {
    const cur = todayYear % 100; const century = todayYear - cur;
    const limit = birth ? cur : cur + 5;
    return yy > limit ? century - 100 + yy : century + yy;
}

/**
 * Understands 1/17/2025, 01-17-25, 2025-01-17, 2025/1/17, Jan 17 2025, January 17, 2025, 17 Jan 2025, 17-Jan-25,
 * a date with a time after it, and the day numbers Excel uses for dates. US order (month first) unless the first
 * number can only be a day. Returns YYYY-MM-DD, or null when it is not a real date.
 */
function parseDate(value, { birth = false, today = new Date() } = {}) {
    let s = cell(value);
    if (!s) return null;
    const todayYear = today.getUTCFullYear();
    s = s.replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm|z|[+-]\d{2}:?\d{2})?$/i, '').trim();
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s);
    if (m) {
        const y = m[3].length === 2 ? fullYear(+m[3], birth, todayYear) : +m[3];
        let mo = +m[1]; let d = +m[2];
        if (mo > 12 && d <= 12) { const t = mo; mo = d; d = t; } // 17/1/2025 can only be day first
        return iso(y, mo, d);
    }
    const word = (w) => MONTHS[String(w).toLowerCase().replace(/\.$/, '')];
    m = /^([A-Za-z]{3,10}\.?)[ -]+(\d{1,2})(?:st|nd|rd|th)?,?[ -]+(\d{4}|\d{2})$/.exec(s);
    if (m && word(m[1])) return iso(m[3].length === 2 ? fullYear(+m[3], birth, todayYear) : +m[3], word(m[1]), +m[2]);
    m = /^(\d{1,2})(?:st|nd|rd|th)?[ -]+(?:de )?([A-Za-z]{3,10}\.?),?[ -]+(?:de )?(\d{4}|\d{2})$/.exec(s);
    if (m && word(m[2])) return iso(m[3].length === 2 ? fullYear(+m[3], birth, todayYear) : +m[3], word(m[2]), +m[1]);
    // Excel stores a date as the number of days since 1899-12-30; only whole numbers in a sensible range count
    if (/^\d{4,5}(\.0+)?$/.test(s)) {
        const n = Math.floor(Number(s));
        if (n >= 3654 && n <= 73050) { // 1910-01-01 .. 2099-12-31
            const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
            return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
        }
    }
    return null;
}

/** "$18.50", "18.5", "1,250.00", "$52,000 / year", "52k", "USD 20" -> a positive number with 2 decimals, or null */
function parseMoney(value) {
    let s = cell(value).toLowerCase();
    if (!s) return null;
    s = s.replace(/usd|us\$|\$/g, '').replace(/\s*(\/|per|an|a)\s*(hour|hr|h|year|yr|annum|month|week)\.?$/i, '').replace(/\s*(hourly|annually|yearly)$/i, '').trim();
    let mult = 1;
    const k = /^([\d.,]+)\s*k$/.exec(s);
    if (k) { s = k[1]; mult = 1000; }
    if (!/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(s) && !/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
    const n = Number(s.replace(/,/g, '')) * mult;
    if (!Number.isFinite(n) || n <= 0 || n > 100000000) return null;
    return Math.round(n * 100) / 100;
}

const STATE_NAMES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', 'washington dc': 'DC', 'washington d.c.': 'DC',
    florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
    mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
    oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
    wyoming: 'WY', 'puerto rico': 'PR', guam: 'GU', 'virgin islands': 'VI', 'u.s. virgin islands': 'VI', 'american samoa': 'AS', 'northern mariana islands': 'MP' };

/** "tx", "Texas", "TX - Texas" -> "TX"; null when it is not a state or territory this app knows */
function parseState(value) {
    const s = cell(value);
    if (!s) return null;
    const up = s.toUpperCase();
    if (V.US_STATES.includes(up)) return up;
    const lead = /^([A-Za-z]{2})\s*[-–(]/.exec(s);
    if (lead && V.US_STATES.includes(lead[1].toUpperCase())) return lead[1].toUpperCase();
    const code = STATE_NAMES[s.toLowerCase().replace(/\s+/g, ' ')];
    return code && V.US_STATES.includes(code) ? code : null;
}

const words = (v) => cell(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const pick = (table) => (value) => { const w = words(value); if (!w) return null; return Object.prototype.hasOwnProperty.call(table, w) ? table[w] : null; };

const parsePayType = pick({ hourly: 'hourly', hour: 'hourly', hr: 'hourly', h: 'hourly', 'per hour': 'hourly', 'paid by the hour': 'hourly', 'hourly rate': 'hourly', 'hourly non exempt': 'hourly', 'por hora': 'hourly',
    salary: 'salary', salaried: 'salary', s: 'salary', year: 'salary', annual: 'salary', annually: 'salary', 'per year': 'salary', yearly: 'salary', 'salary no overtime': 'salary', 'salary eligible for overtime': 'salary', 'salary exempt': 'salary', 'salary non exempt': 'salary', salario: 'salary' });
const parseClassification = pick({ w2: 'W2', 'w 2': 'W2', employee: 'W2', 'w2 employee': 'W2', 'w 2 employee': 'W2', ee: 'W2', regular: 'W2', 'regular employee': 'W2',
    1099: '1099', contractor: '1099', 'independent contractor': '1099', '1099 contractor': '1099', '1099 nec': '1099', 'contractor 1099': '1099', vendor: '1099', freelancer: '1099' });
const parseFlsa = pick({ exempt: 'exempt', e: 'exempt', 'salary no overtime': 'exempt', 'no overtime': 'exempt', 'not eligible': 'exempt', 'exempt salaried': 'exempt',
    'non exempt': 'non_exempt', nonexempt: 'non_exempt', n: 'non_exempt', ne: 'non_exempt', 'not exempt': 'non_exempt', 'overtime eligible': 'non_exempt', eligible: 'non_exempt', 'paid by the hour': 'non_exempt', 'salary eligible for overtime': 'non_exempt' });
const parseEmploymentType = pick({ 'full time': 'full_time', fulltime: 'full_time', ft: 'full_time', f: 'full_time', full: 'full_time', 'regular full time': 'full_time', 'tiempo completo': 'full_time',
    'part time': 'part_time', parttime: 'part_time', pt: 'part_time', p: 'part_time', part: 'part_time', 'regular part time': 'part_time', 'medio tiempo': 'part_time',
    seasonal: 'seasonal', temporary: 'temporary', temp: 'temporary' });
const parsePayFrequency = pick({ weekly: 'weekly', 'every week': 'weekly', w: 'weekly', 'bi weekly': 'biweekly', biweekly: 'biweekly', 'every other week': 'biweekly', 'every 2 weeks': 'biweekly', 'every two weeks': 'biweekly', b: 'biweekly',
    'semi monthly': 'semimonthly', semimonthly: 'semimonthly', 'twice a month': 'semimonthly', 'twice per month': 'semimonthly', s: 'semimonthly', monthly: 'monthly', 'every month': 'monthly', m: 'monthly' });
const parseRole = pick({ employee: 'employee', staff: 'employee', worker: 'employee', user: 'employee', 'team member': 'employee', member: 'employee', empleado: 'employee',
    manager: 'manager', supervisor: 'manager', 'team lead': 'manager', lead: 'manager', gerente: 'manager',
    'hr admin': 'hr_admin', hr: 'hr_admin', 'hr administrator': 'hr_admin', admin: 'hr_admin', administrator: 'hr_admin', 'human resources': 'hr_admin', 'hr manager': 'hr_admin' });

/** "Lopez, Maria" / "Maria Lopez" / "Maria Elena Lopez Garcia" -> first and last. One word alone cannot be split. */
function splitFullName(value) {
    const s = cell(value);
    if (!s) return null;
    if (s.includes(',')) {
        const [last, ...rest] = s.split(',');
        const first = rest.join(' ').replace(/\s+/g, ' ').trim();
        return first && last.trim() ? { first, last: last.trim() } : null;
    }
    const parts = s.split(' ').filter(Boolean).filter((p, i, all) => !(i === all.length - 1 && all.length > 2 && /^(jr|sr|ii|iii|iv)\.?$/i.test(p)));
    if (parts.length < 2) return null;
    return { first: parts[0], last: parts.slice(1).join(' ') };
}

const phoneDigits = (v) => cell(v).replace(/(ext|x)\.?\s*\d+$/i, '').replace(/\D/g, '');
const looksLikePhone = (v) => { const d = phoneDigits(v); return (d.length === 10 || (d.length === 11 && d[0] === '1')) && /^[\d\s().+-]+$/.test(cell(v).replace(/(ext|x)\.?\s*\d+$/i, '')); };

// ------------------------------------------------------------------------------------------------------- guessing

/** Is the first row a header? Not when it holds an email address, a date or a dollar amount. */
function hasHeaderRow(rows) {
    if (!rows.length) return false;
    const first = rows[0];
    if (first.some((c) => EMAIL.test(c) || SSN_DASHED.test(c) || /^\$?\d[\d,]*(\.\d+)?$/.test(c) || parseDate(c))) return false;
    return first.some((c) => guessFromHeader(c) !== null) || rows.length === 1 || first.every((c) => c === '' || /[A-Za-z]/.test(c));
}

/** The field a header names, or null. Exact names first; then the longest known name the header contains. */
function guessFromHeader(header) {
    const h = normHeader(header);
    if (!h) return null;
    for (const key of FIELD_KEYS) if (SYNONYMS[key].includes(h)) return key;
    if (NOT_THE_PERSON.test(h)) return null;
    let best = null; let bestLen = 0;
    for (const key of FIELD_KEYS) {
        for (const syn of SYNONYMS[key]) {
            if (syn.length >= 5 && !TOO_LOOSE.has(syn) && syn.length > bestLen && h.includes(syn)) { best = key; bestLen = syn.length; }
        }
    }
    if (!best && h.endsWith('name')) return 'full_name'; // "Payroll name", "Staff member name"
    return best;
}

/** What the cells of a column look like (most of the filled cells must agree) */
function guessFromCells(cells, today = new Date()) {
    const filled = cells.map(cell).filter(Boolean);
    if (!filled.length) return null;
    const share = (test) => filled.filter(test).length / filled.length;
    const most = (test) => share(test) >= 0.7;
    if (most((c) => EMAIL.test(c))) return 'email';
    if (most((c) => SSN_DASHED.test(c))) return 'ssn';
    if (most((c) => /^\d{5}(-\d{4})?$/.test(c))) return 'zip';
    if (most(looksLikePhone)) return 'phone';
    if (most((c) => /^\$\s?\d/.test(c) && parseMoney(c) !== null)) return 'pay_rate';
    if (most((c) => !/^\d+(\.\d+)?$/.test(c) && parseDate(c, { today }) !== null)) {
        const cutoff = today.getUTCFullYear() - 14;
        const old = filled.filter((c) => { const d = parseDate(c, { birth: true, today }); return d && Number(d.slice(0, 4)) <= cutoff; }).length;
        return old / filled.length >= 0.7 ? 'date_of_birth' : 'start_date';
    }
    if (most((c) => /^[A-Za-z]{2}$/.test(c) && parseState(c))) return 'work_state';
    if (most((c) => /hour|salar/i.test(c) && parsePayType(c))) return 'pay_type';
    if (most((c) => /w-?\s?2|1099|contractor/i.test(c) && parseClassification(c))) return 'classification';
    if (most((c) => /exempt/i.test(c) && parseFlsa(c))) return 'flsa_status';
    if (most((c) => /(full|part)/i.test(c) && parseEmploymentType(c))) return 'employment_type';
    if (most((c) => /week|month/i.test(c) && parsePayFrequency(c))) return 'pay_frequency';
    return null;
}

/**
 * Guesses the field for every column. Each field is used once; a column nobody claims is "ignore".
 * Returns { hasHeader, columns: [{ index, header, field, why: 'header' | 'content' | 'none', sample }], ssnColumns: [index] }.
 */
function guessMapping(rows, { today = new Date(), headerRow } = {}) {
    const hasHeader = headerRow === undefined ? hasHeaderRow(rows) : Boolean(headerRow);
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const header = hasHeader ? rows[0] : [];
    const body = hasHeader ? rows.slice(1) : rows;
    const sample = body.slice(0, 50);
    const columns = []; const used = new Set();
    const col = (i) => sample.map((r) => r[i] || '');
    const claim = (c, field, why) => { if (c.field !== IGNORE || used.has(field)) return false; c.field = field; c.why = why; used.add(field); return true; };

    for (let i = 0; i < width; i++) {
        columns.push({ index: i, header: cell(header[i]) || `Column ${i + 1}`, field: IGNORE, why: 'none', sample: (col(i).find((v) => cell(v)) || '') });
    }
    const fromCells = columns.map((c) => guessFromCells(col(c.index), today));
    const ssnColumns = columns.filter((c, i) => fromCells[i] === 'ssn' || SYNONYMS.ssn.includes(normHeader(header[c.index]))).map((c) => c.index);

    // 1. header names (exact names first, so "State" is not taken by a looser match)
    const exact = (c) => { const h = normHeader(header[c.index]); return FIELD_KEYS.find((k) => SYNONYMS[k].includes(h)) || null; };
    for (const pass of [exact, (c) => guessFromHeader(header[c.index])]) {
        columns.forEach((c, i) => {
            if (c.field !== IGNORE) return;
            let field = pass(c);
            if (!field) return;
            const seen = fromCells[i];
            // headers that mean different things in different tools: let the cells decide
            if (field === 'role' && !col(i).map(cell).filter(Boolean).every((v) => parseRole(v))) field = 'job_title';
            if (field === 'classification' && seen === 'employment_type') field = 'employment_type';
            if (field === 'employment_type' && seen === 'classification') field = 'classification';
            if (field === 'employment_type' && seen === null && col(i).map(cell).filter(Boolean).some((v) => !parseEmploymentType(v))) return; // "Employment status: Active"
            if (field === 'flsa_status' && seen === 'pay_type' && !used.has('pay_type')) field = 'pay_type';
            if (field === 'full_name' && seen && seen !== 'full_name') return;
            if (field === 'full_name' && pass !== exact && !col(i).map(cell).filter(Boolean).every((v) => splitFullName(v))) return; // a team name, say
            if (field === 'employee_number' && seen === 'email') field = 'email';
            if (field !== 'ssn' && seen === 'ssn') return; // never file SSNs under another name
            // a loose header match that the cells contradict ("First pay date" is not a first name) is dropped
            const kin = [['state', 'work_state'], ['start_date', 'date_of_birth'], ['pay_type', 'flsa_status'], ['classification', 'employment_type']];
            if (pass !== exact && seen && seen !== field && !kin.some((k) => k.includes(seen) && k.includes(field))) return;
            claim(c, field, 'header');
        });
    }
    // 2. what the cells look like
    columns.forEach((c, i) => {
        if (c.field !== IGNORE || !fromCells[i]) return;
        if (NOT_THE_PERSON.test(normHeader(header[c.index]))) return;
        let field = fromCells[i];
        if (field === 'work_state' && used.has('work_state')) field = 'state';
        if (field === 'start_date' && used.has('start_date')) return;
        claim(c, field, 'content');
    });
    // 3. a full name makes no sense next to separate first and last names
    if (used.has('first_name') && used.has('last_name')) columns.forEach((c) => { if (c.field === 'full_name') { c.field = IGNORE; c.why = 'none'; } });
    // 4. no name column found by its header: a column of "Two Words" is probably the name
    if (!used.has('full_name') && !(used.has('first_name') && used.has('last_name'))) {
        const c = columns.find((x, i) => x.field === IGNORE && !fromCells[i] && !NOT_THE_PERSON.test(normHeader(header[x.index]))
            && col(x.index).map(cell).filter(Boolean).length > 0 && col(x.index).map(cell).filter(Boolean).every((v) => /^[^\d@]+$/.test(v) && splitFullName(v)));
        if (c && !used.has('first_name') && !used.has('last_name')) claim(c, 'full_name', 'content');
    }
    return { hasHeader, columns, ssnColumns, rowCount: body.length };
}

/** Checks a mapping sent back by the page: one field name per column, each field at most once */
function validateMapping(fields, width) {
    const errors = [];
    if (!Array.isArray(fields) || fields.length !== width) return { errors: ['Choose a field (or "Do not import") for every column'], value: [] };
    const seen = new Set();
    const value = fields.map((f) => (FIELD_KEYS.includes(f) ? f : IGNORE));
    value.forEach((f) => { if (f !== IGNORE) { if (seen.has(f)) errors.push(`"${LABELS[f]}" is chosen for more than one column`); seen.add(f); } });
    const hasName = seen.has('full_name') || (seen.has('first_name') && seen.has('last_name'));
    if (!hasName) errors.push('Choose which column holds the name (first and last name, or the full name)');
    if (!seen.has('email')) errors.push('Choose which column holds the email address. Each person signs in with their email.');
    return { errors: [...new Set(errors)], value };
}

/** Rows of cells + one field per column -> one object per person: { field: what was typed } */
function applyMapping(bodyRows, fields) {
    return bodyRows.map((r) => {
        const person = {};
        fields.forEach((f, i) => { if (f !== IGNORE && cell(r[i]) !== '') person[f] = cell(r[i]); });
        return person;
    });
}

// ------------------------------------------------------------------------------------------------- checking one person

const FULL_PROFILE_NEEDS = ['date_of_birth', 'address_line1', 'city', 'state', 'zip', 'work_state', 'classification', 'pay_type', 'pay_rate'];

/**
 * One person as typed -> tidy values, the problems (each tied to a field so the page can mark the cell) and notes.
 *   options.ssn            'import' keeps the SSN; anything else drops it (and says so in ssnDropped)
 *   options.defaultStartDate  used when the row has no first day of work
 * values hold what will be saved: dates as YYYY-MM-DD, states as two letters, pay as a plain number, and so on.
 * A value that cannot be understood stays as typed, with a problem on that field.
 */
function normalizePerson(raw, options = {}) {
    const today = options.today || new Date();
    const src = {}; Object.keys(raw || {}).forEach((k) => { if (FIELD_KEYS.includes(k) && cell(raw[k]) !== '') src[k] = cell(raw[k]); });
    const values = {}; const problems = []; const notes = [];
    const bad = (field, message) => problems.push({ field, message });
    let ssnDropped = false;

    // name
    if (src.full_name && !(src.first_name && src.last_name)) {
        const n = splitFullName(src.full_name);
        if (n) { values.first_name = src.first_name || n.first; values.last_name = src.last_name || n.last; } else { values.first_name = src.first_name || src.full_name; if (src.last_name) values.last_name = src.last_name; }
    } else { if (src.first_name) values.first_name = src.first_name; if (src.last_name) values.last_name = src.last_name; }
    ['first_name', 'last_name'].forEach((f) => { if (values[f]) values[f] = values[f].replace(/[<>]/g, '').slice(0, 80); });
    if (!values.first_name) bad('first_name', 'First name is missing');
    if (!values.last_name) bad('last_name', 'Last name is missing');
    if (src.middle_name) values.middle_name = src.middle_name.replace(/[<>]/g, '').slice(0, 80);

    // email
    if (!src.email) bad('email', 'Email is missing. Each person signs in with their own email.');
    else { values.email = src.email.toLowerCase().replace(/^mailto:/, ''); if (!EMAIL.test(values.email)) bad('email', 'This does not look like an email address'); }

    // phone
    if (src.phone) {
        const d = phoneDigits(src.phone); const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
        if (ten.length === 10) values.phone = `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
        else { values.phone = src.phone; bad('phone', 'A US phone number has 10 digits. Fix it or clear the cell.'); }
    }

    // first day of work
    const start = src.start_date || options.defaultStartDate || '';
    if (!start) bad('start_date', 'First day of work is missing');
    else {
        const d = parseDate(start, { today });
        if (d) { values.start_date = d; if (!src.start_date) notes.push('First day of work was empty, so the date you chose for everyone was used'); } else { values.start_date = start; bad('start_date', 'This is not a date we can read. Use a form like 1/17/2025 or 2025-01-17.'); }
    }

    ['job_title', 'department', 'employee_number'].forEach((f) => { if (src[f]) values[f] = src[f].replace(/[<>]/g, '').slice(0, 120); });

    if (src.role) {
        const r = parseRole(src.role);
        if (r) values.role = r; else { values.role = src.role; bad('role', 'Role must be Employee, Manager or HR admin. Clear the cell to add the person as an employee.'); }
    }

    const choice = (field, parser, message) => {
        if (!src[field]) return;
        const v = parser(src[field]);
        if (v !== null) values[field] = String(v); else { values[field] = src[field]; bad(field, message); }
    };
    choice('work_state', parseState, 'Work state must be a US state, like TX or Texas');
    choice('state', parseState, 'Home state must be a US state, like TX or Texas');
    choice('classification', parseClassification, 'Write W2 for an employee or 1099 for a contractor');
    choice('flsa_status', parseFlsa, 'Write exempt or non-exempt');
    choice('employment_type', parseEmploymentType, 'Write full time, part time, seasonal or temporary');
    choice('pay_type', parsePayType, 'Write hourly or salary');
    choice('pay_frequency', parsePayFrequency, 'Write weekly, biweekly, semimonthly or monthly');
    if (src.pay_rate) {
        const n = parseMoney(src.pay_rate);
        if (n !== null) values.pay_rate = n.toFixed(2); else { values.pay_rate = src.pay_rate; bad('pay_rate', 'Pay rate must be an amount like 18.50 or $52,000'); }
    }
    if (src.date_of_birth) {
        const d = parseDate(src.date_of_birth, { birth: true, today });
        if (!d) { values.date_of_birth = src.date_of_birth; bad('date_of_birth', 'This is not a date we can read. Use a form like 5/20/1991.'); } else {
            values.date_of_birth = d;
            const age = (today.getTime() - parseIsoDate(d).getTime()) / (365.25 * 86400000);
            if (age < 14 || age > 110) bad('date_of_birth', 'Check this date of birth: the person would be younger than 14 or older than 110');
        }
    }
    ['address_line1', 'address_line2', 'city'].forEach((f) => { if (src[f]) values[f] = src[f].replace(/[<>]/g, '').slice(0, 120); });
    if (src.zip) {
        let z = src.zip;
        if (/^\d{4}$/.test(z)) z = `0${z}`; // spreadsheets drop the leading zero of New England ZIP codes
        if (/^\d{9}$/.test(z)) z = `${z.slice(0, 5)}-${z.slice(5)}`;
        values.zip = z;
        if (!V.validateZip(z)) bad('zip', 'ZIP code must look like 78701 or 78701-1234');
        else if (z !== src.zip) notes.push('ZIP code was tidied (a leading zero or the dash was put back)');
    }

    // Social Security number: only when the administrator said yes
    if (src.ssn) {
        if (options.ssn === 'import') {
            const t = V.validateTaxpayerId(src.ssn, 'SSN');
            const itin = t.valid ? null : V.validateTaxpayerId(src.ssn, 'ITIN');
            values.ssn = src.ssn;
            if (!t.valid && !(itin && itin.valid)) bad('ssn', 'This is not a valid Social Security number or ITIN. Fix it or clear the cell: the person can enter it later.');
        } else ssnDropped = true;
    }

    // pay rate needs to say what it is a rate of
    if (values.pay_rate && !values.pay_type && !problems.some((p) => p.field === 'pay_rate')) notes.push('Pay rate was not saved because the sheet does not say if it is hourly or salary. Add a pay type, or set it later on the People page.');
    if (values.flsa_status === 'exempt' && values.pay_type === 'hourly') bad('flsa_status', 'A person paid by the hour cannot be exempt from overtime. Change one of the two.');
    if (values.classification === '1099' && values.flsa_status) { delete values.flsa_status; notes.push('Overtime status was left out because it applies to W-2 employees only'); }

    const full = FULL_PROFILE_NEEDS.every((f) => values[f]) && (values.classification !== 'W2' || Boolean(values.flsa_status));
    return { values, problems, notes, ssnDropped, profile: full ? 'full' : (FIELDS.some((f) => f.profile && values[f.key]) ? 'partial' : 'none') };
}

/**
 * Tidy values -> the input services/us-people-service.validatePerson expects, plus the profile pieces to keep when the
 * row does not hold a whole profile (the person and HR complete it later).
 */
function toPersonInput(n) {
    const v = n.values;
    const input = { firstName: v.first_name || '', lastName: v.last_name || '', email: v.email || '', phone: v.phone || '', role: v.role || 'employee', startDate: v.start_date || '', jobTitle: v.job_title || '', department: v.department || '' };
    const fieldsWithProblems = new Set(n.problems.map((p) => p.field));
    const ok = (f) => v[f] && !fieldsWithProblems.has(f);
    let partialProfile = null; let taxpayerId = null;
    if (ok('ssn')) taxpayerId = { value: v.ssn, type: V.validateTaxpayerId(v.ssn, 'SSN').valid ? 'SSN' : 'ITIN' };
    if (n.profile === 'full') {
        input.profile = {
            dateOfBirth: v.date_of_birth, homeAddress: { line1: v.address_line1, line2: v.address_line2 || '', city: v.city, state: v.state, zip: v.zip },
            workState: v.work_state, classification: v.classification, flsaStatus: v.classification === 'W2' ? v.flsa_status : undefined,
            employmentType: v.employment_type || 'full_time', payType: v.pay_type, payFrequency: v.pay_frequency || 'biweekly', payRate: v.pay_rate,
            legalMiddleName: v.middle_name || undefined, taxpayerId: taxpayerId ? taxpayerId.value : undefined, taxpayerIdType: taxpayerId ? taxpayerId.type : 'SSN'
        };
    } else if (n.profile === 'partial' || taxpayerId) {
        const p = {};
        if (ok('work_state')) p.workState = v.work_state;
        if (ok('classification')) p.classification = v.classification;
        if (ok('flsa_status')) p.flsaStatus = v.flsa_status;
        if (ok('employment_type')) p.employmentType = v.employment_type;
        if (ok('pay_frequency')) p.payFrequency = v.pay_frequency;
        if (ok('pay_type')) { p.payType = v.pay_type; if (ok('pay_rate')) p.payRate = Number(v.pay_rate); }
        if (ok('date_of_birth')) p.dateOfBirth = v.date_of_birth;
        if (ok('middle_name')) p.legalMiddleName = v.middle_name;
        if (ok('address_line1') && ok('city') && ok('state') && ok('zip')) p.homeAddress = { line1: v.address_line1, line2: v.address_line2 || '', city: v.city, state: v.state, zip: v.zip };
        partialProfile = p;
    }
    return { input, partialProfile, taxpayerId: n.profile === 'full' ? null : taxpayerId, employeeNumber: v.employee_number || null };
}

/** The validators speak in field names ("firstName is required"); the import page speaks in column names */
const SERVER_FIELD = [
    [/^firstName/, 'first_name', 'First name is missing'], [/^lastName/, 'last_name', 'Last name is missing'], [/^email/, 'email', 'This does not look like an email address'],
    [/^role/, 'role', 'Role must be Employee, Manager or HR admin'], [/^startDate/, 'start_date', 'First day of work is not a real date'],
    [/^dateOfBirth/, 'date_of_birth', 'Date of birth must be a real past date for someone at least 14'], [/^homeAddress\.line1/, 'address_line1', 'Home address is missing'],
    [/^homeAddress\.city/, 'city', 'City is missing'], [/^homeAddress\.state/, 'state', 'Home state must be a US state'], [/^homeAddress\.zip/, 'zip', 'ZIP code must look like 78701 or 78701-1234'],
    [/^workState/, 'work_state', 'Work state must be a US state'], [/^classification/, 'classification', 'Write W2 or 1099'], [/^employmentType/, 'employment_type', 'Write full time, part time, seasonal or temporary'],
    [/^payType/, 'pay_type', 'Write hourly or salary'], [/^payFrequency/, 'pay_frequency', 'Write weekly, biweekly, semimonthly or monthly'], [/^flsaStatus/, 'flsa_status', 'Write exempt or non-exempt (W-2 employees only)'],
    [/^payRate/, 'pay_rate', 'Pay rate must be more than zero'], [/^an exempt employee/, 'flsa_status', 'A person paid by the hour cannot be exempt from overtime'],
    [/^(SSN|ITIN|taxpayerId)/i, 'ssn', 'This is not a valid Social Security number or ITIN']
];
function plainProblem(serverError) {
    const s = String(serverError || '');
    const hit = SERVER_FIELD.find(([re]) => re.test(s));
    return hit ? { field: hit[1], message: hit[2] } : { field: null, message: s };
}

/** Adds server-side findings to the problems, without saying the same thing about a field twice */
function mergeProblems(problems, serverErrors) {
    const out = problems.slice();
    (serverErrors || []).forEach((e) => {
        const p = typeof e === 'string' ? plainProblem(e) : e;
        if (p.field && out.some((x) => x.field === p.field)) return;
        if (!out.some((x) => x.field === p.field && x.message === p.message)) out.push(p);
    });
    return out;
}

/** Marks the second and later rows that use an email already used higher up */
function duplicateEmails(people) {
    const seen = new Map(); const dup = new Set();
    people.forEach((p, i) => { const e = String((p && p.email) || '').trim().toLowerCase(); if (!e) return; if (seen.has(e)) dup.add(i); else seen.set(e, i); });
    return dup;
}

/** SSN shown back to the page: only the last four digits */
const maskSsn = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 4 ? `***-**-${d.slice(-4)}` : '***'; };

/** "Maria Lopez, maria@example.com" lines from the quick-add box -> people. Also takes tabs and "Name <email>". */
function parseQuickAdd(text) {
    return String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, MAX_ROWS + 1).map((line) => {
        const m = /([^\s<>,;]+@[^\s<>,;]+)/.exec(line);
        const email = m ? m[1].replace(/^mailto:/i, '') : '';
        const name = cell(line.replace(m ? m[0] : '', ' ').replace(/[<>;\t]/g, ' ').replace(/^[\s,]+|[\s,]+$/g, ''));
        const person = {};
        if (name) person.full_name = name;
        if (email) person.email = email;
        return person;
    });
}

module.exports = {
    MAX_ROWS, MAX_COLUMNS, FIELDS, FIELD_KEYS, LABELS, IGNORE, SYNONYMS, FULL_PROFILE_NEEDS,
    parsePasted, cleanTable, parseDate, parseMoney, parseState, parsePayType, parseClassification, parseFlsa, parseEmploymentType, parsePayFrequency, parseRole,
    splitFullName, hasHeaderRow, guessFromHeader, guessFromCells, guessMapping, validateMapping, applyMapping,
    normalizePerson, toPersonInput, plainProblem, mergeProblems, duplicateEmails, maskSsn, parseQuickAdd
};
