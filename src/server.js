const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createAuth } = require('./middleware/auth');
const createEmailRoutes = require('./routes/emailRoutes');
const createApiKeyRoutes = require('./routes/apiKeyRoutes');
const { logToFile } = require('./utils/logger');

const viewsDir = path.join(__dirname, 'views');

// Builds the Express app. Kept separate from app.js so tests can create it with their own config and database.
function createApp({ config, emailModel, apiKeyModel, ingest, events }) {
    const app = express();
    const auth = createAuth(config, { apiKeyModel });

    if (config.trustProxy) {
        // e.g. TRUST_PROXY=1 behind one reverse proxy, so req.ip / req.secure reflect the real client
        const hops = Number(config.trustProxy);
        app.set('trust proxy', Number.isInteger(hops) ? hops : config.trustProxy);
    }

    app.use(
        helmet({
            contentSecurityPolicy: {
                directives: {
                    'default-src': ["'self'"],
                    'script-src': ["'self'"],
                    'style-src': ["'self'"],
                    'img-src': ["'self'", 'data:'],
                    // the email preview is a same-origin iframe (it sets its own, stricter policy)
                    'frame-src': ["'self'"],
                    'form-action': ["'self'"],
                    'frame-ancestors': ["'none'"],
                    // the dashboard is often served over plain HTTP on a LAN address
                    'upgrade-insecure-requests': null,
                },
            },
        })
    );
    // Large enough for the "Send test" form's HTML body
    app.use(express.json({ limit: '600kb' }));

    app.get('/health', async (req, res) => {
        try {
            await emailModel.ping();
            res.json({ status: 'ok' });
        } catch {
            res.status(503).json({ status: 'error' });
        }
    });

    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        message: { error: 'Too many login attempts, try again later.' },
    });
    app.post('/auth/login', loginLimiter, auth.login);
    app.post('/auth/logout', auth.logout);
    app.get('/auth/status', auth.status);

    // Where to point SMTP clients; the dashboard uses it for its setup examples
    app.get('/api/info', auth.requireRead, (req, res) => {
        res.json({
            smtpPort: config.smtpPort,
            smtpAuthRequired: Boolean(config.smtpUsername),
            smtpStartTls: Boolean(config.smtpTlsKey),
            smtpTlsPort: config.smtpTlsPort || null,
            smtpSimulate: config.smtpSimulate,
            smtpAllowedDomains: config.smtpAllowedDomains.map(rule => (rule.type === 'subdomains' ? `*.${rule.value}` : rule.value)),
            smtpUsername: req.auth.isAdmin ? config.smtpUsername || null : null,
        });
    });
    app.use('/api/emails', createEmailRoutes({ emailModel, ingest, events, auth, config }));
    app.use('/api/keys', createApiKeyRoutes({ apiKeyModel, auth, config }));
    app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

    // The dashboard needs a session; the login page and static assets are public
    const dashboard = (req, res) => {
        if (!auth.currentUser(req)) return res.redirect('/login.html');
        res.sendFile(path.join(viewsDir, 'index.html'));
    };
    app.get('/', dashboard);
    app.get('/index.html', dashboard);
    app.get('/login.html', (req, res) => {
        if (auth.currentUser(req)) return res.redirect('/');
        res.sendFile(path.join(viewsDir, 'login.html'));
    });
    app.use(express.static(viewsDir, { index: false }));

    // Malformed JSON and oversized bodies come through here as 4xx errors from express.json
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const status = err.status || err.statusCode || 500;
        if (status >= 500) {
            logToFile(`Unhandled error on ${req.method} ${req.path}: ${err.stack || err}`);
            return res.status(500).json({ error: 'Internal server error' });
        }
        res.status(status).json({ error: err.type === 'entity.too.large' ? 'Request body too large' : 'Bad request' });
    });

    return app;
}

module.exports = { createApp };
