import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../services/team-import-rules.js');

const TODAY = new Date('2026-11-12T12:00:00Z');
const fieldsOf = (g) => Object.fromEntries(g.columns.map((c) => [c.header, c.field]));

test('pasted text: tabs from Excel, quoted cells, CSV, semicolons, blank lines', () => {
    assert.deepEqual(R.parsePasted('First\tLast\tEmail\r\nMaria\tLopez\tmaria@x.com\r\n\r\n'), [['First', 'Last', 'Email'], ['Maria', 'Lopez', 'maria@x.com']]);
    assert.deepEqual(R.parsePasted('Name\tAddress\n"Lopez, Maria"\t"1 Main St\nApt 4"'), [['Name', 'Address'], ['Lopez, Maria', '1 Main St Apt 4']]);
    assert.deepEqual(R.parsePasted('name,email\n"Lopez, Maria",maria@x.com\n"She said ""hi""",b@x.com'), [['name', 'email'], ['Lopez, Maria', 'maria@x.com'], ['She said "hi"', 'b@x.com']]);
    assert.deepEqual(R.parsePasted('name;email\nMaria Lopez;maria@x.com'), [['name', 'email'], ['Maria Lopez', 'maria@x.com']]);
    assert.deepEqual(R.parsePasted('﻿a\tb'), [['a', 'b']]);
    assert.deepEqual(R.parsePasted(''), []);
    assert.deepEqual(R.parsePasted(null), []);
    assert.deepEqual(R.parsePasted('a\t\tb\n\t\t'), [['a', '', 'b']]);
});

test('cleanTable: trims, pads rows to one width, drops empty rows, enforces the limits', () => {
    const t = R.cleanTable([[' a ', 'b'], [], ['', ''], ['c']]);
    assert.deepEqual(t.rows, [['a', 'b'], ['c', '']]);
    assert.deepEqual(t.errors, []);
    assert.ok(R.cleanTable('nope').errors.length);
    assert.ok(R.cleanTable([Array.from({ length: R.MAX_COLUMNS + 1 }, (_, i) => `c${i}`)]).errors[0].includes('columns'));
    assert.ok(R.cleanTable(Array.from({ length: R.MAX_ROWS + 2 }, (_, i) => [`r${i}`])).errors[0].includes(String(R.MAX_ROWS)));
    assert.equal(R.cleanTable(Array.from({ length: R.MAX_ROWS + 1 }, (_, i) => [`r${i}`])).errors.length, 0); // header + 500
    assert.equal(R.cleanTable([['x'.repeat(1000)]]).rows[0][0].length, 300);
    assert.equal(R.cleanTable([[5, null, undefined, true]]).rows[0].join('|'), '5|||true');
});

test('dates: the forms people and spreadsheets really use', () => {
    const d = (v, o = {}) => R.parseDate(v, { today: TODAY, ...o });
    for (const v of ['1/17/2025', '01/17/2025', '1-17-2025', '1.17.2025', '2025-01-17', '2025/1/17', 'Jan 17 2025', 'Jan 17, 2025', 'January 17, 2025', 'Jan. 17, 2025', '17 Jan 2025', '17-Jan-2025', '17-Jan-25', 'jan 17th 2025',
        '2025-01-17T00:00:00.000Z', '2025-01-17 00:00:00', '1/17/2025 12:00:00 AM', '1/17/25', '17 de enero de 2025', '45674', '45674.0']) {
        assert.equal(d(v), '2025-01-17', v);
    }
    assert.equal(d('17/1/2025'), '2025-01-17'); // the first number can only be a day
    assert.equal(d('3/4/2025'), '2025-03-04'); // US order: month first
    for (const v of ['', null, 'soon', '2/30/2025', '13/13/2025', '2025-13-01', '0/0/0', 'Jan 32 2025', '12', '999999', 'Maria']) assert.equal(d(v), null, String(v));
});

test('dates: two-digit years lean to the past for birth dates', () => {
    assert.equal(R.parseDate('5/20/91', { birth: true, today: TODAY }), '1991-05-20');
    assert.equal(R.parseDate('5/20/30', { birth: true, today: TODAY }), '1930-05-20');
    assert.equal(R.parseDate('5/20/20', { birth: true, today: TODAY }), '2020-05-20');
    assert.equal(R.parseDate('1/5/27', { today: TODAY }), '2027-01-05'); // a start date may be next year
    assert.equal(R.parseDate('1/5/40', { today: TODAY }), '1940-01-05');
});

