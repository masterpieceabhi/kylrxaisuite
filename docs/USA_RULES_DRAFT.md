# USA version: rules draft (for review by a US payroll/HR professional)

Principle: build the HR core first; connect to a payroll provider (Check, Gusto Embedded, or similar) for tax calculation, filing and payments instead of building a US tax engine. Rates and thresholds change yearly, so none are hard-coded here; each must be loaded from a dated rules table and reviewed every January.

## 1. Country switch
- Company setting `country` (IN | US | CA) controls currency (INR | USD | CAD), date format, time zone, ID fields, and which modules show.
- US companies: hide PF, ESIC, PT, LWF, NPS, Gratuity, Aadhaar/PAN/IFSC/UAN.

## 2. Employee data (US)
- Legal name, address (state matters for tax), SSN (store encrypted, show last 4 only), date of birth, work state, home state.
- Classification: employee vs independent contractor (1099); exempt vs non-exempt (FLSA); full-time/part-time.
- Pay: hourly or salaried, pay frequency (weekly, biweekly, semi-monthly, monthly), direct deposit (routing + account).

## 3. Hiring paperwork
- **Form W-4** (federal withholding) collected at onboarding, plus state withholding form where required.
- **Form I-9**: employee completes Section 1 by the first day of work; employer completes Section 2 within 3 business days. Keep for 3 years after hire or 1 year after termination, whichever is later. Track document expiry for work-authorization re-verification.
- State new-hire reporting within the state's deadline (commonly 20 days).
- Offer letter, handbook acknowledgement, direct-deposit form.

## 4. Time, overtime and leave
- FLSA: non-exempt employees get overtime at 1.5x for hours over 40 per workweek; some states (e.g. California) also have daily overtime. Per-state rule table.
- Minimum wage: federal, state and city rates, effective-dated.
- Break/meal rules: per-state table.
- Paid sick leave: many states and cities mandate accrual and use; per-jurisdiction accrual rules and caps.
- PTO/vacation: company policy; some states require payout at termination.
- Holidays: US federal holiday calendar as default, company-editable.

## 5. Payroll (via provider)
- Employee taxes: federal income tax, Social Security, Medicare (plus Additional Medicare), state and local income tax, state disability/family leave where applicable.
- Employer taxes: Social Security, Medicare, FUTA, SUTA (per state rate).
- Year-end: W-2 to employees, W-3 and 941/940 filings, 1099-NEC for contractors.
- Deductions: pre-tax benefits (401(k), health), garnishments.

## 6. Documents and reporting
- Pay stub, W-2, offer letter, termination letter; I-9 audit report; new-hire report.

## 7. Security and privacy
- SSN and bank data encrypted at rest, access-logged, masked by default.
- State privacy laws (e.g. CCPA/CPRA for California employees); data retention schedule.
- Data stays in a US region.

## 8. Build order
1. Country switch + US employee profile + SSN handling.
2. W-4 / I-9 workflows with reminders and expiry tracking.
3. Time tracking with overtime rules per state.
4. Paid-sick-leave and PTO accrual engine.
5. Payroll-provider integration (hours in, pay stubs and tax filings back).
6. Pilot with 2 or 3 US businesses, then Canada.
