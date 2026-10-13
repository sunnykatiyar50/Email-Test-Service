const { parseEmail } = require('./parse');
const { presentEmail } = require('./present');
const { logToFile } = require('../utils/logger');

// The one way mail enters the system: raw message bytes in, stored email id out.
// Used by the SMTP server and by the dashboard's "Send test" form. After storing, it wakes requests waiting
// in GET /api/emails/wait (events) and calls the webhook, if one is configured.
function createIngest({ emailModel, events = null, webhook = null }) {
    return async function ingest(raw, options) {
        const record = await parseEmail(raw, options);
        const { id, timestamp } = await emailModel.create(record);
        if (events) events.emit('email', id);
        if (webhook) {
            // Not awaited: a slow receiver must not delay the SMTP reply
            emailModel
                .get(id)
                .then(email => {
                    const { text, html, headers, ...summary } = presentEmail(email);
                    return webhook(summary);
                })
                .catch(error => logToFile(`Webhook preparation failed for email id=${id}: ${error.message}`));
        }
        return { id, timestamp, size: record.size, recipients: record.envelopeTo.length || record.to.length };
    };
}

module.exports = { createIngest };
