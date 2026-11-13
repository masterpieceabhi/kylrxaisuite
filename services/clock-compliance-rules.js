/**
 * Clock compliance rules (pure, no I/O): which notices/consents a worker needs before a clock method
 * is used, and what to do with one punch (allow / flag / block).
 *
 * The jurisdiction table is DATA the company can edit. The seed lists only well-known regimes and every
 * row is marked verify:true. Nothing here is legal advice: confirm every row with counsel.
 * The one-tap path is the default: with no policy nothing in this file is consulted.
 */
const crypto = require('crypto');

const METHODS = ['web', 'kiosk_pin', 'selfie_photo', 'geofence', 'biometric'];
const SELFIE_MODES = ['off', 'optional', 'required'];
const GEO_MODES = ['off', 'record', 'flag', 'block'];
const NOTE = 'Confirm with counsel before relying on this row.';

const CONSENT_TYPES = ['biometric_release', 'biometric_consent', 'monitoring_notice', 'nyc_biometric_notice', 'cpra_notice', 'photo_notice', 'location_notice'];

/** Seed rows. methods = clock methods the rule is triggered by; requires = notice/consent types */
const DEFAULT_JURISDICTIONS = [
    { key: 'IL_BIPA', name: 'Illinois Biometric Information Privacy Act (BIPA)', states: ['IL'], cities: [], methods: ['biometric'],
        requires: [{ type: 'biometric_release', level: 'written_release' }],
        summary: 'Written release before collecting biometric identifiers; a publicly available retention and destruction policy; destroy when the purpose is satisfied or within 3 years of the last interaction; no sale or profit from the data.',
        retention: { maxYears: 3, note: 'Destroy when the purpose is satisfied or within 3 years of last interaction, whichever is first.' } },
    { key: 'TX_CUBI', name: 'Texas Capture or Use of Biometric Identifier Act (CUBI)', states: ['TX'], cities: [], methods: ['biometric'],
        requires: [{ type: 'biometric_consent', level: 'informed_consent' }],
        summary: 'Informed consent before capture; destroy within a reasonable time, not later than 1 year after the purpose expires.',
        retention: { maxYears: 1, note: 'Destroy within a reasonable time, not later than 1 year after the purpose expires.' } },
    { key: 'WA_BIOMETRIC', name: 'Washington biometric identifiers law', states: ['WA'], cities: [], methods: ['biometric'],
        requires: [{ type: 'biometric_consent', level: 'notice_and_consent' }],
        summary: 'Notice and consent before enrolling a biometric identifier for a commercial purpose.', retention: null },
    { key: 'NY_MONITORING', name: 'New York electronic monitoring notice', states: ['NY'], cities: [], methods: ['selfie_photo', 'geofence', 'biometric'],
        requires: [{ type: 'monitoring_notice', level: 'written_acknowledgment' }],
        summary: 'Written notice of electronic monitoring at hire, acknowledged in writing (signed or electronic), and posted.', retention: null },
    { key: 'CT_MONITORING', name: 'Connecticut electronic monitoring notice', states: ['CT'], cities: [], methods: ['selfie_photo', 'geofence', 'biometric'],
        requires: [{ type: 'monitoring_notice', level: 'written_notice' }],
        summary: 'Prior written notice of the types of electronic monitoring used, posted in a conspicuous place.', retention: null },
    { key: 'DE_MONITORING', name: 'Delaware electronic monitoring notice', states: ['DE'], cities: [], methods: ['selfie_photo', 'geofence', 'biometric'],
        requires: [{ type: 'monitoring_notice', level: 'written_notice' }],
        summary: 'Notice (daily or one-time acknowledged) before monitoring telephone, email or internet use.', retention: null },
    { key: 'NYC_BIOMETRIC', name: 'New York City biometric identifier notice (commercial establishments)', states: ['NY'], cities: ['new york', 'new york city', 'nyc', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten island'], methods: ['biometric'],
        requires: [{ type: 'nyc_biometric_notice', level: 'notice' }],
        summary: 'Commercial establishments that collect biometric identifier information must post a clear notice.', retention: null },
    { key: 'CA_CPRA', name: 'California CCPA/CPRA notice at collection (sensitive personal information)', states: ['CA'], cities: [], methods: ['selfie_photo', 'geofence', 'biometric'],
        requires: [{ type: 'cpra_notice', level: 'notice_at_collection' }],
        summary: 'Notice at collection of the categories of personal information (including precise geolocation and biometric information) and the purposes and retention.', retention: null }
].map((r) => ({ ...r, verify: true, note: NOTE, enabled: true }));

/** Default notice texts (editable templates; each edit becomes a new version) */
const DEFAULT_NOTICES = {
    biometric_release: { title_en: 'Written release for biometric data', title_es: 'Autorización escrita para datos biométricos',
        body_en: 'Your employer would like to use a biometric identifier (for example a fingerprint or face template) only to confirm who is clocking in. Before anything is collected we need your written release. The data is used only for timekeeping, is never sold, and is destroyed when the purpose is satisfied or when you leave, within the limits of the law. The retention and destruction policy is available from HR. You may say no or withdraw at any time and use another way to clock in.',
        body_es: 'Su empleador quiere usar un identificador biométrico (por ejemplo una huella o un patrón facial) solo para confirmar quién registra la entrada. Antes de recopilar algo necesitamos su autorización por escrito. Los datos se usan solo para el control de horas, nunca se venden y se destruyen cuando se cumple el propósito o cuando usted se va, dentro de los límites de la ley. La política de retención y destrucción está disponible en Recursos Humanos. Puede decir que no o retirar su autorización en cualquier momento y usar otra forma de registrar su entrada.' },
    biometric_consent: { title_en: 'Consent for biometric data', title_es: 'Consentimiento para datos biométricos',
        body_en: 'Your employer would like to use a biometric identifier only to confirm who is clocking in. It is used for timekeeping only, is not sold, and is destroyed within a reasonable time after the purpose ends. You may say no or withdraw at any time and use another way to clock in.',
        body_es: 'Su empleador quiere usar un identificador biométrico solo para confirmar quién registra la entrada. Se usa solo para el control de horas, no se vende y se destruye en un plazo razonable después de que termine el propósito. Puede decir que no o retirar su consentimiento en cualquier momento y usar otra forma de registrar su entrada.' },
    monitoring_notice: { title_en: 'Notice of electronic monitoring', title_es: 'Aviso de monitoreo electrónico',
        body_en: 'This workplace uses electronic tools when you clock in or out: a photo you take at the clock, and/or your phone location at the moment you tap. It is not tracked between punches. Photos are seen only by your supervisors and HR and are deleted after a short time. Please confirm that you have read this notice.',
        body_es: 'Este lugar de trabajo usa herramientas electrónicas cuando usted registra entrada o salida: una foto que usted toma en el reloj y/o la ubicación de su teléfono en el momento en que toca el botón. No se le rastrea entre registros. Las fotos solo las ven sus supervisores y Recursos Humanos y se borran después de poco tiempo. Por favor confirme que leyó este aviso.' },
    nyc_biometric_notice: { title_en: 'Notice: biometric identifier information', title_es: 'Aviso: información de identificadores biométricos',
        body_en: 'This business may collect biometric identifier information to confirm who is clocking in. Please confirm that you have read this notice.',
        body_es: 'Este negocio puede recopilar información de identificadores biométricos para confirmar quién registra la entrada. Por favor confirme que leyó este aviso.' },
    cpra_notice: { title_en: 'Notice at collection (California)', title_es: 'Aviso al momento de la recopilación (California)',
        body_en: 'When you clock in or out we may collect a photo you take and your precise phone location at that moment. We use them only to confirm timekeeping, we do not sell or share them, and photos are deleted after a short retention period. You can withdraw at any time and use another way to clock in. Ask HR for the full retention schedule.',
        body_es: 'Cuando usted registra entrada o salida podemos recopilar una foto que usted toma y la ubicación precisa de su teléfono en ese momento. Los usamos solo para confirmar el control de horas, no los vendemos ni los compartimos, y las fotos se borran después de un periodo corto. Puede retirar su consentimiento en cualquier momento y usar otra forma de registrar su entrada. Pida a Recursos Humanos el calendario de retención completo.' },
    photo_notice: { title_en: 'Photo at the time clock', title_es: 'Foto en el reloj',
        body_en: 'You will be asked to take a photo when you clock in or out. It is only used by your supervisors to check the punch, it is never shown to coworkers, nothing is matched to a face, and it is deleted after a short time.',
        body_es: 'Se le pedirá una foto al registrar entrada o salida. Solo la usan sus supervisores para revisar el registro, nunca se muestra a compañeros, no se compara con ningún rostro y se borra después de poco tiempo.' },
    location_notice: { title_en: 'Location at the time clock', title_es: 'Ubicación en el reloj',
        body_en: 'When you clock in or out the app may check your phone location once, to see whether you are at a work site. Your location is not tracked between punches.',
        body_es: 'Al registrar entrada o salida la aplicación puede revisar la ubicación de su teléfono una vez, para ver si está en un lugar de trabajo. Su ubicación no se rastrea entre registros.' }
};

const textHashOf = (n) => crypto.createHash('sha256').update([n.title_en, n.body_en, n.title_es, n.body_es].join('\n')).digest('hex');

/* ------------------------------ policy ------------------------------ */

const DEFAULT_ANOMALY = { sharedDevice: true, impossibleTravel: true, outsideSchedule: true, repeatedTimestamps: true, newDevice: false };

/** Validates and normalizes a policy body */
function validatePolicy(body) {
    const errors = [];
    const b = body || {};
    const scope = ['org', 'state', 'location'].includes(b.scope) ? b.scope : 'org';
    const value = { scope };
    if (scope === 'state') {
        const st = String(b.state || '').trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(st)) errors.push('state must be a 2-letter state code'); else value.state = st;
    }
    if (scope === 'location') {
        if (!b.locationId) errors.push('locationId is required for a location policy'); else value.locationId = String(b.locationId);
    }
    const allowed = Array.isArray(b.allowedMethods) ? b.allowedMethods.map(String) : ['web', 'kiosk_pin'];
    allowed.forEach((m) => { if (!METHODS.includes(m)) errors.push(`Unknown method: ${m}`); });
    value.allowedMethods = Array.from(new Set(allowed.filter((m) => METHODS.includes(m))));
    const selfie = b.selfie === undefined ? 'off' : String(b.selfie);
    if (!SELFIE_MODES.includes(selfie)) errors.push('selfie must be off, optional or required'); else value.selfie = selfie;
    if (value.selfie !== 'off' && !value.allowedMethods.includes('selfie_photo')) value.allowedMethods.push('selfie_photo');
    const g = b.geofence || {};
    const mode = g.mode === undefined ? 'off' : String(g.mode);
    if (!GEO_MODES.includes(mode)) errors.push('geofence.mode must be off, record, flag or block');
    const acc = g.accuracyMeters === undefined ? 100 : Number(g.accuracyMeters);
    if (!(acc >= 10 && acc <= 5000)) errors.push('geofence.accuracyMeters must be between 10 and 5000');
    value.geofence = { mode: GEO_MODES.includes(mode) ? mode : 'off', accuracyMeters: acc };
    if (value.geofence.mode !== 'off' && !value.allowedMethods.includes('geofence')) value.allowedMethods.push('geofence');
    value.biometric = { enabled: Boolean(b.biometric && b.biometric.enabled) };
    if (value.biometric.enabled && !value.allowedMethods.includes('biometric')) value.allowedMethods.push('biometric');
    const days = b.photoRetentionDays === undefined ? 30 : Number(b.photoRetentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) errors.push('photoRetentionDays must be a whole number from 1 to 365'); else value.photoRetentionDays = days;
    value.punchTypes = Array.isArray(b.punchTypes) && b.punchTypes.length ? b.punchTypes.filter((t) => ['in', 'out', 'break_start', 'break_end'].includes(t)) : ['in', 'out'];
    value.requireNotice = Boolean(b.requireNotice);
    value.anomaly = { ...DEFAULT_ANOMALY, ...Object.fromEntries(Object.keys(DEFAULT_ANOMALY).filter((k) => b.anomaly && b.anomaly[k] !== undefined).map((k) => [k, Boolean(b.anomaly[k])])) };
    const sw = (b.sharedDeviceWorkers === undefined) ? 2 : Number(b.sharedDeviceWorkers);
    value.sharedDeviceWorkers = Number.isInteger(sw) && sw >= 2 && sw <= 10 ? sw : 2;
    const win = b.sharedDeviceWindowMinutes === undefined ? 120 : Number(b.sharedDeviceWindowMinutes);
    value.sharedDeviceWindowMinutes = win >= 5 && win <= 1440 ? Math.round(win) : 120;
    return { errors, value };
}

