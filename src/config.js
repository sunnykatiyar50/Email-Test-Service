// Reads and validates configuration from environment variables.
// Throws on invalid auth configuration so the server never starts unprotected by accident.

// VIEWER_USERS=alice:password1,bob:password2 -> [{ username, password }]
// (passwords can contain ':' but not ',')
function parseUsers(raw) {
    if (!raw) return [];
    return raw
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean)
        .map(entry => {
            const sep = entry.indexOf(':');
            return sep === -1
                ? { username: entry, password: '' }
                : { username: entry.slice(0, sep).trim(), password: entry.slice(sep + 1) };
        });
}

const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;

function toInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function loadConfig(env = process.env) {
    const config = {
        port: toInt(env.PORT, 30002),
        authDisabled: env.AUTH_DISABLED === 'true',
        // The SMTP server your apps send mail to. With SMTP_USERNAME/SMTP_PASSWORD set, clients must
        // authenticate; without them any (or no) credentials are accepted.
        smtpPort: toInt(env.SMTP_PORT, 1025),
        smtpHost: env.SMTP_HOST || '0.0.0.0',
        smtpUsername: env.SMTP_USERNAME || '',
        smtpPassword: env.SMTP_PASSWORD || '',
        maxEmailBytes: toInt(env.MAX_EMAIL_SIZE_MB, 10) * 1024 * 1024,
        adminToken: env.ADMIN_TOKEN || '',
        adminUsername: (env.ADMIN_USERNAME || 'admin').trim(),
        adminPassword: env.ADMIN_PASSWORD || '',
        // Read-only dashboard accounts: can view messages, can't send, delete or manage API keys
        viewerUsers: parseUsers(env.VIEWER_USERS),
        sessionSecret: env.SESSION_SECRET || '',
        sessionTtlHours: toInt(env.SESSION_TTL_HOURS, 12),
        trustProxy: env.TRUST_PROXY || '',
        apiRateLimit: toInt(env.API_RATE_LIMIT, 120),
        retentionDays: toInt(env.RETENTION_DAYS, 0),
    };

    if (!config.authDisabled) {
        const problems = [];
        if (!config.adminPassword) problems.push('ADMIN_PASSWORD is not set');
        if (config.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
        if (config.adminToken && config.adminToken.length < 16) problems.push('ADMIN_TOKEN must be at least 16 characters');
        if (Boolean(config.smtpUsername) !== Boolean(config.smtpPassword)) {
            problems.push('SMTP_USERNAME and SMTP_PASSWORD must be set together');
        }
        const seen = new Set([config.adminUsername.toLowerCase()]);
        for (const { username, password } of config.viewerUsers) {
            if (!USERNAME_RE.test(username)) {
                problems.push(`VIEWER_USERS: "${username}" is not a valid username (letters, digits, . _ @ -)`);
            } else if (seen.has(username.toLowerCase())) {
                problems.push(`VIEWER_USERS: "${username}" is used twice, or is the admin username`);
            }
            seen.add(username.toLowerCase());
            if (password.length < 8) problems.push(`VIEWER_USERS: the password for "${username}" must be at least 8 characters`);
        }
        const secrets = [config.adminPassword, config.sessionSecret, config.adminToken,
            config.smtpPassword, ...config.viewerUsers.map(u => u.password)];
        if (secrets.some(s => s.startsWith('change-me'))) problems.push('replace the change-me placeholder values from sample.env');
        if (problems.length) {
            throw new Error(
                `Invalid auth configuration: ${problems.join('; ')}. ` +
                'Set these in .env (see sample.env), or set AUTH_DISABLED=true for local development only.'
            );
        }
    }

    return config;
}

module.exports = { loadConfig, parseUsers };