test('money: dollars, commas, per hour, thousands', () => {
    const cases = { '$18.50': 18.5, '18.5': 18.5, '18': 18, '$ 18.50': 18.5, '1,250.00': 1250, '$52,000': 52000, '$52,000 / year': 52000, '18.50/hr': 18.5, '18.50 per hour': 18.5, '52k': 52000, '$52K': 52000, 'USD 20': 20, '.5': 0.5, '18.555': 18.56, '20 hourly': 20 };
    for (const [text, n] of Object.entries(cases)) assert.equal(R.parseMoney(text), n, text);
    for (const bad of ['', null, 'abc', '-3', '0', '$0.00', '1,2,3', '12 apples', '1.2.3', 'N/A']) assert.equal(R.parseMoney(bad), null, String(bad));
});

test('states and the words payroll tools use for pay type, classification, overtime status, hours and roles', () => {
    assert.equal(R.parseState('tx'), 'TX'); assert.equal(R.parseState('Texas'), 'TX'); assert.equal(R.parseState('new  york'), 'NY'); assert.equal(R.parseState('TX - Texas'), 'TX');
    assert.equal(R.parseState('District of Columbia'), 'DC'); assert.equal(R.parseState('ZZ'), null); assert.equal(R.parseState('Ontario'), null); assert.equal(R.parseState(''), null);
    assert.equal(R.parsePayType('Hourly'), 'hourly'); assert.equal(R.parsePayType('Salaried'), 'salary'); assert.equal(R.parsePayType('Salary/No overtime'), 'salary'); assert.equal(R.parsePayType('per hour'), 'hourly');
    assert.equal(R.parsePayType('Year'), 'salary'); assert.equal(R.parsePayType('commission'), null);
    assert.equal(R.parseClassification('W-2'), 'W2'); assert.equal(R.parseClassification('Employee'), 'W2'); assert.equal(R.parseClassification('Independent Contractor'), '1099'); assert.equal(R.parseClassification('1099-NEC'), '1099'); assert.equal(R.parseClassification('intern'), null);
    assert.equal(R.parseFlsa('Non-Exempt'), 'non_exempt'); assert.equal(R.parseFlsa('nonexempt'), 'non_exempt'); assert.equal(R.parseFlsa('Exempt'), 'exempt'); assert.equal(R.parseFlsa('Yes'), null); // yes to what?
    assert.equal(R.parseEmploymentType('Full-Time'), 'full_time'); assert.equal(R.parseEmploymentType('PT'), 'part_time'); assert.equal(R.parseEmploymentType('Active'), null);
    assert.equal(R.parsePayFrequency('Bi-Weekly'), 'biweekly'); assert.equal(R.parsePayFrequency('Every other week'), 'biweekly'); assert.equal(R.parsePayFrequency('Semi-monthly'), 'semimonthly'); assert.equal(R.parsePayFrequency('daily'), null);
    assert.equal(R.parseRole('Manager'), 'manager'); assert.equal(R.parseRole('HR Admin'), 'hr_admin'); assert.equal(R.parseRole('Staff'), 'employee'); assert.equal(R.parseRole('Owner'), null); assert.equal(R.parseRole('super_admin'), null);
});

test('full names are split; one word cannot be', () => {
    assert.deepEqual(R.splitFullName('Maria Lopez'), { first: 'Maria', last: 'Lopez' });
    assert.deepEqual(R.splitFullName('Lopez, Maria'), { first: 'Maria', last: 'Lopez' });
    assert.deepEqual(R.splitFullName('Lopez Garcia, Maria Elena'), { first: 'Maria Elena', last: 'Lopez Garcia' });
    assert.deepEqual(R.splitFullName('Maria de la Cruz'), { first: 'Maria', last: 'de la Cruz' });
    assert.deepEqual(R.splitFullName('John Smith Jr.'), { first: 'John', last: 'Smith' });
    assert.equal(R.splitFullName('Cher'), null); assert.equal(R.splitFullName(''), null); assert.equal(R.splitFullName('Lopez,'), null);
});

