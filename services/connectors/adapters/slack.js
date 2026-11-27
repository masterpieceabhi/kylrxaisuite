/**
 * Slack: posts HR events to channels. Two modes: an Incoming Webhook URL, or a bot token with chat.postMessage.
 * Docs: https://api.slack.com/methods/chat.postMessage and https://api.slack.com/messaging/webhooks
 * Slack replies 200 with {"ok":false,"error":"..."} for most failures; 429 carries Retry-After.
 * Messages never include pay, tax or medical data (event payloads are already filtered).
 */
const { defineAdapter } = require('./_base');
const { describeEvent, routeFor } = require('./messages');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const API = 'https://slack.com/api';

function blocksFor(d) {
    return [
        { type: 'header', text: { type: 'plain_text', text: d.title.slice(0, 150) } },
        ...(d.lines.length ? [{ type: 'section', text: { type: 'mrkdwn', text: d.lines.map(esc).join('\n') } }] : []),
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(d.type)} · ${esc(d.at || '')}` }] }
    ];
}

module.exports = defineAdapter({
    key: 'slack', name: 'Slack', category: 'chat', vendor: 'Salesforce (Slack)',
    description: 'Posts new hires, time-off requests and approvals to Slack channels.',
    entities: [],
    credentialFields: [{ key: 'botToken', label: 'Bot token (xoxb-...)', secret: true }, { key: 'webhookUrl', label: 'Incoming webhook URL (alternative)', secret: true }],
    configFields: [{ key: 'defaultChannel', label: 'Default channel (e.g. #hr)', required: false }, { key: 'events', label: 'Events to send (comma list, e.g. person.created,leave.requested)', default: 'person.created,leave.requested,leave.approved,person.terminated' }, { key: 'routes', label: 'Channel per event (JSON, e.g. {"leave.*":"#time-off"})' }, { key: 'baseUrl', label: 'API base URL override' }],
    needsVerification: [
        'A Slack app installed to the workspace with chat:write (and chat:write.public or the bot invited to private channels)',
        'Channel IDs vs names: names work for public channels, private ones need the channel ID and an invited bot',
        'Rate limits (about 1 message/second per channel) with real traffic; Block Kit rendering in your workspace',
        'Incoming webhook mode fixes the channel at creation time; the channel setting is ignored there'
    ],
    defaultMappings: {},
    async authenticate(ctx) { return { headers: ctx.conn.credentials.botToken ? { Authorization: `Bearer ${ctx.conn.credentials.botToken}` } : {} }; },
    async healthCheck(ctx) {
        if (ctx.conn.credentials.botToken) {
            const r = await ctx.http.request({ method: 'POST', url: `${ctx.conn.config.baseUrl || API}/auth.test`, headers: ctx.auth.headers });
            if (!r.json || r.json.ok !== true) throw new Error(`Slack: ${(r.json && r.json.error) || 'auth failed'}`);
            return `bot connected to ${r.json.team || 'workspace'}`;
        }
        if (!/^https:\/\/hooks\.slack\.com\//.test(ctx.conn.credentials.webhookUrl || '') && !ctx.conn.config.baseUrl) throw new Error('webhookUrl must be a hooks.slack.com URL');
        return 'webhook URL configured (a test message is the only real check)';
    },
    async handleEvent(event, ctx) {
        const cfg = ctx.conn.config; const wanted = String(cfg.events || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (wanted.length && !wanted.some((w) => w === '*' || w === event.type || (w.endsWith('.*') && event.type.startsWith(w.slice(0, -1))))) return { sent: false, reason: 'event not selected' };
        const d = describeEvent(event);
        let routes = cfg.routes; if (typeof routes === 'string') { try { routes = JSON.parse(routes); } catch (_) { routes = {}; } }
        const channel = routeFor(routes, event.type, cfg.defaultChannel);
        const text = `${d.title}${d.lines.length ? `: ${d.lines[0]}` : ''}`;
        if (ctx.conn.credentials.botToken) {
            if (!channel) throw Object.assign(new Error('no channel configured'), { retryable: false });
            const r = await ctx.http.request({ method: 'POST', url: `${cfg.baseUrl || API}/chat.postMessage`, headers: ctx.auth.headers, json: { channel, text, blocks: blocksFor(d), unfurl_links: false } });
            if (!r.json || r.json.ok !== true) throw Object.assign(new Error(`Slack: ${(r.json && r.json.error) || 'unknown error'}`), { retryable: r.json && r.json.error === 'ratelimited' });
            return { sent: true, ts: r.json.ts };
        }
        await ctx.http.request({ method: 'POST', url: ctx.conn.credentials.webhookUrl, json: { text, blocks: blocksFor(d) } });
        return { sent: true };
    }
});