/** Most specific policy wins: location, then state, then company-wide */
function resolvePolicy(policies, { state, locationId } = {}) {
    const list = (policies || []).filter((p) => p && p.active !== false);
    return list.find((p) => p.scope === 'location' && locationId && p.locationId === locationId)
        || list.find((p) => p.scope === 'state' && state && p.state === String(state).toUpperCase())
        || list.find((p) => (p.scope || 'org') === 'org') || null;
}

/** The methods that are actually switched on by the policy and need a notice or consent when used */
function methodsInUse(policy) {
    if (!policy) return [];
    const allowed = policy.allowedMethods || [];
    const out = [];
    if (policy.selfie && policy.selfie !== 'off' && allowed.includes('selfie_photo')) out.push('selfie_photo');
    if (policy.geofence && policy.geofence.mode !== 'off' && allowed.includes('geofence')) out.push('geofence');
    if (policy.biometric && policy.biometric.enabled && allowed.includes('biometric')) out.push('biometric');
    return out;
}

const norm = (s) => String(s || '').trim().toLowerCase();
function ruleApplies(row, state, city) {
    if (row.enabled === false) return false;
    if (!(row.states || []).map((s) => String(s).toUpperCase()).includes(String(state || '').toUpperCase())) return false;
    if ((row.cities || []).length && !(row.cities || []).map(norm).includes(norm(city))) return false;
    return true;
}