test('header names from common payroll exports are recognized (the lists are guesses, see the module note)', () => {
    const expected = {
        'First Name': 'first_name', 'Last Name': 'last_name', 'Legal First Name': 'first_name', 'Employee Name': 'full_name', Name: 'full_name', 'Work Email': 'email', 'Personal Email': 'email', 'E-mail Address': 'email',
        'Hire Date': 'start_date', 'Start Date': 'start_date', 'Original Hire Date': 'start_date', 'Job Title': 'job_title', Position: 'job_title', 'Home Department': 'department', Department: 'department',
        'File Number': 'employee_number', 'Associate ID': 'employee_number', 'Employee ID': 'employee_number', 'Worked In State': 'work_state', 'Work State': 'work_state', 'Pay Type': 'pay_type', 'Compensation Type': 'pay_type',
        'Pay Rate': 'pay_rate', 'Hourly Rate': 'pay_rate', 'Annual Salary': 'pay_rate', 'Regular Pay Rate Amount': 'pay_rate', 'Pay Frequency': 'pay_frequency', 'FLSA Status': 'flsa_status', 'Worker Type': 'classification',
        'Date of Birth': 'date_of_birth', DOB: 'date_of_birth', 'Birth Date': 'date_of_birth', 'Street Address': 'address_line1', 'Address Line 1': 'address_line1', 'Address Line 2': 'address_line2', City: 'city', State: 'state',
        'Zip Code': 'zip', 'Postal Code': 'zip', 'Mobile Phone': 'phone', 'Phone Number': 'phone', SSN: 'ssn', 'Social Security Number': 'ssn', 'Tax ID (SSN)': 'ssn', 'Middle Initial': 'middle_name'
    };
    for (const [header, field] of Object.entries(expected)) assert.equal(R.guessFromHeader(header), field, header);
    for (const header of ['Manager Email', 'Supervisor Name', 'Emergency Contact Phone', 'Bank Account Number', 'Routing Number', 'Termination Date', 'Spouse Name', 'Notes', 'Shirt size', '']) assert.equal(R.guessFromHeader(header), null, header);
    // every synonym belongs to exactly one field
    const all = Object.values(R.SYNONYMS).flat();
    assert.equal(new Set(all).size, all.length, `repeated: ${all.filter((s, i) => all.indexOf(s) !== i).join(', ')}`);
    assert.deepEqual(Object.keys(R.SYNONYMS).sort(), R.FIELD_KEYS.slice().sort());
});

test('a column is also recognized by what is in it', () => {
    const g = (cells) => R.guessFromCells(cells, TODAY);
    assert.equal(g(['a@x.com', 'b@y.org', '']), 'email');
    assert.equal(g(['123-45-6789', '987-65-4321']), 'ssn');
    assert.equal(g(['78701', '53132-1234']), 'zip');
    assert.equal(g(['(512) 555-0101', '512-555-0102', '+1 512 555 0103']), 'phone');
    assert.equal(g(['$18.50', '$20']), 'pay_rate');
    assert.equal(g(['1/17/2025', '3/2/2024', 'Jan 5 2026']), 'start_date');
    assert.equal(g(['5/20/1991', '11/02/1985']), 'date_of_birth');
    assert.equal(g(['TX', 'OK', 'tx']), 'work_state');
    assert.equal(g(['Hourly', 'Salary']), 'pay_type');
    assert.equal(g(['W-2', '1099']), 'classification');
    assert.equal(g(['Exempt', 'Non-exempt']), 'flsa_status');
    assert.equal(g(['Full time', 'Part-time']), 'employment_type');
    assert.equal(g(['Biweekly', 'Weekly']), 'pay_frequency');
    assert.equal(g(['Maria', 'Joe']), null);
    assert.equal(g(['18.50', '20']), null); // a bare number could be anything
    assert.equal(g(['', '']), null);
    assert.equal(g(['a@x.com', 'not an email', 'also not', 'nope']), null);
});

