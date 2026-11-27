/**
 * Microsoft Teams: posts HR events as Adaptive Cards to a channel through a Workflows (Power Automate) webhook URL,
 * the replacement for the retired Office 365 "Incoming Webhook" connectors.
 * Docs: https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook
 */
const { defineAdapter } = require('./_base');
const { describeEvent } = require('./messages');

function card(d) {
    return {
        type: 'message',
        attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null,
            content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
                body: [
                    { type: 'TextBlock', text: d.title, weight: 'Bolder', size: 'Medium', wrap: true },
                    ...d.lines.map((t) => ({ type: 'TextBlock', text: t, wrap: true, spacing: 'Small' })),
                    { type: 'TextBlock', text: `${d.type} · ${d.at || ''}`, isSubtle: true, size: 'Small', wrap: true }
                ]
            }
        }]
    };
}

module.exports = defineAdapter({
    key: 'teams', name: 'Microsoft Teams', category: 'chat', vendor: 'Microsoft',
    description: 'Posts new hires, time-off requests and approvals to a Teams channel.',
    entities: [],
    credentialFields: [{ key: 'webhookUrl', label: 'Workflows webhook URL', secret: true }],
    configFields: [{ key: 'events', label: 'Events to send (comma list)', default: 'person.created,leave.requested,leave.approved,person.terminated' }],
    needsVerification: [
        'Create the webhook with the Teams "Workflows" app (Post to a channel when a webhook request is received); the exact URL host differs by tenant/region',
        'Adaptive Card version support in your Teams clients and message size limit (about 28 KB)',
        'Teams answers 202 for accepted cards and may rate limit; the workflow run history is the real delivery proof'
    ],
    defaultMappings: {},
    async authenticate() { return {}; },
    async healthCheck(ctx) {
        let u; try { u = new URL(ctx.conn.credentials.webhookUrl); } catch (_) { throw new Error('webhookUrl is not a valid URL'); }
        if (u.protocol !== 'https:' && !ctx.conn.config.allowHttp) throw new Error('webhookUrl must be https');
        return 'webhook URL configured (send a test event to verify delivery)';
    },
    async handleEvent(event, ctx) {
        const wanted = String(ctx.conn.config.events || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (wanted.length && !wanted.some((w) => w === '*' || w === event.type || (w.endsWith('.*') && event.type.startsWith(w.slice(0, -1))))) return { sent: false, reason: 'event not selected' };
        await ctx.http.request({ method: 'POST', url: ctx.conn.credentials.webhookUrl, json: card(describeEvent(event)) });
        return { sent: true };
    }
});
module.exports.card = card;
