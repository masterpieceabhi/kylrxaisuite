/** Connector catalog: one entry per adapter; adding a connector = one file in adapters/ plus a line here */
const adapters = [
    require('./adapters/quickbooks'), require('./adapters/xero'), require('./adapters/netsuite'), require('./adapters/sap-s4'),
    require('./adapters/dynamics365'), require('./adapters/oracle-fusion'), require('./adapters/sage-intacct'), require('./adapters/workday-financials'),
    require('./adapters/slack'), require('./adapters/teams'), require('./adapters/google-workspace'), require('./adapters/scim-client'), require('./adapters/file-export')
];

const byKey = new Map(adapters.map((a) => [a.key, a]));
const get = (key) => byKey.get(String(key)) || null;

/** Public description for the catalog UI (no functions, no secrets) */
function describe(a) {
    return {
        key: a.key, name: a.name, category: a.category, vendor: a.vendor, description: a.description, eventDriven: a.eventDriven, batch: a.batch,
        entities: a.entities.map((e) => ({ key: e.key, label: e.label || e.key, direction: e.direction, source: e.source })),
        credentialFields: a.credentialFields, configFields: a.configFields, needsVerification: a.needsVerification,
        defaultMappings: a.defaultMappings
    };
}
const catalog = () => adapters.map(describe);

module.exports = { adapters, get, catalog, describe };