test('guessMapping: a Gusto-style sheet', () => {
    const rows = R.parsePasted(['First Name\tLast Name\tWork Email\tHire Date\tJob Title\tDepartment\tCompensation Type\tRate\tWorked In State\tManager Email\tSSN',
        'Maria\tLopez\tmaria@x.com\t1/17/2025\tCook\tKitchen\tHourly\t$18.50\tTX\tboss@x.com\t123-45-6789',
        'Joe\tLee\tjoe@x.com\tJan 3 2024\tHost\tFront\tSalary\t52,000\tTexas\tboss@x.com\t'].join('\n'));
    const g = R.guessMapping(rows, { today: TODAY });
    assert.equal(g.hasHeader, true); assert.equal(g.rowCount, 2);
    assert.deepEqual(fieldsOf(g), { 'First Name': 'first_name', 'Last Name': 'last_name', 'Work Email': 'email', 'Hire Date': 'start_date', 'Job Title': 'job_title', Department: 'department', 'Compensation Type': 'pay_type', Rate: 'pay_rate',
        'Worked In State': 'work_state', 'Manager Email': 'ignore', SSN: 'ssn' });
    assert.deepEqual(g.ssnColumns, [10]);
    assert.equal(g.columns[0].sample, 'Maria'); assert.equal(g.columns[0].why, 'header'); assert.equal(g.columns[9].why, 'none');
});

test('guessMapping: an ADP-style sheet with one name column, "last, first", and confusing headers', () => {
    const rows = [['Payroll Name', 'File Number', 'Position Status', 'Home Department Description', 'Job Title Description', 'Hire Date', 'Regular Pay Rate Amount', 'Regular Pay Rate Description', 'FLSA Description', 'Worker Category Description', 'Personal Contact: Personal Email', 'Primary Address: State / Territory Code', 'Birth Date', 'First pay date'],
        ['Lopez, Maria', '000123', 'Active', 'Kitchen', 'Cook', '01/17/2025', '18.50', 'Hourly', 'Non-exempt', 'Full Time', 'maria@x.com', 'TX', '05/20/1991', '02/01/2025'],
        ['Lee, Joe', '000124', 'Active', 'Front', 'Host', '01/03/2024', '52000', 'Salary', 'Exempt', 'Part Time', 'joe@x.com', 'OK', '11/02/1985', '02/01/2025']];
    const f = fieldsOf(R.guessMapping(rows, { today: TODAY }));
    assert.equal(f['Payroll Name'], 'full_name'); assert.equal(f['File Number'], 'employee_number'); assert.equal(f['Position Status'], 'ignore');
    assert.equal(f['Home Department Description'], 'department'); assert.equal(f['Job Title Description'], 'job_title'); assert.equal(f['Hire Date'], 'start_date');
    assert.equal(f['Regular Pay Rate Amount'], 'pay_rate'); assert.equal(f['Regular Pay Rate Description'], 'pay_type'); assert.equal(f['FLSA Description'], 'flsa_status');
    assert.equal(f['Worker Category Description'], 'employment_type'); // the header says "worker category", the cells say full or part time
    assert.equal(f['Personal Contact: Personal Email'], 'email'); assert.equal(f['Primary Address: State / Territory Code'], 'state'); assert.equal(f['Birth Date'], 'date_of_birth');
    assert.equal(f['First pay date'], 'ignore'); // not a first name, and the start date is already taken
});

test('guessMapping: no header row, columns found by what is in them', () => {
    const g = R.guessMapping([['Maria Lopez', 'maria@x.com', '(512) 555-0101', '1/17/2025'], ['Joe Lee', 'joe@x.com', '512-555-0102', '3/2/2024']], { today: TODAY });
    assert.equal(g.hasHeader, false); assert.equal(g.rowCount, 2);
    assert.deepEqual(g.columns.map((c) => c.field), ['full_name', 'email', 'phone', 'start_date']);
    assert.deepEqual(g.columns.map((c) => c.header), ['Column 1', 'Column 2', 'Column 3', 'Column 4']);
    assert.equal(g.ssnColumns.length, 0);
});

test('guessMapping: a "Role" column of job titles is the job title; an SSN column under another name is still flagged, never mapped elsewhere', () => {
    const g = R.guessMapping([['Name', 'Email', 'Role', 'Employee ID', 'State', 'Lived-in State'], ['Maria Lopez', 'maria@x.com', 'Line cook', '123-45-6789', 'TX', 'TX'], ['Joe Lee', 'joe@x.com', 'Host', '987-65-4321', 'OK', 'OK']], { today: TODAY });
    const f = fieldsOf(g);
    assert.equal(f.Role, 'job_title'); assert.equal(f.State, 'state');
    assert.deepEqual(g.ssnColumns, [3]);
    assert.equal(f['Employee ID'], 'ssn'); // the cells are SSNs, so it is treated as one and the user is asked
    const roles = fieldsOf(R.guessMapping([['Name', 'Email', 'Role'], ['Maria Lopez', 'maria@x.com', 'Manager'], ['Joe Lee', 'joe@x.com', 'Employee']], { today: TODAY }));
    assert.equal(roles.Role, 'role');
});

