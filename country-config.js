/**
 * Country configuration (IN / US / CA): one definition shared by the server and the pages.
 * A company's country comes from organizations/{orgId}.country (name or code); India is the
 * default so existing companies keep working unchanged.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.KylrxCountry = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const INDIA_ONLY_PAGES = [
        'admin-statutory-compliance.html',
        'statutory-compliance.html',
        'admin-bank-approvals.html',
        'admin-bank-transfer.html',
        'admin-payroll-disbursement.html',
        'payroll-disbursement.html',
        // India payroll in rupees with PF/ESIC and PAN; a US company pays through Gusto (admin-us-payroll.html)
        'admin-payroll-upload.html',
        'payroll-account-views.html',
        // the old demo assistant page with made-up figures; US companies use admin-us-assistant.html
        'admin-onboarding-ai.html',
        // Older India-era screens checked on 2026-11-20: made-up or India figures, browser reads a US company is not
        // allowed to make (so they show nothing real), or a newer US page does the job. A US company's home is us-home.html.
        'admin-dashboard.html', 'admin-central-dashboard.html', 'admin-pms.html', 'admin-notification-center.html',
        'admin-automation-builder.html', 'admin-workflow-builder.html', 'admin-assignment-matrix.html', 'admin-alert-builder.html',
        'admin-analytics-builder.html', 'admin-dashboard-builder.html', 'admin-policy-center.html', 'admin-asset-management.html',
        'admin-exit-management.html', 'admin-attendance-monitor.html', 'admin-leave-management.html', 'admin-document-templates.html',
        'admin-payroll-documents.html', 'bulk-trigger-dashboard.html', 'controls-acceptance-hub.html', 'admin-inactivity-monitor.html',
        'admin-hr-console.html', 'admin-analysis.html', 'operational-dashboard.html', 'tvc-dashboard.html',
        'admin-manager-change.html', 'admin-conversion-hub.html', 'admin-notifications.html', 'admin-message.html',
        'admin-onboarding-config.html', 'admin-onboarding-upload.html', 'manager-dashboard.html', 'admin-settings.html'
    ];

    const COUNTRIES = {
        IN: {
            code: 'IN',
            name: 'India',
            currency: 'INR',
            locale: 'en-IN',
            dateFormat: 'DD/MM/YYYY',
            timeZones: ['Asia/Kolkata'],
            taxIdLabel: 'PAN',
            companyIdFields: ['PAN', 'TAN', 'GSTIN', 'CIN_or_LLPIN'],
            personalIdLabel: 'Aadhaar / PAN',
            payrollProvider: 'built-in',
            hiddenPages: [],
            modules: ['pf', 'esic', 'pt', 'lwf', 'nps', 'gratuity', 'bank-disbursement']
        },
        US: {
            code: 'US',
            name: 'United States',
            currency: 'USD',
            locale: 'en-US',
            dateFormat: 'MM/DD/YYYY',
            timeZones: [
                'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
                'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'
            ],
            taxIdLabel: 'EIN',
            companyIdFields: ['EIN', 'State_Tax_ID', 'Entity_Type'],
            personalIdLabel: 'SSN',
            payrollProvider: 'gusto-embedded',
            hiddenPages: INDIA_ONLY_PAGES,
            modules: ['w4', 'i9', 'overtime', 'paid-sick-leave', 'new-hire-reporting', 'payroll-provider']
        },
        CA: {
            code: 'CA',
            name: 'Canada',
            currency: 'CAD',
            locale: 'en-CA',
            dateFormat: 'YYYY-MM-DD',
            timeZones: [
                'America/St_Johns', 'America/Halifax', 'America/Toronto', 'America/Winnipeg',
                'America/Edmonton', 'America/Vancouver'
            ],
            taxIdLabel: 'BN',
            companyIdFields: ['BN', 'Province_Tax_ID', 'Entity_Type'],
            personalIdLabel: 'SIN',
            payrollProvider: 'tbd',
            hiddenPages: INDIA_ONLY_PAGES,
            modules: ['td1', 'cpp-ei', 'roe', 't4']
        }
    };

    const ALIASES = {
        in: 'IN', india: 'IN', ind: 'IN',
        us: 'US', usa: 'US', 'united states': 'US', 'united states of america': 'US', america: 'US', 'u.s.': 'US', 'u.s.a.': 'US',
        ca: 'CA', can: 'CA', canada: 'CA'
    };

    /** Accepts a code or a name ("US", "United States", "india"); anything unknown falls back to India. */
    function resolveCountryCode(value) {
        const key = String(value || '').trim().toLowerCase();
        return ALIASES[key] || 'IN';
    }

    function getCountryConfig(value) {
        return COUNTRIES[resolveCountryCode(value)];
    }

    function isPageHidden(value, pageName) {
        const page = String(pageName || '').split('?')[0].split('#')[0].split('/').pop();
        return getCountryConfig(value).hiddenPages.indexOf(page) !== -1;
    }

    return { COUNTRIES, INDIA_ONLY_PAGES, resolveCountryCode, getCountryConfig, isPageHidden };
}));
