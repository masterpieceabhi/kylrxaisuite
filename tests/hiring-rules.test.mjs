import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const H = require('../services/hiring-rules.js');

const goodReq = { title: 'Cashier', department: 'Retail', location: 'Austin, TX', employmentType: 'part_time', headcount: 2, payMin: 15, payMax: 18, payUnit: 'hour' };

test('requisition validation accepts a good one and rejects bad fields', () => {
    assert.deepEqual(H.validateRequisition(goodReq).errors, []);
    const bad = H.validateRequisition({ ...goodReq, title: '', employmentType: 'x', headcount: 0, payMin: 20, payMax: 10 });
    assert.ok(bad.errors.length >= 4);
    assert.ok(H.validateRequisition({ ...goodReq, state: 'Texas' }).errors.some((e) => /state/.test(e)));
});

test('opening a requisition needs every approver to approve', () => {
    const r = { status: 'draft', approvals: [{ userId: 'a', name: 'Ann', decision: 'pending' }] };
    assert.equal(H.canSetRequisitionStatus(r, 'open').ok, false);
    r.approvals[0].decision = 'approved';
    assert.equal(H.canSetRequisitionStatus(r, 'open').ok, true);
    assert.equal(H.canSetRequisitionStatus({ status: 'draft', approvals: [] }, 'filled').ok, false);
});

test('public application: name, email, phone, privacy notice', () => {
    const ok = H.validateApplication({ name: 'Mary Ann Smith', email: ' Mary@Example.COM ', phone: '(512) 555-0100', privacyAccepted: 'true' });
    assert.deepEqual(ok.errors, []); assert.equal(ok.value.email, 'mary@example.com'); assert.equal(ok.value.lastName, 'Ann Smith');
    assert.equal(H.validateApplication({ name: 'Mary', email: 'x', phone: '12', privacyAccepted: false }).errors.length, 4);
    assert.equal(H.validateApplication({ name: 'A B', email: 'a@b.co', phone: '5125550100', privacyAccepted: true, source: 'bogus' }).value.source, 'careers_page');
});

test('honeypot is detected', () => {
    assert.equal(H.isHoneypotTripped({ website: 'http://spam' }), true);
    assert.equal(H.isHoneypotTripped({ website: '  ' }), false);
});

test('resume accepts only real PDF and DOCX and checks the name', () => {
    const pdf = { buffer: Buffer.from('%PDF-1.4\n...'), originalname: 'cv.pdf' };
    assert.equal(H.validateResume(pdf).value.kind, 'pdf');
    assert.ok(H.validateResume({ ...pdf, originalname: 'cv.docx' }).errors[0].includes('.docx'));
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('....[Content_Types].xml....word/document.xml')]);
    assert.equal(H.validateResume({ buffer: docx, originalname: 'cv.docx' }).value.kind, 'docx');
    assert.ok(H.validateResume({ buffer: Buffer.from('MZ\x90\x00'), originalname: 'cv.pdf' }).errors.length);
    assert.ok(H.validateResume({ buffer: Buffer.from([0x50, 0x4b, 3, 4, 1, 2]), originalname: 'cv.docx' }).errors.length, 'plain zip is not a docx');
    assert.ok(H.validateResume({ buffer: Buffer.alloc(H.MAX_RESUME_BYTES + 1, 37), originalname: 'cv.pdf' }).errors.length);
    assert.ok(H.validateResume(null).errors.length);
});

test('stage moves: forward, back, out, reopen, hired only from offer', () => {
    assert.equal(H.canMoveStage('applied', 'interview').ok, true);
    assert.equal(H.canMoveStage('interview', 'screen').ok, true);
    assert.equal(H.canMoveStage('interview', 'hired').ok, false);
    assert.equal(H.canMoveStage('offer', 'hired').ok, true);
    assert.equal(H.canMoveStage('rejected', 'offer').ok, false);
    assert.equal(H.canMoveStage('rejected', 'screen').ok, true);
    assert.equal(H.canMoveStage('hired', 'screen').ok, false);
    assert.equal(H.canMoveStage('applied', 'applied').ok, false);
    assert.equal(H.managerMayMove('interview'), true); assert.equal(H.managerMayMove('offer'), false); assert.equal(H.managerMayMove('rejected'), false);
});

