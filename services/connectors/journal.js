/**
 * Payroll journal entry builder shared by every ERP / accounting connector (pure).
 * Input is built from canonical PayResults (collection `pay_results`, filled later by the payroll provider module).
 *
 *   Dr wages expense           gross pay           (per department)
 *   Dr employer tax expense    employer taxes      (per department)
 *   Cr taxes payable           employee + employer taxes
 *   Cr deductions payable      employee deductions
 *   Cr net pay clearing        net pay
 * Account identifiers come from the company's connection config (`accounts`), because every chart of accounts differs.
 */
const cents = (n) => Math.round((Number(n) || 0) * 100);
const money = (c) => Math.round(c) / 100;

const ACCOUNT_KEYS = ['wages_expense', 'employer_tax_expense', 'tax_payable', 'deductions_payable', 'net_pay_clearing'];

/** Groups pay results by pay date into journal records (one journal per pay date) */
function aggregatePayResults(results) {
    const groups = new Map();
    for (const r of results) {
        const key = r.pay_date || 'undated';
        if (!groups.has(key)) groups.set(key, { id: `pj_${key}`, object: 'payroll_journal', pay_date: r.pay_date, period_start: r.pay_period && r.pay_period.start, period_end: r.pay_period && r.pay_period.end, currency: r.currency || 'USD', totals: { gross: 0, employee_taxes: 0, employer_taxes: 0, deductions: 0, net: 0 }, by_department: new Map(), employee_count: 0, updated_at: null });
        const g = groups.get(key);
        g.totals.gross += cents(r.gross); g.totals.employee_taxes += cents(r.employee_taxes); g.totals.employer_taxes += cents(r.employer_taxes); g.totals.deductions += cents(r.deductions); g.totals.net += cents(r.net);
        const dep = r.department || '';
        const d = g.by_department.get(dep) || { department: dep, gross: 0, employer_taxes: 0 };
        d.gross += cents(r.gross); d.employer_taxes += cents(r.employer_taxes); g.by_department.set(dep, d);
        g.employee_count += 1;
        if (r.updated_at && (!g.updated_at || r.updated_at > g.updated_at)) g.updated_at = r.updated_at;
    }
    return [...groups.values()].map((g) => ({
        ...g, memo: `Payroll for pay date ${g.pay_date}`,
        totals: Object.fromEntries(Object.entries(g.totals).map(([k, v]) => [k, money(v)])),
        by_department: [...g.by_department.values()].map((d) => ({ department: d.department, gross: money(d.gross), employer_taxes: money(d.employer_taxes) }))
    }));
}

/** Journal lines: [{ account, side: 'debit'|'credit', amount, department, memo }] */
function buildJournal(record, accounts) {
    const acc = accounts || {};
    const missing = ACCOUNT_KEYS.filter((k) => !acc[k]);
    const t = record.totals || {};
    const lines = [];
    const deps = record.by_department && record.by_department.length ? record.by_department : [{ department: '', gross: t.gross, employer_taxes: t.employer_taxes }];
    for (const d of deps) {
        if (cents(d.gross)) lines.push({ account: acc.wages_expense, side: 'debit', amount: money(cents(d.gross)), department: d.department || null, memo: `Wages ${d.department || ''}`.trim() });
        if (cents(d.employer_taxes)) lines.push({ account: acc.employer_tax_expense, side: 'debit', amount: money(cents(d.employer_taxes)), department: d.department || null, memo: `Employer taxes ${d.department || ''}`.trim() });
    }
    const taxes = cents(t.employee_taxes) + cents(t.employer_taxes);
    if (taxes) lines.push({ account: acc.tax_payable, side: 'credit', amount: money(taxes), department: null, memo: 'Payroll taxes payable' });
    if (cents(t.deductions)) lines.push({ account: acc.deductions_payable, side: 'credit', amount: money(cents(t.deductions)), department: null, memo: 'Deductions payable' });
    if (cents(t.net)) lines.push({ account: acc.net_pay_clearing, side: 'credit', amount: money(cents(t.net)), department: null, memo: 'Net pay clearing' });
    const debit = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + cents(l.amount), 0);
    const credit = lines.filter((l) => l.side === 'credit').reduce((s, l) => s + cents(l.amount), 0);
    return { lines, debit: money(debit), credit: money(credit), balanced: debit === credit && lines.length > 0, missingAccounts: missing };
}

/** Validation errors shared by the journal-based connectors */
function validateJournal(record, accounts) {
    const j = buildJournal(record, accounts); const errors = [];
    if (j.missingAccounts.length) errors.push(`account mapping is missing: ${j.missingAccounts.join(', ')}`);
    if (!j.lines.length) errors.push('the journal has no lines');
    else if (!j.balanced) errors.push(`journal is out of balance (debits ${j.debit}, credits ${j.credit}); check that gross = taxes + deductions + net`);
    if (!record.pay_date) errors.push('pay_date is missing');
    return errors;
}

module.exports = { aggregatePayResults, buildJournal, validateJournal, ACCOUNT_KEYS, cents, money };
