require('dotenv').config();

const { loadConfig } = require('./config');
const initializeDatabase = require('./database/initDatabase');
const EmailModel = require('./models/emailModel');
const ApiKeyModel = require('./models/apiKeyModel');
const { createApp } = require('./server');
const { createIngest } = require('./mail/ingest');
const { createEvents } = require('./mail/events');
const { createWebhook } = require('./mail/webhook');
const { createRelay } = require('./mail/relay');
const { createSmtpServer, listen: listenSmtp } = require('./mail/smtpServer');
const { logToFile } = require('./utils/logger');
const { Metrics } = require('./utils/metrics');

const HOUR_MS = 60 * 60 * 1000;

function scheduleRetention(emailModel, retentionDays) {
    if (!retentionDays) return;
    const purge = async () => {
        try {
            const cutoff = new Date(Date.now() - retentionDays * 24 * HOUR_MS);
            const deleted = await emailModel.deleteOlderThan(cutoff);
            if (deleted) logToFile(`Retention: deleted ${deleted} email(s) older than ${retentionDays} day(s)`);
        } catch (error) {
            logToFile(`Retention cleanup failed: ${error.message}`);
        }
    };
    purge();
    setInterval(purge, HOUR_MS).unref();
}

async function main() {
    const config = loadConfig();
    if (config.authDisabled) {
        logToFile('WARNING: AUTH_DISABLED=true - the API and dashboard are open to anyone who can reach this server');
    }

    const db = await initializeDatabase();
    const emailModel = new EmailModel(db);
    // Dashboard-created API keys are encrypted with a key derived from SESSION_SECRET
    const apiKeyModel = new ApiKeyModel(db, { encryptionSecret: config.sessionSecret });
    const activeKeys = (await apiKeyModel.list()).filter(k => !k.revokedAt).length;
    if (!config.authDisabled && activeKeys === 0) {
        logToFile('No API keys yet: sign in to the dashboard and create one on the API keys page');
    }
    scheduleRetention(emailModel, config.retentionDays);

    const events = createEvents();
    const metrics = new Metrics();
    const webhook = createWebhook({ url: config.webhookUrl, secret: config.webhookSecret, metrics });
    if (webhook) logToFile(`Webhook enabled: new emails are POSTed to ${new URL(config.webhookUrl).host}`);
    const relay = createRelay(config, metrics);
    if (relay) logToFile(`Relay enabled: mail for ${config.relayAllow.length} allowed recipient rule(s) is forwarded via ${config.relayHost}`);
    const ingest = createIngest({ emailModel, events, webhook, relay, metrics });
    const app = createApp({ config, emailModel, apiKeyModel, ingest, events, metrics });
    const server = app.listen(config.port, () => {
        logToFile(`Dashboard and API are running on http://localhost:${config.port}`);
    });

    const smtp = createSmtpServer({ config, ingest, metrics });
    const smtpPort = await listenSmtp(smtp, { port: config.smtpPort, host: config.smtpHost });
    const tlsNote = config.smtpTlsKey ? ', STARTTLS available' : '';
    logToFile(
        `SMTP server is listening on ${config.smtpHost}:${smtpPort} ` +
        `(${config.smtpUsername ? 'login required' : 'any or no login accepted'}${tlsNote})`
    );
    const smtpServers = [smtp];
    if (config.smtpTlsPort) {
        const smtpTls = createSmtpServer({ config, ingest, secure: true, metrics });
        const tlsPort = await listenSmtp(smtpTls, { port: config.smtpTlsPort, host: config.smtpHost });
        logToFile(`SMTP over TLS is listening on ${config.smtpHost}:${tlsPort}`);
        smtpServers.push(smtpTls);
    }
    if (config.smtpAllowedDomains.length) logToFile(`SMTP accepts mail only for ${config.smtpAllowedDomains.length} allowed domain rule(s)`);

    handleShutdown({ server, smtpServers, db });
}

// Stop accepting connections, let in-flight requests finish, then close the database.
// Without this, `docker stop` waits its full timeout and then kills the process.
function handleShutdown({ server, smtpServers, db }) {
    let shuttingDown = false;
    const shutdown = signal => {
        if (shuttingDown) return;
        shuttingDown = true;
        logToFile(`${signal} received, shutting down`);
        setTimeout(() => {
            logToFile('Shutdown timed out, exiting');
            process.exit(1);
        }, 8000).unref();
        const closing = [...smtpServers.map(smtp => new Promise(resolve => smtp.close(resolve))), new Promise(resolve => server.close(resolve))];
        server.closeIdleConnections();
        Promise.all(closing).then(async () => {
            try {
                await db.close();
            } catch (error) {
                logToFile(`Error closing database: ${error.message}`);
            }
            process.exit(0);
        });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
    logToFile(`Startup failed: ${error.stack || error}`);
    process.exit(1);
});
