const { parseEmail } = require('./parse');

// The one way mail enters the system: raw message bytes in, stored email id out.
// Used by the SMTP server and by the dashboard's "Send test" form.
function createIngest({ emailModel }) {
    return async function ingest(raw, options) {
        const record = await parseEmail(raw, options);
        const { id, timestamp } = await emailModel.create(record);
        return { id, timestamp, size: record.size, recipients: record.envelopeTo.length || record.to.length };
    };
}

module.exports = { createIngest };
