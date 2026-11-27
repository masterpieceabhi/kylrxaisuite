/**
 * Minimal OpenAI Chat Completions client shared by the AI assistants.
 * Configured with OPENAI_API_KEY (and optional OPENAI_MODEL) in .env; callers fall back to
 * rule-based logic, or say the assistant is off, when isConfigured() is false.
 * OPENAI_BASE_URL points the client at a stand-in server for local tests; it is ignored when NODE_ENV is production,
 * so a live server only ever sends its key to api.openai.com.
 */
const DEFAULT_BASE = 'https://api.openai.com/v1';
const TIMEOUT_MS = 45000;

function isConfigured() {
    return !!process.env.OPENAI_API_KEY;
}

function chatUrl() {
    const custom = process.env.NODE_ENV !== 'production' && process.env.OPENAI_BASE_URL;
    return `${String(custom || DEFAULT_BASE).replace(/\/+$/, '')}/chat/completions`;
}

/** One Chat Completions call; returns the parsed response body */
async function complete(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(chatUrl(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', ...body }),
            signal: controller.signal
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(`OpenAI error: ${(json.error && json.error.message) || res.status}`);
            err.status = 502;
            err.providerStatus = res.status;
            throw err;
        }
        return json;
    } catch (err) {
        if (err.name === 'AbortError') {
            const e = new Error('The AI service did not respond in time. Please try again.');
            e.status = 504;
            throw e;
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

const contentOf = (json) => (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';

/** Sends chat messages and returns the model's reply parsed as a JSON object. */
async function chatJson(messages, { temperature = 0.2 } = {}) {
    const json = await complete({ temperature, response_format: { type: 'json_object' }, messages });
    return JSON.parse(contentOf(json) || '{}');
}

/** Sends chat messages and returns { text, usage } with the model's plain-text reply. */
async function chatText(messages, { temperature = 0.2, maxTokens = 700 } = {}) {
    const json = await complete({ temperature, max_tokens: maxTokens, messages });
    return { text: String(contentOf(json)).trim(), usage: json.usage || null };
}

module.exports = { isConfigured, chatJson, chatText };