/**
 * The notices/consents a worker must have on file before each method is used.
 * Returns { methods: {method: [types]}, types: [all types], rules: [{key,name,type,level,method}], inUse }.
 */
function requirements(policy, workState, city, rows = DEFAULT_JURISDICTIONS) {
    const inUse = methodsInUse(policy);
    const methods = {};
    const detail = [];
    for (const m of inUse) {
        const set = new Set();
        for (const row of rows) {
            if (!ruleApplies(row, workState, city) || !(row.methods || []).includes(m)) continue;
            for (const r of row.requires || []) { set.add(r.type); detail.push({ key: row.key, name: row.name, type: r.type, level: r.level, method: m, verify: row.verify !== false }); }
        }
        if (policy.requireNotice && m === 'selfie_photo') set.add('photo_notice');
        if (policy.requireNotice && m === 'geofence') set.add('location_notice');
        methods[m] = Array.from(set);
    }
    const types = Array.from(new Set(Object.values(methods).flat()));
    return { methods, types, rules: detail, inUse };
}

/** Status of one consent type for a person: ok | stale (older notice version) | declined | none */
function consentStatus(consents, type, currentVersion) {
    const mine = (consents || []).filter((c) => c.type === type).sort((a, b) => String(b.signedAt).localeCompare(String(a.signedAt)));
    const last = mine[0];
    if (!last) return 'none';
    if (last.revokedAt || last.decision === 'declined') return 'declined';
    if (currentVersion && Number(last.version) < Number(currentVersion)) return 'stale';
    return 'ok';
}

