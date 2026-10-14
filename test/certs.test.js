const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const selfsigned = require('selfsigned');
const { loadConfig } = require('../src/config');
const { createCertManager, readCertInfo, renewalReason } = require('../src/certs/certManager');
const { createCloudflare } = require('../src/certs/cloudflare');

const baseEnv = { AUTH_DISABLED: 'true' };

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'certs-test-'));
}

async function makeCert(names, days) {
    const pems = await selfsigned.generate([{ name: 'commonName', value: names[0] }], {
        notAfterDate: new Date(Date.now() + days * 86400000), keySize: 2048, algorithm: 'sha256',
        extensions: [{ name: 'subjectAltName', altNames: names.map(value => ({ type: 2, value })) }],
    });
    return { key: pems.private, cert: pems.cert };
}

function acmeConfig(dir, overrides = {}) {
    return loadConfig({
        ...baseEnv,
        ACME_DOMAINS: 'mail.example.com, *.example.com',
        ACME_EMAIL: 'ops@example.com',
        CLOUDFLARE_API_TOKEN: 'token',
        ACME_DIR: dir,
        ...overrides,
    });
}

describe('ACME configuration', () => {
    test('points the SMTP TLS files at ACME_DIR and normalizes the domain list', () => {
        const dir = tempDir();
        const config = acmeConfig(dir, { ACME_DOMAINS: 'Mail.Example.com,mail.example.com' });
        assert.deepEqual(config.acmeDomains, ['mail.example.com']);
        assert.equal(config.smtpTlsKey, path.join(dir, 'key.pem'));
        assert.equal(config.smtpTlsCert, path.join(dir, 'cert.pem'));
    });

    test('needs an email and a Cloudflare token', () => {
        assert.throws(() => acmeConfig(tempDir(), { ACME_EMAIL: '' }), /ACME_EMAIL/);
        assert.throws(() => acmeConfig(tempDir(), { CLOUDFLARE_API_TOKEN: '' }), /CLOUDFLARE_API_TOKEN/);
    });

    test('rejects invalid domains and a manual certificate alongside it', () => {
        assert.throws(() => acmeConfig(tempDir(), { ACME_DOMAINS: 'localhost' }), /not a valid domain/);
        assert.throws(() => acmeConfig(tempDir(), { SMTP_TLS_KEY: 'a.pem', SMTP_TLS_CERT: 'b.pem' }), /manages the certificate/);
    });

    test('is off by default', () => {
        const config = loadConfig(baseEnv);
        assert.deepEqual(config.acmeDomains, []);
        assert.equal(config.smtpTlsKey, '');
    });
});

describe('renewalReason', () => {
    test('decides by presence, domain list and days left', async () => {
        const valid = await makeCert(['mail.example.com'], 60);
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'cert.pem'), valid.cert);
        const info = readCertInfo(path.join(dir, 'cert.pem'));

        assert.match(renewalReason(null, ['mail.example.com'], 30), /no certificate/);
        assert.equal(renewalReason(info, ['mail.example.com'], 30), null);
        assert.match(renewalReason(info, ['mail.example.com', 'other.example.com'], 30), /domain list changed/);
        assert.match(renewalReason(info, ['mail.example.com'], 30, Date.now() + 40 * 86400000), /expires/);
    });
});

describe('certificate manager', () => {
    test('issues when missing, then leaves a valid certificate alone', async () => {
        const dir = tempDir();
        const config = acmeConfig(dir);
        const cert = await makeCert(config.acmeDomains, 90);
        let calls = 0;
        const manager = createCertManager(config, { issue: async () => { calls++; return cert; } });

        assert.equal((await manager.ensure()).renewed, true);
        assert.equal(fs.readFileSync(config.smtpTlsKey, 'utf8'), cert.key);
        assert.equal((await manager.ensure()).renewed, false);
        assert.equal(calls, 1);
    });

    test('renews inside the renewal window and reports the new certificate once', async () => {
        const dir = tempDir();
        const config = acmeConfig(dir);
        const old = await makeCert(config.acmeDomains, 10);
        const fresh = await makeCert(config.acmeDomains, 90);
        fs.writeFileSync(config.smtpTlsKey, old.key);
        fs.writeFileSync(config.smtpTlsCert, old.cert);
        const manager = createCertManager(config, { issue: async () => fresh });
        manager.markLoaded();

        let changes = 0;
        await manager.check(() => changes++);
        await manager.check(() => changes++);
        assert.equal(changes, 1);
        assert.equal(fs.readFileSync(config.smtpTlsCert, 'utf8'), fresh.cert);
    });

    test('notices a certificate renewed by another process', async () => {
        const dir = tempDir();
        const config = acmeConfig(dir);
        const first = await makeCert(config.acmeDomains, 90);
        const second = await makeCert(config.acmeDomains, 90);
        fs.writeFileSync(config.smtpTlsKey, first.key);
        fs.writeFileSync(config.smtpTlsCert, first.cert);
        const manager = createCertManager(config, { issue: async () => { throw new Error('must not be called'); } });
        manager.markLoaded();

        fs.writeFileSync(config.smtpTlsCert, second.cert);
        let changes = 0;
        await manager.check(() => changes++);
        assert.equal(changes, 1);
    });

    test('does not retry right after a failure, unless forced', async () => {
        const dir = tempDir();
        const config = acmeConfig(dir);
        let calls = 0;
        const manager = createCertManager(config, { issue: async () => { calls++; throw new Error('DNS says no'); } });

        await assert.rejects(manager.ensure(), /Certificate request failed: DNS says no/);
        await assert.rejects(manager.ensure(), /not retrying for/);
        assert.equal(calls, 1);
        await assert.rejects(manager.ensure({ force: true }), /DNS says no/);
        assert.equal(calls, 2);
    });
});

describe('Cloudflare DNS client', () => {
    test('finds the parent zone and adds and removes the TXT record', async () => {
        const requests = [];
        const fetchImpl = async (url, options) => {
            requests.push(`${options.method} ${url.replace('https://api.cloudflare.com/client/v4', '')}`);
            const result = url.includes('name=_acme') ? [] : url.includes('/zones?name=example.com') ? [{ id: 'zone1' }] : url.includes('dns_records') && options.method === 'POST' ? { id: 'rec1' } : [];
            return { ok: true, json: async () => ({ success: true, result }) };
        };
        const cloudflare = createCloudflare('token', fetchImpl);
        const record = await cloudflare.addTxt('_acme-challenge.mail.example.com', 'value');
        await cloudflare.removeRecord(record);
        assert.deepEqual(record, { zoneId: 'zone1', id: 'rec1' });
        assert.ok(requests.includes('POST /zones/zone1/dns_records'));
        assert.ok(requests.includes('DELETE /zones/zone1/dns_records/rec1'));
    });

    test('reports API errors', async () => {
        const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ message: 'Invalid token' }] }) });
        await assert.rejects(createCloudflare('bad', fetchImpl).addTxt('_acme-challenge.example.com', 'x'), /Invalid token/);
    });
});
