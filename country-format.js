/**
 * Company-country formatting for pages (money, numbers, dates, time zone), shared by the old India-era
 * screens. Reads the company's country that country-gate.js caches in sessionStorage
 * ("kylrx_org_country") or exposes as window.KylrxCountryConfig. Companies with no country stay on India,
 * so India screens look exactly as before.
 *
 *   KylrxFmt.money(1234.5)          -> "₹1,234.50"  /  "$1,234.50"
 *   KylrxFmt.moneyCompact(250000)   -> "₹2.5L"      /  "$250K"
 *   KylrxFmt.date(value)            -> "11 Nov 2026" / "Nov 11, 2026"
 *   KylrxFmt.locale(), .currency(), .timeZone(), .code()
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(root);
    else root.KylrxFmt = factory(root);
}(typeof self !== 'undefined' ? self : this, function (root) {
    'use strict';

    const TABLE = {
        IN: { code: 'IN', currency: 'INR', locale: 'en-IN', timeZone: 'Asia/Kolkata' },
        US: { code: 'US', currency: 'USD', locale: 'en-US', timeZone: 'America/New_York' },
        CA: { code: 'CA', currency: 'CAD', locale: 'en-CA', timeZone: 'America/Toronto' }
    };
    const ALIASES = { in: 'IN', india: 'IN', us: 'US', usa: 'US', 'united states': 'US', ca: 'CA', canada: 'CA' };

    function cachedCountry() {
        try {
            const c = JSON.parse(root.sessionStorage.getItem('kylrx_org_country') || 'null');
            if (c && c.country) return c.country;
        } catch (_) { /* no storage */ }
        return null;
    }

    function config() {
        const live = root.KylrxCountryConfig;
        const raw = (live && live.code) || cachedCountry() || 'IN';
        const code = ALIASES[String(raw).trim().toLowerCase()] || (TABLE[String(raw).toUpperCase()] ? String(raw).toUpperCase() : 'IN');
        const base = TABLE[code];
        const timeZone = (root.KylrxOrgTimeZone || (live && live.timeZones && live.timeZones[0]) || base.timeZone);
        return { code, currency: base.currency, locale: base.locale, timeZone };
    }

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

    function money(value, opts) {
        const c = config();
        const o = opts || {};
        const decimals = o.decimals != null ? o.decimals : 2;
        return new Intl.NumberFormat(c.locale, { style: 'currency', currency: c.currency,
            minimumFractionDigits: o.decimals != null ? decimals : (Number.isInteger(num(value)) ? 0 : 2), maximumFractionDigits: decimals }).format(num(value));
    }

    /** Short money: lakh/crore for India, K/M/B elsewhere */
    function moneyCompact(value) {
        const c = config();
        const n = num(value);
        const sym = new Intl.NumberFormat(c.locale, { style: 'currency', currency: c.currency, maximumFractionDigits: 0 }).format(0).replace(/[\d\s.,]/g, '');
        const abs = Math.abs(n);
        const sign = n < 0 ? '-' : '';
        const fmt = (x, d) => Number(x.toFixed(d)).toString();
        if (c.code === 'IN') {
            if (abs >= 1e7) return `${sign}${sym}${fmt(abs / 1e7, 2)}Cr`;
            if (abs >= 1e5) return `${sign}${sym}${fmt(abs / 1e5, 2)}L`;
            if (abs >= 1e3) return `${sign}${sym}${fmt(abs / 1e3, 1)}K`;
        } else {
            if (abs >= 1e9) return `${sign}${sym}${fmt(abs / 1e9, 2)}B`;
            if (abs >= 1e6) return `${sign}${sym}${fmt(abs / 1e6, 2)}M`;
            if (abs >= 1e3) return `${sign}${sym}${fmt(abs / 1e3, 1)}K`;
        }
        return `${sign}${sym}${Math.round(abs)}`;
    }

    function number(value, maxFractionDigits) {
        return num(value).toLocaleString(config().locale, { maximumFractionDigits: maxFractionDigits == null ? 2 : maxFractionDigits });
    }

    function toDate(value) {
        // A plain calendar date (2026-11-11) means that day everywhere; do not let the time zone shift it
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
            const p = value.split('-');
            return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
        }
        const d = value instanceof Date ? value : new Date(value && value.toDate ? value.toDate() : value);
        return isNaN(d.getTime()) ? null : d;
    }

    /** Date in the company's locale; style "short" is 11 Nov 2026 / Nov 11, 2026 */
    function date(value, options) {
        const d = toDate(value);
        if (!d) return '';
        return d.toLocaleDateString(config().locale, options || { day: '2-digit', month: 'short', year: 'numeric' });
    }
    function dateTime(value, options) {
        const d = toDate(value);
        if (!d) return '';
        return d.toLocaleString(config().locale, options || { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    function time(value, options) {
        const d = toDate(value);
        if (!d) return '';
        return d.toLocaleTimeString(config().locale, options || { hour: '2-digit', minute: '2-digit' });
    }

    return {
        config, code: () => config().code, locale: () => config().locale, currency: () => config().currency,
        timeZone: () => config().timeZone, isIndia: () => config().code === 'IN',
        money, moneyCompact, number, date, dateTime, time
    };
}));