/** Blocks enabling biometrics in a place whose rule needs consent/notice until every affected worker has it */
function biometricGuard(policy, workers, rows, statusOf) {
    if (!policy || !policy.biometric || !policy.biometric.enabled) return { ok: true, missing: [] };
    const missing = [];
    for (const w of workers) {
        const req = requirements({ allowedMethods: ['biometric'], biometric: { enabled: true } }, w.workState, w.city, rows);
        const needed = req.methods.biometric || [];
        const lacking = needed.filter((t) => statusOf(w.userId, t) !== 'ok');
        if (lacking.length) missing.push({ userId: w.userId, workState: w.workState, types: lacking });
    }
    return { ok: missing.length === 0, missing };
}

/* ------------------------------ geometry and anomaly helpers ------------------------------ */

function haversineMeters(a, b) {
    const R = 6371000; const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nearest active site and whether the point is inside its radius */
function nearestSite(loc, sites) {
    let best = null;
    for (const s of sites || []) {
        if (s.active === false || !Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lng))) continue;
        const d = haversineMeters(loc, { lat: Number(s.lat), lng: Number(s.lng) });
        if (!best || d < best.distance) best = { id: s.id, name: s.name || null, distance: Math.round(d), radius: Number(s.radiusMeters) || 100 };
    }
    if (best) best.inside = best.distance <= best.radius;
    return best;
}