test('guessMapping: first and last name columns win over a full-name column; each field is used once', () => {
    const g = R.guessMapping([['Employee', 'First Name', 'Last Name', 'Email', 'Email Address'], ['Maria Lopez', 'Maria', 'Lopez', 'm@x.com', 'm2@x.com']], { today: TODAY });
    assert.deepEqual(g.columns.map((c) => c.field), ['ignore', 'first_name', 'last_name', 'email', 'ignore']);
    const used = g.columns.map((c) => c.field).filter((f) => f !== 'ignore');
    assert.equal(new Set(used).size, used.length);
});

test('validateMapping: a name and an email are needed; no field twice; unknown names become "ignore"', () => {
    assert.deepEqual(R.validateMapping(['full_name', 'email', 'nonsense'], 3), { errors: [], value: ['full_name', 'email', 'ignore'] });
    assert.equal(R.validateMapping(['first_name', 'last_name', 'email'], 3).errors.length, 0);
    assert.ok(R.validateMapping(['first_name', 'email'], 2).errors[0].includes('name'));
    assert.ok(R.validateMapping(['full_name', 'phone'], 2).errors[0].includes('email'));
    assert.ok(R.validateMapping(['full_name', 'email', 'email'], 3).errors[0].includes('more than one'));
    assert.ok(R.validateMapping(['full_name'], 2).errors.length); assert.ok(R.validateMapping(null, 2).errors.length);
});

test('applyMapping builds one object per row and leaves ignored and empty cells out', () => {
    assert.deepEqual(R.applyMapping([['Maria Lopez', 'm@x.com', 'x', ''], ['Joe Lee', '', 'y', 'TX']], ['full_name', 'email', 'ignore', 'work_state']), [{ full_name: 'Maria Lopez', email: 'm@x.com' }, { full_name: 'Joe Lee', work_state: 'TX' }]);
});

test('normalizePerson: a tidy row has no problems and values in the stored form', () => {
    const n = R.normalizePerson({ full_name: 'Lopez, Maria', email: ' Maria@X.com ', phone: '512.555.0101', start_date: 'Jan 17 2025', job_title: 'Cook', role: 'Staff', work_state: 'Texas', pay_type: 'Hourly', pay_rate: '$18.50', zip: '2139', state: 'ma' }, { today: TODAY });
    assert.deepEqual(n.problems, []);
    assert.deepEqual(n.values, { first_name: 'Maria', last_name: 'Lopez', email: 'maria@x.com', phone: '(512) 555-0101', start_date: '2025-01-17', job_title: 'Cook', role: 'employee', work_state: 'TX', state: 'MA', pay_type: 'hourly', pay_rate: '18.50', zip: '02139' });
    assert.equal(n.profile, 'partial'); assert.ok(n.notes.some((x) => x.includes('ZIP')));
});

test('normalizePerson: every problem is tied to its field, in plain words; what was typed stays so it can be fixed', () => {
    const n = R.normalizePerson({ full_name: 'Cher', email: 'not-an-email', phone: '555', start_date: 'soon', role: 'Owner', work_state: 'Ontario', pay_type: 'commission', pay_rate: 'lots', date_of_birth: '1/1/2020', zip: 'ABC', classification: 'intern', flsa_status: 'maybe', employment_type: 'Active', pay_frequency: 'daily' }, { today: TODAY });
    const fields = n.problems.map((p) => p.field).sort();
    assert.deepEqual(fields, ['classification', 'date_of_birth', 'email', 'employment_type', 'flsa_status', 'last_name', 'pay_frequency', 'pay_rate', 'pay_type', 'phone', 'role', 'start_date', 'work_state', 'zip']);
    assert.equal(n.values.start_date, 'soon'); assert.equal(n.values.pay_rate, 'lots'); assert.equal(n.values.first_name, 'Cher');
    n.problems.forEach((p) => { assert.equal(typeof p.message, 'string'); assert.ok(p.message.length > 8); assert.equal(/[a-z][A-Z]/.test(p.message.replace(/ITIN|W2|HR|ZIP|US|TX/g, '')), false, `no field names in: ${p.message}`); });
    const empty = R.normalizePerson({}, { today: TODAY });
    assert.deepEqual(empty.problems.map((p) => p.field), ['first_name', 'last_name', 'email', 'start_date']);
    assert.equal(R.normalizePerson(null, { today: TODAY }).problems.length, 4);
});

