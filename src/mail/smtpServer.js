const { SMTPServer } = require('smtp-server');
const { safeEqual } = require('../utils/session');
const { logToFile } = require('../utils/logger');

// Accepts every message, from anyone to anyone, and stores it. Nothing is ever relayed.
// STARTTLS is not offered: the server has no certificate, and clients that are told TLS is available
// would reject the self-signed one. Point your app at it with TLS off (secure: false, ignoreTLS: true).
function createSmtpServer({ config, ingest }) {
    const authRequired = Boolean(config.smtpUsername);

    const server = new SMTPServer({
        banner: 'Email Test Service',
        authOptional: !authRequired,
        allowInsecureAuth: true,
        disabledCommands: ['STARTTLS'],
        size: config.maxEmailBytes,
        logger: false,

        onAuth(auth, session, callback) {
            if (!authRequired) return callback(null, { user: auth.username || 'anonymous' });
            // Evaluate both so timing doesn't reveal which one was wrong
            const userOk = safeEqual(auth.username || '', config.smtpUsername);
            const passOk = safeEqual(auth.password || '', config.smtpPassword);
            if (userOk && passOk) return callback(null, { user: auth.username });
            logToFile(`SMTP login failed from ${session.remoteAddress}`);
            callback(new Error('Invalid username or password'));
        },

        onData(stream, session, callback) {
            const chunks = [];
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('error', callback);
            stream.on('end', async () => {
                if (stream.sizeExceeded) {
                    const error = new Error(`Message exceeds the ${Math.round(config.maxEmailBytes / 1048576)} MB limit`);
                    error.responseCode = 552;
                    return callback(error);
                }
                try {
                    const { id, size, recipients } = await ingest(Buffer.concat(chunks), {
                        envelope: session.envelope,
                        smtpUser: session.user || null,
                    });
                    // Only metadata is logged; subjects and bodies (often reset links or codes) never reach the log file
                    logToFile(`Stored email id=${id} size=${size} recipients=${recipients} from=${session.remoteAddress}`);
                    callback();
                } catch (error) {
                    logToFile(`Failed to store email: ${error.stack || error}`);
                    const failure = new Error('Could not store the message, try again');
                    failure.responseCode = 451;
                    callback(failure);
                }
            });
        },
    });

    server.on('error', error => logToFile(`SMTP server error: ${error.message}`));
    return server;
}

// Resolves with the bound port once listening; rejects if the port is taken
function listen(server, { port, host }) {
    return new Promise((resolve, reject) => {
        server.server.once('error', reject);
        server.listen(port, host, () => {
            server.server.removeListener('error', reject);
            resolve(server.server.address().port);
        });
    });
}

module.exports = { createSmtpServer, listen };
