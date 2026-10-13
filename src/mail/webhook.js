const crypto = require('crypto');
const { logToFile } = require('../utils/logger');

const TIMEOUT_MS = 5000;

// POSTs { event: 'email.received', email } to WEBHOOK_URL for every stored email, so a CI job or another
// service can react without polling. The email carries its summary, the detected `code` and `links`; fetch
// GET /api/emails/:id for the bodies. Failures are logged and never affect receiving mail; there are no retries.
// With WEBHOOK_SECRET set, the body is signed: X-Signature-256: sha256=<hex HMAC of the raw body>.
// Returns null when no URL is configured.
function createWebhook({ url, secret }) {
    if (!url) return null;
    const host = new URL(url).host; // logged instead of the URL, which may carry a token

    return async function notify(email) {
        const body = JSON.stringify({ event: 'email.received', email });
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'email-test-service',
            'X-Email-Event': 'email.received',
        };
        if (secret) headers['X-Signature-256'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
        try {
            const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
            logToFile(`Webhook to ${host} for email id=${email.id}: HTTP ${response.status}`);
        } catch (error) {
            logToFile(`Webhook to ${host} for email id=${email.id} failed: ${error.message}`);
        }
    };
}

module.exports = { createWebhook };