function impossibleTravel(prev, cur, maxKmh = 300) {
    if (!prev || !prev.location || !cur.location || !prev.at) return null;
    const hours = (new Date(cur.at).getTime() - new Date(prev.at).getTime()) / 3600000;
    const km = haversineMeters(prev.location, cur.location) / 1000;
    if (hours <= 0 || km < 2) return null;
    const kmh = km / Math.max(hours, 1 / 60);
    return kmh > maxKmh ? { km: Math.round(km), kmh: Math.round(kmh) } : null;
}

/** Same clock minute on 4 punches of the same type in a row (copy-paste or scripted punching) */
function repeatedTimes(punches, type, tz, nowIso, needed = 4) {
    const fmt = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    const same = (punches || []).filter((p) => p.type === type).slice(-(needed - 1)).map((p) => fmt(p.at));
    if (same.length < needed - 1) return false;
    const now = fmt(nowIso);
    return same.every((t) => t === now);
}

/** Shifts of the day vs punch time; only 'in' and 'out' are judged */
function outsideSchedule(shifts, type, nowIso, graceMinutes = 60) {
    if (!shifts || !shifts.length || !['in', 'out'].includes(type)) return null;
    const t = new Date(nowIso).getTime(); const g = graceMinutes * 60000;
    const ok = shifts.some((s) => t >= new Date(s.startAt).getTime() - g && t <= new Date(s.endAt).getTime() + g);
    return ok ? null : { shifts: shifts.length };
}

/** Other workers seen on the same personal device recently */
function sharedDevice(deviceDoc, userId, nowIso, windowMinutes, minOthers) {
    if (!deviceDoc || !deviceDoc.users) return null;
    const cutoff = new Date(nowIso).getTime() - windowMinutes * 60000;
    const others = Object.entries(deviceDoc.users).filter(([u, at]) => u !== userId && new Date(at).getTime() >= cutoff);
    return others.length >= minOthers ? { others: others.length } : null;
}

/* ------------------------------ punch evaluation ------------------------------ */

