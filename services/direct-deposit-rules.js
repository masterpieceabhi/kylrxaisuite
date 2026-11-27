/**
 * Direct deposit splits (pure). Several accounts per person, each taking a percent, a fixed amount, or the remainder.
 * Exactly one account takes the remainder. Fixed amounts are paid first, then percents of the net pay, then the remainder.
 */
const { validateRoutingNumber, ACCOUNT_TYPES } = require('./us-validation');

const ALLOC_TYPES = ['percent', 'amount', 'remainder'];
const MAX_ACCOUNTS = 5;
const digits = (v) => String(v === undefined || v === null ? '' : v).replace(/\D/g, '');

/**
 * input: [{ id?, bankName, routingNumber, accountNumber?, accountType, allocation:{type,value} }]
 * existing: Map of id -> stored account (lets an edit keep a stored account number by sending only its id)
 */
function validateSplits(input, existing = new Map()) {
    const errors = [];
    if (!Array.isArray(input) || input.length === 0) return { errors: ['accounts must be a non-empty list'], value: [] };
    if (input.length > MAX_ACCOUNTS) return { errors: [`at most ${MAX_ACCOUNTS} accounts are allowed`], value: [] };
    const value = [];
    let remainders = 0; let percentTotal = 0;
    const seen = new Set();
    input.forEach((a, i) => {
        const at = `accounts[${i}]`;
        const row = a || {};
        const prior = row.id && existing.get(row.id);
        if (row.id && !prior) errors.push(`${at}.id is not one of your accounts`);
        const bankName = String(row.bankName || (prior && prior.bankName) || '').trim();
        if (!bankName) errors.push(`${at}.bankName is required`);
        const rt = validateRoutingNumber(row.routingNumber || (prior && prior.routingNumber));
        if (!rt.valid) errors.push(`${at}.${rt.error}`);
        const acctInput = digits(row.accountNumber);
        let last4 = prior ? prior.accountLast4 : null;
        let accountNumber = null;
        if (acctInput || !prior) {
            if (acctInput.length < 4 || acctInput.length > 17) errors.push(`${at}.accountNumber must have 4 to 17 digits`);
            else { accountNumber = acctInput; last4 = acctInput.slice(-4); }
        }
        const accountType = row.accountType || (prior && prior.accountType);
        if (!ACCOUNT_TYPES.includes(accountType)) errors.push(`${at}.accountType must be checking or savings`);
        const al = row.allocation || {};
        if (!ALLOC_TYPES.includes(al.type)) errors.push(`${at}.allocation.type must be one of: ${ALLOC_TYPES.join(', ')}`);
        let allocValue = null;
        if (al.type === 'percent') {
            const p = Number(al.value);
            if (!(p > 0 && p < 100) || Math.round(p * 100) / 100 !== p) errors.push(`${at}: a percent must be above 0 and below 100 (two decimals at most)`);
            else { allocValue = p; percentTotal += p; }
        } else if (al.type === 'amount') {
            const m = Number(al.value);
            if (!(m >= 0.01 && m <= 1000000) || Math.round(m * 100) / 100 !== m) errors.push(`${at}: a fixed amount must be between 0.01 and 1,000,000 (cents at most)`);
            else allocValue = m;
        } else if (al.type === 'remainder') remainders += 1;
        // new numbers compare in full; a kept stored account compares by its id (two real accounts can share the last 4 digits)
        const dup = accountNumber ? `${rt.digits}:${accountNumber}` : `id:${row.id}`;
        if ((rt.valid || !accountNumber) && seen.has(dup)) errors.push(`${at} repeats another account`);
        seen.add(dup);
        value.push({
            id: row.id || null, bankName, routingNumber: rt.valid ? rt.digits : null, accountNumber, accountLast4: last4,
            accountType, allocation: { type: al.type, value: allocValue }, keepStoredNumber: !accountNumber && Boolean(prior)
        });
    });
    if (remainders !== 1) errors.push('exactly one account must take the remainder');
    if (remainders === 1 && Math.round(percentTotal * 100) / 100 >= 100) errors.push('percents add up to 100 or more, nothing is left for the remainder account');
    if (!remainders && percentTotal > 100) errors.push('percents add up to more than 100');
    return { errors, value };
}

/** Splits a net pay (dollars) across the accounts; returns [{index, cents}] and a shortfall flag */
function allocate(netDollars, accounts) {
    const net = Math.round(netDollars * 100);
    let left = net;
    const cents = accounts.map(() => 0);
    accounts.forEach((a, i) => {
        if (a.allocation.type !== 'amount') return;
        const take = Math.min(left, Math.round(a.allocation.value * 100));
        cents[i] = take; left -= take;
    });
    accounts.forEach((a, i) => {
        if (a.allocation.type !== 'percent') return;
        const take = Math.min(left, Math.round((net * a.allocation.value) / 100));
        cents[i] = take; left -= take;
    });
    const r = accounts.findIndex((a) => a.allocation.type === 'remainder');
    if (r >= 0) cents[r] = left;
    const requested = accounts.reduce((s, a) => s + (a.allocation.type === 'amount' ? Math.round(a.allocation.value * 100) : 0), 0);
    return { cents, remainderCents: r >= 0 ? left : 0, fixedShortfall: requested > net };
}

const maskAccount = (a) => ({
    id: a.id, bankName: a.bankName, routingNumber: a.routingNumber, accountType: a.accountType, accountLast4: a.accountLast4,
    accountMasked: `••••${a.accountLast4}`, allocation: a.allocation
});

module.exports = { ALLOC_TYPES, MAX_ACCOUNTS, validateSplits, allocate, maskAccount };
