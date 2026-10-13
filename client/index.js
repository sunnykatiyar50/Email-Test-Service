// A small client for E2E tests: wait for the email your app just sent, then read its code or link.
// No dependencies; needs Node 18+ (global fetch).
//
//   const { createClient } = require('./client');
//   const mail = createClient({ baseUrl: 'http://localhost:30004', apiKey: process.env.MAIL_API_KEY });
//
//   await signUp('user-7f3a@example.com');                       // your app sends the email
//   const code = await mail.waitForCode({ to: 'user-7f3a@example.com' });
//
// Use a unique recipient per test (or `after`, or clearInbox) so a test never reads another test's email.

class EmailTestError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'EmailTestError';
        this.status = status;
    }
}

class EmailTimeoutError extends EmailTestError {
    constructor(message) {
        super(message, 408);
        this.name = 'EmailTimeoutError';
    }
}

const FILTERS = ['to', 'from', 'subject', 'search', 'after', 'before'];

function createClient({
    baseUrl = process.env.MAIL_URL || 'http://localhost:30004',
    apiKey = process.env.MAIL_API_KEY,
    fetch: fetchImpl = globalThis.fetch,
} = {}) {
    const root = baseUrl.replace(/\/+$/, '');

    // Accepts Date objects for after/before; leaves out unset filters
    function query(params = {}) {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null || value === '') continue;
            search.set(key, value instanceof Date ? value.toISOString() : String(value));
        }
        const text = search.toString();
        return text ? `?${text}` : '';
    }

    async function request(path, { method = 'GET', params, signal } = {}) {
        const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
        const response = await fetchImpl(`${root}${path}${query(params)}`, { method, headers, signal });
        const body = await response.json().catch(() => ({}));
        return { response, body };
    }

    function fail(response, body) {
        throw new EmailTestError(body.error || `Request failed with HTTP ${response.status}`, response.status);
    }

    const pick = (options, keys) => Object.fromEntries(keys.filter(k => options[k] !== undefined).map(k => [k, options[k]]));

    return {
        // The newest matching email, or null
        async latestEmail(filters = {}) {
            const { response, body } = await request('/api/emails/latest', { params: pick(filters, FILTERS) });
            if (response.status === 404) return null;
            if (!response.ok) fail(response, body);
            return body;
        },

        // Summaries (no bodies): { emails, totalEmails, totalPages, currentPage }
        async listEmails({ page, pageSize, ...filters } = {}) {
            const { response, body } = await request('/api/emails', { params: { ...pick(filters, FILTERS), page, pageSize } });
            if (!response.ok) fail(response, body);
            return body;
        },

        async getEmail(id) {
            const { response, body } = await request(`/api/emails/${id}`);
            if (!response.ok) fail(response, body);
            return body;
        },

        // Waits (server side, one request) until an email matching the filters exists and returns it, including one
        // that is already stored. `timeout` is in seconds (default 30, at most 120).
        // Throws EmailTimeoutError if nothing arrives.
        async waitForEmail({ timeout = 30, ...filters } = {}) {
            const { response, body } = await request('/api/emails/wait', {
                params: { ...pick(filters, FILTERS), timeout },
                signal: AbortSignal.timeout((timeout + 10) * 1000),
            });
            if (response.status === 408) throw new EmailTimeoutError(body.error);
            if (!response.ok) fail(response, body);
            return body;
        },

        // The one-time code in the next matching email (the server detects it). Throws if the email has none.
        async waitForCode(options = {}) {
            const email = await this.waitForEmail(options);
            if (!email.code) throw new EmailTestError(`Email "${email.subject}" contains no one-time code`, 422);
            return email.code;
        },

        // A link from the next matching email: the first one, or the first matching `match`
        // (a string it must contain, a RegExp, or a function). Throws if there is none.
        async waitForLink({ match, ...options } = {}) {
            const email = await this.waitForEmail(options);
            const test =
                typeof match === 'function' ? match : match instanceof RegExp ? l => match.test(l) : match ? l => l.includes(match) : () => true;
            const link = email.links.find(test);
            if (!link) throw new EmailTestError(`Email "${email.subject}" has no matching link (found ${email.links.length})`, 422);
            return link;
        },

        // Deletes every email sent to an address; returns how many. Needs an admin token, not a Read key.
        async clearInbox(to) {
            if (!to) throw new TypeError('clearInbox needs an address');
            const { response, body } = await request('/api/emails', { method: 'DELETE', params: { to } });
            if (!response.ok) fail(response, body);
            return body.deleted;
        },

        async deleteEmail(id) {
            const { response, body } = await request(`/api/emails/${id}`, { method: 'DELETE' });
            if (!response.ok) fail(response, body);
        },
    };
}

module.exports = { createClient, EmailTestError, EmailTimeoutError };