const MSG = {
    consent_required: ['Please read and accept the notice first.', 'Primero lea y acepte el aviso.'],
    selfie_required: ['A photo is required to clock in or out. Please take one.', 'Se requiere una foto para registrar. Tome una por favor.'],
    outside_geofence: ['You are outside the work site area.', 'Está fuera del área del lugar de trabajo.'],
    low_accuracy: ['Your phone location is not accurate enough. Move outside or turn on precise location and try again.', 'La ubicación de su teléfono no es lo bastante precisa. Salga al exterior o active la ubicación precisa e intente de nuevo.'],
    location_required: ['Location is required to clock in here. Please allow location and try again.', 'Se requiere la ubicación para registrar aquí. Permita la ubicación e intente de nuevo.'],
    method_declined: ['Check method declined; your supervisor will review.', 'Método rechazado; su supervisor lo revisará.'],
    biometric_unavailable: ['Biometric check is not available; used the normal clock instead.', 'La verificación biométrica no está disponible; se usó el reloj normal.'],
    no_location: ['No location was received.', 'No se recibió la ubicación.'],
    shared_device: ['This phone was used by other workers recently.', 'Este teléfono lo usaron otros trabajadores hace poco.'],
    new_device: ['New device for this worker.', 'Dispositivo nuevo para este trabajador.'],
    impossible_travel: ['Location is too far from the last punch for the time passed.', 'La ubicación está demasiado lejos del último registro para el tiempo transcurrido.'],
    outside_schedule: ['Punch is outside the scheduled shift.', 'El registro está fuera del turno programado.'],
    repeated_timestamp: ['The same clock time was punched several times in a row.', 'Se registró la misma hora varias veces seguidas.']
};
const reason = (code, severity, extra = {}) => ({ code, severity, en: MSG[code][0], es: MSG[code][1], ...extra });

/**
 * ctx: { policy, rules, workState, city, type, source, hasPhoto, location, statuses:{type:status}, sites,
 *        deviceHash, deviceDoc, userDeviceHashes, prev, recent, shifts, nowIso, tz, userId, locationScoped }
 */