test('normalizePerson: a start date for everyone fills the empty ones only', () => {
    const a = R.normalizePerson({ full_name: 'Maria Lopez', email: 'm@x.com' }, { today: TODAY, defaultStartDate: '2026-12-01' });
    assert.equal(a.values.start_date, '2026-12-01'); assert.deepEqual(a.problems, []); assert.ok(a.notes[0].includes('First day'));
    const b = R.normalizePerson({ full_name: 'Maria Lopez', email: 'm@x.com', start_date: '1/5/2026' }, { today: TODAY, defaultStartDate: '2026-12-01' });
    assert.equal(b.values.start_date, '2026-01-05'); assert.deepEqual(b.notes, []);
});

test('SSNs are dropped unless the administrator said to import them', () => {
    const row = { full_name: 'Maria Lopez', email: 'm@x.com', start_date: '2025-01-17', ssn: '123-45-6789' };
    for (const options of [{}, { ssn: 'leave' }, { ssn: 'yes' }, { ssn: true }, { ssn: 'IMPORT' }]) {
        const n = R.normalizePerson(row, { today: TODAY, ...options });
        assert.equal(n.values.ssn, undefined, JSON.stringify(options)); assert.equal(n.ssnDropped, true);
        assert.equal(JSON.stringify(R.toPersonInput(n)).includes('6789'), false);
    }
    const kept = R.normalizePerson(row, { today: TODAY, ssn: 'import' });
    assert.equal(kept.values.ssn, '123-45-6789'); assert.equal(kept.ssnDropped, false); assert.deepEqual(kept.problems, []);
    assert.deepEqual(R.toPersonInput(kept).taxpayerId, { value: '123-45-6789', type: 'SSN' });
    const badSsn = R.normalizePerson({ ...row, ssn: '000-00-0000' }, { today: TODAY, ssn: 'import' });
    assert.deepEqual(badSsn.problems.map((p) => p.field), ['ssn']);
    assert.equal(R.maskSsn('123-45-6789'), '***-**-6789'); assert.equal(R.maskSsn('12'), '***');
});