test('stage history closes the previous stage', () => {
    let h = H.addStageHistory([], 'applied', '2026-01-01T00:00:00Z', 'x');
    h = H.addStageHistory(h, 'screen', '2026-01-03T00:00:00Z', 'u', 'phone');
    assert.equal(h[0].leftAt, '2026-01-03T00:00:00Z'); assert.equal(h[1].leftAt, null); assert.equal(h[1].note, 'phone');
});

test('scorecard needs a 1-5 rating for every competency and a recommendation', () => {
    const comps = ['A', 'B'];
    const r = H.validateScorecard({ ratings: { A: 5, B: 3 }, recommendation: 'yes', notes: 'good' }, comps);
    assert.deepEqual(r.errors, []); assert.equal(r.value.average, 4);
    assert.equal(H.validateScorecard({ ratings: { A: 6 }, recommendation: 'maybe' }, comps).errors.length, 3);
    assert.equal(H.validateScorecard({ ratings: { A: 2.5, B: 1 }, recommendation: 'no' }, comps).errors.length, 1);
});

test('interview and offer validation', () => {
    assert.deepEqual(H.validateInterview({ when: '2026-12-01T15:00:00Z', interviewers: ['Pat'] }).errors, []);
    assert.equal(H.validateInterview({ when: 'nope', interviewers: [] }).errors.length, 2);
    assert.deepEqual(H.validateOffer({ payRate: 20, payUnit: 'hour', startDate: '2026-12-01', jobTitle: 'Cashier' }).errors, []);
    assert.equal(H.validateOffer({ payRate: -1, payUnit: 'week', startDate: '2026-02-30', jobTitle: '' }).errors.length, 4);
});

test('duplicates are matched by email ignoring case', () => {
    const list = [{ id: '1', email: 'A@x.com' }, { id: '2', email: 'b@x.com' }];
    assert.equal(H.findDuplicates(list, ' a@X.com').length, 1);
    assert.equal(H.findDuplicates(list, 'a@x.com', '1').length, 0);
});

test('funnel counts, reached stages, time in stage and sources', () => {
    const c = (stage, source, hist) => ({ stage, source, stageHistory: hist });
    const f = H.funnel([
        c('hired', 'referral', [{ stage: 'applied', enteredAt: '2026-01-01T00:00:00Z', leftAt: '2026-01-03T00:00:00Z' }, { stage: 'offer', enteredAt: '2026-01-03T00:00:00Z', leftAt: '2026-01-05T00:00:00Z' }, { stage: 'hired', enteredAt: '2026-01-05T00:00:00Z', leftAt: null }]),
        c('applied', 'careers_page', [{ stage: 'applied', enteredAt: '2026-01-01T00:00:00Z', leftAt: null }])
    ], '2026-01-05T00:00:00Z');
    assert.equal(f.total, 2); assert.equal(f.current.hired, 1); assert.equal(f.reached.applied, 2); assert.equal(f.reached.offer, 1);
    assert.equal(f.timeInStageDays.applied, 3); assert.equal(f.bySource.referral.hired, 1);
    assert.equal(f.conversionPercent.applied_to_screen, 0);
});

test('applicant EEO totals hide small groups', () => {
    assert.equal(H.aggregateApplicantEeo([{ sex: 'male' }]).suppressed, true);
    const recs = Array.from({ length: 6 }, (_, i) => ({ sex: i % 2 ? 'male' : 'female', hispanic: i === 0 ? 'yes' : 'no', races: i === 1 ? ['asian'] : [], veteran: 'declined', disability: 'no' }));
    const a = H.aggregateApplicantEeo(recs);
    assert.equal(a.total, 6); assert.equal(a.sex.male, 3); assert.equal(a.raceEthnicity.hispanic, 1);
});

test('limiter blocks after max in the window and recovers', () => {
    const l = H.createLimiter({ max: 2, windowMs: 1000 });
    assert.equal(l.check('ip', 0).ok, true); assert.equal(l.check('ip', 10).ok, true);
    const blocked = l.check('ip', 20); assert.equal(blocked.ok, false); assert.ok(blocked.retryAfterSec >= 1);
    assert.equal(l.check('other', 20).ok, true);
    assert.equal(l.check('ip', 1500).ok, true);
});