function evaluatePunch(ctx) {
    const out = { decision: 'allow', reasons: [], pendingTypes: [], usePhoto: false, storeLocation: true, distanceMeters: null, nearest: null };
    const policy = ctx.policy;
    if (!policy) return out;
    const finish = () => { out.decision = out.reasons.some((r) => r.severity === 'block') ? 'block' : out.reasons.length ? 'flag' : 'allow'; return out; };
    const enforce = (policy.punchTypes || ['in', 'out']).includes(ctx.type);
    const req = requirements(policy, ctx.workState, ctx.city, ctx.rules);
    const disabled = new Set(); const pending = new Set();
    const blocking = { selfie_photo: policy.selfie === 'required', geofence: ['flag', 'block'].includes(policy.geofence.mode), biometric: false };
    for (const m of req.inUse) {
        for (const t of req.methods[m] || []) {
            const s = (ctx.statuses || {})[t] || 'none';
            if (s === 'declined') disabled.add(m);
            else if (s !== 'ok') { pending.add(t); if (!blocking[m]) disabled.add(m); }
        }
    }
    if (pending.size && req.inUse.some((m) => blocking[m] && (req.methods[m] || []).some((t) => pending.has(t))) && enforce) {
        out.pendingTypes = Array.from(pending);
        out.reasons.push(reason('consent_required', 'block'));
        out.storeLocation = false;
        return finish();
    }
    for (const m of req.inUse) {
        if (disabled.has(m) && enforce && blocking[m]) out.reasons.push(reason('method_declined', 'flag', { method: m }));
    }
    if (req.inUse.includes('biometric') && !disabled.has('biometric')) out.reasons.push(reason('biometric_unavailable', 'flag'));

    // photo
    const selfieOn = req.inUse.includes('selfie_photo') && !disabled.has('selfie_photo') && enforce;
    if (selfieOn) {
        if (ctx.hasPhoto) out.usePhoto = true;
        else if (policy.selfie === 'required') out.reasons.push(reason('selfie_required', 'block'));
    }
    // location
    const geoOn = req.inUse.includes('geofence') && !disabled.has('geofence');
    out.storeLocation = geoOn && Boolean(ctx.location);
    if (geoOn && enforce) {
        const mode = policy.geofence.mode;
        const sev = mode === 'block' ? 'block' : 'flag';
        if (!ctx.location) {
            if (mode === 'block') out.reasons.push(reason('location_required', 'block'));
            else if (mode === 'flag') out.reasons.push(reason('no_location', 'flag'));
        } else {
            const near = nearestSite(ctx.location, ctx.sites);
            if (near) { out.nearest = near; out.distanceMeters = near.distance; }
            const poor = Number.isFinite(ctx.location.accuracy) && ctx.location.accuracy > policy.geofence.accuracyMeters;
            if (mode === 'flag' || mode === 'block') {
                if (poor) out.reasons.push(reason('low_accuracy', sev, { accuracy: ctx.location.accuracy }));
                else if (near && !near.inside) out.reasons.push(reason('outside_geofence', sev, { distanceMeters: near.distance, site: near.name }));
            }
        }
    }
    // anomaly checks: flags only, never block
    const a = policy.anomaly || DEFAULT_ANOMALY;
    if (a.sharedDevice && ctx.source !== 'kiosk' && ctx.deviceHash) {
        const sd = sharedDevice(ctx.deviceDoc, ctx.userId, ctx.nowIso, policy.sharedDeviceWindowMinutes || 120, (policy.sharedDeviceWorkers || 2) - 1);
        if (sd) out.reasons.push(reason('shared_device', 'flag', sd));
    }
    if (a.newDevice && ctx.source !== 'kiosk' && ctx.deviceHash && (ctx.userDeviceHashes || []).length && !ctx.userDeviceHashes.includes(ctx.deviceHash)) out.reasons.push(reason('new_device', 'flag'));
    if (a.impossibleTravel && ctx.location) {
        const it = impossibleTravel(ctx.prev, { location: ctx.location, at: ctx.nowIso });
        if (it) out.reasons.push(reason('impossible_travel', 'flag', it));
    }
    if (a.outsideSchedule) { const os = outsideSchedule(ctx.shifts, ctx.type, ctx.nowIso); if (os) out.reasons.push(reason('outside_schedule', 'flag')); }
    if (a.repeatedTimestamps && repeatedTimes(ctx.recent, ctx.type, ctx.tz, ctx.nowIso)) out.reasons.push(reason('repeated_timestamp', 'flag'));
    return finish();
}

/* ------------------------------ photo upload validation ------------------------------ */

const MAX_PHOTO_BYTES = 300 * 1024;
/** Accepts a data URL or bare base64 JPEG up to ~300 KB */
function parsePhoto(input) {
    if (!input) return { ok: false, error: 'missing' };
    const raw = String(input).replace(/^data:image\/jpe?g;base64,/i, '');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) return { ok: false, error: 'not_base64' };
    if (raw.length > MAX_PHOTO_BYTES * 1.4) return { ok: false, error: 'too_large' };
    const buf = Buffer.from(raw, 'base64');
    if (buf.length > MAX_PHOTO_BYTES) return { ok: false, error: 'too_large' };
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return { ok: false, error: 'not_jpeg' };
    return { ok: true, buffer: buf };
}

module.exports = {
    METHODS, SELFIE_MODES, GEO_MODES, CONSENT_TYPES, DEFAULT_JURISDICTIONS, DEFAULT_NOTICES, DEFAULT_ANOMALY, MAX_PHOTO_BYTES,
    textHashOf, validatePolicy, resolvePolicy, methodsInUse, ruleApplies, requirements, consentStatus, biometricGuard,
    haversineMeters, nearestSite, impossibleTravel, repeatedTimes, outsideSchedule, sharedDevice, evaluatePunch, parsePhoto, MSG
};