test('a whole profile goes to the full validator; pieces are kept as pieces', () => {
    const base = { first_name: 'Maria', last_name: 'Lopez', email: 'm@x.com', start_date: '2025-01-17', date_of_birth: '5/20/1991', address_line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', work_state: 'TX', classification: 'W-2', flsa_status: 'Non-exempt', pay_type: 'Hourly', pay_rate: '$18.50' };
    const full = R.normalizePerson(base, { today: TODAY });
    assert.equal(full.profile, 'full'); assert.deepEqual(full.problems, []);
    const conv = R.toPersonInput(full);
    assert.deepEqual(conv.input.profile, { dateOfBirth: '1991-05-20', homeAddress: { line1: '1 Main St', line2: '', city: 'Austin', state: 'TX', zip: '78701' }, workState: 'TX', classification: 'W2', flsaStatus: 'non_exempt', employmentType: 'full_time',
        payType: 'hourly', payFrequency: 'biweekly', payRate: '18.50', legalMiddleName: undefined, taxpayerId: undefined, taxpayerIdType: 'SSN' });
    assert.equal(conv.partialProfile, null);
    // W-2 without an overtime status is not a whole profile: nothing is assumed
    const { flsa_status: _f, ...noFlsa } = base;
    assert.equal(R.normalizePerson(noFlsa, { today: TODAY }).profile, 'partial');
    // pieces
    const part = R.toPersonInput(R.normalizePerson({ full_name: 'Joe Lee', email: 'j@x.com', start_date: '2024-01-03', work_state: 'OK', pay_rate: '20', city: 'Tulsa' }, { today: TODAY }));
    assert.equal(part.input.profile, undefined);
    assert.deepEqual(part.partialProfile, { workState: 'OK' }); // no pay rate without a pay type, no half address
    const none = R.toPersonInput(R.normalizePerson({ full_name: 'Joe Lee', email: 'j@x.com', start_date: '2024-01-03', employee_number: '000124' }, { today: TODAY }));
    assert.equal(none.partialProfile, null); assert.equal(none.employeeNumber, '000124');
});

test('rules that involve two cells', () => {
    const n = R.normalizePerson({ full_name: 'Joe Lee', email: 'j@x.com', start_date: '2024-01-03', pay_type: 'hourly', flsa_status: 'exempt' }, { today: TODAY });
    assert.deepEqual(n.problems.map((p) => p.field), ['flsa_status']);
    const c = R.normalizePerson({ full_name: 'Joe Lee', email: 'j@x.com', start_date: '2024-01-03', classification: '1099', flsa_status: 'exempt' }, { today: TODAY });
    assert.equal(c.values.flsa_status, undefined); assert.deepEqual(c.problems, []); assert.ok(c.notes.length);
});

test('server validation messages are turned into plain words tied to a column', () => {
    assert.deepEqual(R.plainProblem('firstName is required'), { field: 'first_name', message: 'First name is missing' });
    assert.equal(R.plainProblem('startDate must be a real date (YYYY-MM-DD)').field, 'start_date');
    assert.equal(R.plainProblem('homeAddress.zip must be 12345 or 12345-6789').field, 'zip');
    assert.equal(R.plainProblem('an exempt employee cannot be paid hourly').field, 'flsa_status');
    assert.equal(R.plainProblem('SSN must have 9 digits').field, 'ssn');
    assert.deepEqual(R.plainProblem('something new'), { field: null, message: 'something new' });
    const merged = R.mergeProblems([{ field: 'email', message: 'x' }], ['email is not valid', 'payRate must be a positive number', 'payRate must be a positive number']);
    assert.deepEqual(merged.map((p) => p.field), ['email', 'pay_rate']);
});

test('duplicate emails: the second and later rows are marked', () => {
    assert.deepEqual([...R.duplicateEmails([{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'A@x.com ' }, {}, { email: '' }, { email: 'b@x.com' }])], [2, 5]);
});

test('quick add: one person per line, in the ways people type it', () => {
    assert.deepEqual(R.parseQuickAdd('Maria Lopez, maria@x.com\nJoe Lee <joe@x.com>\n\nLee, Ann\tann@x.com\nbob@x.com\nNo Email Person'), [
        { full_name: 'Maria Lopez', email: 'maria@x.com' }, { full_name: 'Joe Lee', email: 'joe@x.com' }, { full_name: 'Lee, Ann', email: 'ann@x.com' }, { email: 'bob@x.com' }, { full_name: 'No Email Person' }]);
    assert.deepEqual(R.parseQuickAdd(''), []);
    const n = R.normalizePerson(R.parseQuickAdd('Lee, Ann\tann@x.com')[0], { today: TODAY, defaultStartDate: '2026-12-01' });
    assert.deepEqual(n.problems, []); assert.equal(n.values.first_name, 'Ann'); assert.equal(n.values.last_name, 'Lee');
});

test('the result of a clean row passes the validation the "add one employee" form uses', () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const svc = require('../services/us-people-service.js');
    const rows = R.parsePasted('Name\tEmail\tHire Date\tState\tZip\tAddress\tCity\tWork State\tDOB\tWorker Type\tFLSA\tPay Type\tRate\nLopez, Maria\tmaria@x.com\t1/17/2025\tTexas\t78701\t1 Main St\tAustin\tTX\t5/20/1991\tEmployee\tNon-exempt\tHourly\t$18.50\nJoe Lee\tjoe@x.com\t2024-01-03\t\t\t\t\t\t\t\t\t\t');
    const g = R.guessMapping(rows, { today: TODAY });
    const people = R.applyMapping(rows.slice(1), R.validateMapping(g.columns.map((c) => c.field), rows[0].length).value);
    const [a, b] = people.map((p) => R.normalizePerson(p, { today: TODAY }));
    assert.equal(a.profile, 'full'); assert.equal(b.profile, 'none');
    const va = svc.validatePerson(R.toPersonInput(a).input); const vb = svc.validatePerson(R.toPersonInput(b).input);
    assert.deepEqual(va.errors, []); assert.deepEqual(vb.errors, []);
    assert.equal(va.profile.payRate, 18.5); assert.equal(va.profile.homeAddress.zip, '78701'); assert.equal(vb.profile, null);
});
