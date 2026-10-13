# Email Test Service

A mock mail server for testing. Point your application's SMTP settings at this service instead of a real mail provider: emails are **not** delivered to anyone. They are parsed, stored in a database, and shown in a web interface so you can inspect what would have been sent.

Built with Node.js and Express, using [`smtp-server`](https://github.com/nodemailer/smtp-server) to receive mail and [`mailparser`](https://github.com/nodemailer/mailparser) to parse it. Emails can be stored in SQLite (default), PostgreSQL, or MySQL. It is the email sibling of the SMS Test Service and shares its dashboard, authentication and API-key model.

## Features

- **SMTP server** that accepts every message from anyone to anyone. Optional login (`SMTP_USERNAME` / `SMTP_PASSWORD`), optional TLS (STARTTLS and a TLS-only port), an optional list of accepted domains, special recipients that [simulate delivery failures](#simulating-delivery-failures), and an optional, allowlisted [relay](#relaying-to-a-real-mail-server) to a real mail server.
- **Full MIME parsing**: text and HTML bodies, multipart messages, encoded headers and names, inline images, attachments, and the raw `.eml`. Bcc recipients are recorded from the SMTP envelope.
- **Web dashboard** with a resizable sidebar and a resizable detail pane:
  - **Emails**: list with search (subject, addresses, body), date filters, quick time ranges, pagination, bulk delete and keyboard navigation (↑/↓ or j/k).
  - Each email opens with tabs: **HTML** (sandboxed preview), **Text**, **Links**, **Checks**, **Headers**, **Attachments** (downloadable), **Thread** and **Raw**, plus one-click **Copy code** for verification codes and **Download .eml**.
  - The HTML preview has a **Mobile / Tablet / Desktop** width switch, a simulated **Dark** mode, and a **Load images** switch (remote images are blocked by default).
  - **Send test**: store a test email from the dashboard, with the equivalent `swaks` command.
  - **Setup & API**: SMTP settings and copyable examples generated for your server.
- **API for tests**: `GET /api/emails/latest?to=user@example.com` returns the newest email with the detected one-time `code` and every `link` in it, which is what E2E tests need for sign-up and password-reset flows. `GET /api/emails/wait` waits for the email to arrive, `DELETE /api/emails?to=…` empties an inbox between tests, and a [small client](#end-to-end-tests) wraps it all (`waitForCode`, `waitForLink`).
- **Webhook** on every received email (optionally signed), for CI jobs and other services.
- API keys managed in the dashboard (Read keys for tests), an admin token for scripts, a password-protected dashboard and optional read-only viewer accounts.
- Light and dark themes, input validation, rate limiting, security headers, optional automatic cleanup of old emails, and daily-rotated logs. Email content is never logged.

### Inspecting an email

- **Checks** lists deliverability and rendering problems found in the email, each a *Warning* (likely to cause trouble) or a *Note* (worth a look, maybe intentional):
  HTML without a plain-text alternative, missing `Message-ID` or `Date`, an empty or ALL-CAPS subject or one with repeated `!!`, images without `alt` text, images or links over `http://`, a tracking pixel, no viewport meta tag, HTML over Gmail's 102 KB clipping limit, no `List-Unsubscribe` header, and an envelope sender whose domain differs from the From domain. `localhost`, `*.local` and `*.test` URLs are not flagged for using `http://`. The findings are also in the API as `checks`.
- **Links → Check links** (admin) makes the server request every link in the email (HEAD, then GET if the server refuses HEAD; redirects are followed; at most 25 links, 5 seconds each) and shows the status next to each one. Only the status is kept. Because the server requests URLs taken from the email, set `LINK_CHECK=false` to turn this off.
- **Thread** appears when the email belongs to a conversation: emails are grouped by `Message-ID`, `In-Reply-To` and `References`, oldest first. Click one to open it.
- **Dark** is a simulation (it inverts the rendered page), not a real dark-mode client. **Load images** lets that email fetch its remote images, which tells the sender it was opened, and goes back to blocking when you reload the page.

### How the HTML preview stays safe

An HTML email is untrusted code. The preview is served from `/api/emails/:id/preview` into an `<iframe>`, with a `Content-Security-Policy` of `default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox allow-popups …`. Scripts, forms, frames and all network requests are blocked, so remote images (and tracking pixels) don't load. Inline `cid:` images are inlined as `data:` URIs. The page has an opaque origin, so it can't touch the dashboard or its cookies. Links open in a new tab.

## Project structure

```
email-test-service
├── src
│   ├── app.js                    # Entry point: config, database, HTTP server and SMTP server
│   ├── server.js                 # Builds the Express app (middleware, routes)
│   ├── config.js                 # Reads and validates environment variables
│   ├── mail
│   │   ├── smtpServer.js         # smtp-server: accepts mail, login, TLS, allowed domains, failure simulation
│   │   ├── relay.js              # Optional forwarding of allowlisted recipients to a real mail server
│   │   ├── ingest.js             # Raw message in, stored email out (SMTP and "Send test")
│   │   ├── events.js             # Wakes up requests waiting in /api/emails/wait
│   │   ├── webhook.js            # POSTs each received email to WEBHOOK_URL
│   │   ├── present.js            # Adds the code and links to an email for the API
│   │   ├── parse.js              # mailparser: MIME to the stored record
│   │   └── compose.js            # Builds the raw message for "Send test"
│   ├── controllers/emailController.js
│   ├── routes                    # /api/emails, /api/keys
│   ├── models                    # emailModel.js, apiKeyModel.js
│   ├── middleware                # auth.js (sessions, keys, ADMIN_TOKEN), validate.js
│   ├── database                  # SQLite (node:sqlite), PostgreSQL, MySQL
│   ├── utils                     # otp.js, links.js, recipients.js, apiKeys.js, session.js, logger.js, time.js
│   └── views                     # Dashboard (static files)
├── client                        # Zero-dependency helper for E2E tests (index.js + index.d.ts)
├── test                          # node:test suites (npm test)
├── .github/workflows             # docker.yml: tests, publishes the image. release.yml: GitHub Release
├── scripts/release.js            # Bumps the version, tags and pushes (starts the release workflows)
├── Dockerfile, docker-compose.yml, docker-compose.build.yml, docker-entrypoint.sh
├── sample.env
└── README.md
```

## Installation and usage

Requires [Node.js](https://nodejs.org/) 22.13 or later and npm. SQLite support is built into Node, so there is nothing to compile.

```
npm install
cp sample.env .env        # then replace every change-me value (the server refuses to start with them)
npm start                 # or: npm run dev
```

Generate random values with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Start it from the project root. Then:

1. Open `http://localhost:30004` and sign in with `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD`.
2. Point your application's SMTP settings at **`localhost:1025`**.
3. Send an email. It appears under **Emails**, newest first. **Send test** stores one without an application.

Run the tests with `npm test`.

## Pointing your application at it

By default use plain SMTP: **no TLS and no STARTTLS**. The server has no certificate, and clients that are offered TLS would reject a self-signed one, so STARTTLS is not advertised. To test an app that requires TLS, see [TLS](#tls).

```js
// Nodemailer
const transport = nodemailer.createTransport({ host: 'localhost', port: 1025, secure: false, ignoreTLS: true });
```

```
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
```

| | |
|---|---|
| **Login** | None needed: any credentials (or none) are accepted. Set `SMTP_USERNAME` and `SMTP_PASSWORD` to require them. |
| **Recipients** | Everything is accepted, including addresses that don't exist, unless you set `SMTP_ALLOWED_DOMAINS`. A few special names fail on purpose: see [Simulating delivery failures](#simulating-delivery-failures). |
| **Size** | Messages over `MAX_EMAIL_SIZE_MB` (10 by default) are rejected with `552`. |

Try it without an application:

```
swaks --server localhost:1025 --from noreply@example.com --to user@example.com \
  --header 'Subject: Hello' --body 'Your verification code is 123456'
```

## SMTP behavior

### Simulating delivery failures

Send to one of these recipients to see how your application handles a refusal. Only the part of the address before the `@` matters, and a suffix after `+`, `.`, `_` or `-` is ignored (`reject+signup@example.com` works too). Ordinary addresses such as `rejected@`, `fullname@` or `slowpoke@` are never affected.

| Recipient | What the server does |
|-----------|----------------------|
| `reject@…` | Refuses it with `550` mailbox unavailable (a permanent failure) |
| `tempfail@…` | Refuses it with `451` temporary failure (the client should retry) |
| `full@…` | Refuses it with `452` mailbox full |
| `slow@…`, `slow10@…` | Accepts it after 5 seconds, or after the number of seconds in the name (at most 30) |
| `datafail@…` | Accepts the recipient, then refuses the message with `554` after the body is sent; nothing is stored |

Other recipients on the same message are still accepted, as with a real server (the refused one is reported per recipient). Set `SMTP_SIMULATE=false` to turn this off.

### Accepting only some domains

`SMTP_ALLOWED_DOMAINS=example.com,*.staging.test` makes the server refuse every other recipient with `550 Relay access denied`, which catches a mistyped address or a wrong environment in an app's config. `example.com` matches that domain only; `*.staging.test` matches its subdomains (not `staging.test` itself). Empty (the default) accepts everything.

### TLS

Set `SMTP_TLS_KEY` and `SMTP_TLS_CERT` (paths to PEM files) and the server offers **STARTTLS** on `SMTP_PORT`; plain connections still work. Set `SMTP_TLS_PORT` as well (for example `1465`) to add a second listener that is encrypted from the first byte (implicit TLS, like port 465). Use it for apps that require TLS:

```
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=localhost" -keyout key.pem -out cert.pem
```

```js
// STARTTLS on SMTP_PORT, or secure: true with SMTP_TLS_PORT. A self-signed certificate needs rejectUnauthorized: false.
nodemailer.createTransport({ host: 'localhost', port: 1025, secure: false, requireTLS: true, tls: { rejectUnauthorized: false } });
```

In Docker, mount the files and point the variables at them (for example `-v ./certs:/certs:ro` with `SMTP_TLS_KEY=/certs/key.pem`), and publish the TLS port.

### Relaying to a real mail server

Off by default. Set `RELAY_HOST` (plus `RELAY_PORT`, default `587`, `RELAY_SECURE=true` for a TLS-only port, and `RELAY_USER` / `RELAY_PASSWORD`) and the service **also forwards** each message to a real mail server, but only to the recipients on `RELAY_ALLOW`, for example to check how a template looks in a real inbox:

```
RELAY_HOST=smtp.example.net
RELAY_USER=me
RELAY_PASSWORD=...
RELAY_ALLOW=me@example.com,@mycompany.com
RELAY_FROM=testing@mycompany.com
```

- `RELAY_ALLOW` is required whenever `RELAY_HOST` is set, so the service can never become an open relay. Entries are addresses, domains (`mycompany.com`) or subdomain wildcards (`*.mycompany.com`). Recipients not on the list are stored but never forwarded.
- `RELAY_FROM` replaces the envelope sender, which many providers require to be an address you own. The message itself is forwarded unchanged.
- The email is always stored; relaying is best effort. A relay that is down or refuses the message is logged and doesn't affect receiving mail. Messages added with **Send test** are relayed the same way.

## Authentication

| Who | How | Can do |
|-----|-----|--------|
| Applications sending mail | SMTP, with `SMTP_USERNAME` / `SMTP_PASSWORD` if configured | Deliver mail only |
| E2E tests reading emails | `Authorization: Bearer <key>` (or `X-API-Key`) with a **Read** key | `GET /api/emails`, `/latest`, `/:id`, `/:id/raw`, attachments |
| Scripts needing full access | `Authorization: Bearer <ADMIN_TOKEN>` from `.env` | Everything |
| Dashboard admin | Sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD` (HttpOnly session cookie) | Everything |
| Dashboard viewers | Sign in with an account from `VIEWER_USERS` | View and search emails only |

**Viewer accounts** are listed in `.env` as `VIEWER_USERS=alice:a-long-password,bob:another-long-password`. They can browse, search and read emails but can't send tests, delete, or see API keys; the server refuses those requests with `403`. Usernames may use letters, digits, `.`, `_`, `@` and `-`; passwords need 8+ characters and may contain `:` but not `,`.

**API keys** are created on the dashboard's **API keys** page (no restart needed), look like `mail_read_…`, can be shown and copied again at any time, and can be revoked (anything using them then gets `401`). The database stores a SHA-256 hash, used to check requests, and an AES-256-GCM encrypted copy, used only to show the key again; the encryption key is derived from `SESSION_SECRET`. If `SESSION_SECRET` changes, keys keep working but can no longer be shown.

To turn off authentication for local development, set `AUTH_DISABLED=true`. Don't do this on a server other people can reach. This only affects the dashboard and API; the SMTP server is governed by `SMTP_USERNAME` / `SMTP_PASSWORD`.

## API

Errors are JSON: `{ "error": "..." }`, with a `details` object keyed by field for validation errors. Reading needs a Read key, a viewer or admin session, or `ADMIN_TOKEN`; deleting and `POST /api/emails/test` need an admin.

### `GET /api/emails`

Summaries (no bodies), newest first.

| Query parameter | Default | Description |
|-----------------|---------|-------------|
| `search` | — | Matches subject, sender, recipients or text body (case-insensitive) |
| `to` | — | Exact recipient address, case-insensitive, in To, Cc or the SMTP envelope (so Bcc too). `alice@example.com` does not match `malice@example.com`; use `search` for partial matches |
| `from` | — | Sender address or name contains this value |
| `subject` | — | Subject contains this value |
| `startDate` / `endDate` | — | `YYYY-MM-DD` in UTC, `endDate` inclusive |
| `after` / `before` | — | ISO date-times; used instead of the dates when given (`before` is exclusive) |
| `page`, `pageSize` | `1`, `10` | Pagination, `pageSize` 1–100 |

```json
{
  "emails": [
    {
      "id": 7, "messageId": "<…>", "subject": "Verify your email address", "snippet": "Your verification code is 482913…",
      "from": { "name": "Shop", "address": "shop@example.com" },
      "to": [{ "name": "", "address": "user@example.com" }], "cc": [],
      "envelope": { "from": "shop@example.com", "to": ["user@example.com"] },
      "size": 2048, "attachmentCount": 1, "smtpUser": null, "timestamp": "2026-01-01T10:00:00.000Z"
    }
  ],
  "totalPages": 1, "totalEmails": 1, "currentPage": 1
}
```

### `GET /api/emails/latest`

The newest email matching the same filters (usually `to`), with its full content, or `404`. In addition to the summary fields:

| Field | Description |
|-------|-------------|
| `text`, `html` | The text and HTML bodies (`null` when absent). `cid:` references are left as received. |
| `headers` | `[{ "key": "subject", "value": "…" }]` in message order |
| `attachments` | `[{ "id", "filename", "contentType", "size", "contentId", "url" }]`; `url` downloads the file |
| `code` | The one-time code detected in the text (4–8 digits, `123-456`, `G-123456`, `AB12CD`, with keywords in several languages), or `null`. Amounts, order numbers, dates and phone numbers are ignored. |
| `links` | Every http(s) link, from `href` attributes and the text, without duplicates |
| `checks` | `[{ "level", "code", "message" }]`, where `level` is `warning` or `info`: see [Inspecting an email](#inspecting-an-email) |
| `hasTextPart` | `true` if the message has a real `text/plain` part, `false` if it is HTML only (`text` is then derived from the HTML), `null` for emails stored before this was recorded |

```js
// Playwright / Cypress / Jest
const res = await fetch(`${MAIL_URL}/api/emails/latest?to=${encodeURIComponent(email)}`, {
  headers: { Authorization: `Bearer ${process.env.MAIL_API_KEY}` },
});
const { code, links } = await res.json();
```

Your application usually sends the mail a moment after the action, so use `/api/emails/wait` below instead of polling this.

### `GET /api/emails/wait`

A long poll that takes the same filters as `GET /api/emails` and answers as soon as a matching email exists, with the same body as `/latest`. An email that is already stored is returned immediately; otherwise the request waits up to `timeout` seconds (default `30`, at most `120`) and answers `408` if nothing arrives. Use a unique recipient per test, or `after`, so a test doesn't pick up an older email.

```
curl -H "Authorization: Bearer $API_KEY" "http://localhost:30004/api/emails/wait?to=user@example.com&timeout=15"
```

## End-to-end tests

The `client/` folder holds a dependency-free helper (Node 18+; copy `client/index.js`, plus `index.d.ts` for TypeScript, into your test project). It reads `MAIL_URL` and `MAIL_API_KEY` by default:

```js
const { createClient } = require('./client');
const mail = createClient({ baseUrl: 'http://localhost:30004', apiKey: process.env.MAIL_API_KEY });

test('sign-up sends a verification code', async ({ page }) => {
  const to = `user-${Date.now()}@example.com`;       // a unique recipient keeps tests apart
  await signUp(page, to);                            // your app sends the email
  const code = await mail.waitForCode({ to });       // waits up to 30 s, throws EmailTimeoutError otherwise
  await page.fill('#code', code);
});

const link = await mail.waitForLink({ to, match: /verify/ });   // first link containing "verify"
const email = await mail.waitForEmail({ to, subject: 'Welcome' });   // the whole email
await mail.clearInbox(to);                           // admin token only: deletes everything sent to that address
```

| Method | Description |
|--------|-------------|
| `waitForEmail({ to, from, subject, search, after, timeout })` | The email, waiting for it if needed. Throws `EmailTimeoutError` |
| `waitForCode(options)` | The detected one-time code of the next matching email |
| `waitForLink({ ...options, match })` | The first link, or the first matching a string, `RegExp` or function |
| `latestEmail(filters)` / `listEmails(options)` / `getEmail(id)` | Read without waiting (`latestEmail` returns `null` when there is none) |
| `clearInbox(to)` / `deleteEmail(id)` | Delete (admin token) |

Give the helper a **Read** key for the `wait*` and read methods, and the `ADMIN_TOKEN` when the tests also clear inboxes.

## Webhook

Set `WEBHOOK_URL` and the service POSTs JSON to it for every email it stores:

```json
{ "event": "email.received", "email": { "id": 7, "subject": "Verify your email address", "from": { "name": "", "address": "shop@example.com" },
  "to": [{ "name": "", "address": "user@example.com" }], "envelope": { "from": "shop@example.com", "to": ["user@example.com"] },
  "code": "482913", "links": ["https://app.example.com/verify?token=abc"], "attachments": [], "snippet": "…", "timestamp": "2026-01-01T10:00:00.000Z" } }
```

The bodies and headers are not included; fetch `GET /api/emails/:id` for them. With `WEBHOOK_SECRET` set, the request carries `X-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`, so the receiver can check it came from this service. Delivery is best effort: 5 second timeout, no retries, and a failure is logged without affecting mail reception.

### Other endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/emails/:id` | One email with its full content (as above) |
| `GET` | `/api/emails/:id/raw` | The original message as `text/plain`; add `?download=true` for an `.eml` file |
| `GET` | `/api/emails/:id/attachments/:attachmentId` | Download an attachment |
| `GET` | `/api/emails/:id/preview` | The HTML (or text) body as a locked-down page, for embedding; add `?images=true` to allow remote images |
| `GET` | `/api/emails/:id/thread` | `{ "emails": [...] }`: summaries of the emails in the same conversation, oldest first (empty if it has no `Message-ID` / `In-Reply-To` / `References` to go by) |
| `POST` | `/api/emails/:id/check-links` | Admin. Requests each link in the email and returns `{ "results": [{ "url", "ok", "status", "finalUrl", "ms", "error" }], "skipped": 0 }`. `403` when `LINK_CHECK=false` |
| `POST` | `/api/emails/test` | Admin. Store a test email: `{ "from", "fromName"?, "to": "a@x.com, b@x.com", "subject"?, "text"?, "html"? }` (text or html required) |
| `DELETE` | `/api/emails/:id` | Admin. Delete an email and its attachments (`404` if it doesn't exist) |
| `DELETE` | `/api/emails` | Admin. Delete several (up to 500): `{ "ids": [1, 2, 3] }`. Or empty one inbox: `?to=user@example.com` (other filters narrow it further). One of the two is required, so a bare `DELETE` deletes nothing |
| `GET` / `POST` / `DELETE` | `/api/keys` … | Admin. List, create (`{ "name": "ci-tests" }`), reveal (`POST /:id/reveal`) and revoke keys |
| `GET` | `/api/info` | SMTP port and whether SMTP login is required (used by the dashboard) |
| `GET` | `/health` | Public. `{ "status": "ok" }` when the database is reachable, `503` otherwise |

## Running with Docker

The image is published to GitHub Container Registry as `ghcr.io/<owner>/email-test-service` for `linux/amd64` and `linux/arm64`, and runs as the unprivileged `node` user (UID 1000). It exposes the dashboard on `30004` and SMTP on `1025`.

```
cp sample.env .env       # fill in at least ADMIN_PASSWORD and SESSION_SECRET
docker compose up -d
docker compose pull && docker compose up -d     # update later
```

Dashboard at `http://localhost:30004`, SMTP at `localhost:1025`. Emails and logs are kept in the `email-data` and `email-logs` volumes (`docker compose down -v` deletes them). Keep `SQLITE_PATH` and `LOG_DIR` unset in `.env` when using Docker. For bind mounts instead of volumes, the folders must be writable by UID 1000 (`sudo mkdir -p ./data ./logs && sudo chown -R 1000:1000 ./data ./logs`); the container explains this at startup if not.

Without Compose:

```
docker run -d --name email-test-service --init --restart unless-stopped \
  --env-file .env -p 30004:30004 -p 1025:1025 \
  -v email-data:/app/data -v email-logs:/app/logs \
  ghcr.io/<owner>/email-test-service:latest
```

Other containers on the same Docker network reach it as `email-test-service:1025`. Behind a reverse proxy, set `TRUST_PROXY=1`. Only the dashboard goes through an HTTP proxy; SMTP needs the port published (or a TCP/stream proxy).

To run a released version instead of `latest`, set `IMAGE_TAG` (for example `IMAGE_TAG=1.2.0 docker compose up -d`). To build from this source tree rather than pull the image:

```
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Releasing

```
npm run release -- patch          # or minor, major, or an exact version like 1.4.0
npm run release -- minor --dry-run   # shows the new version and the commits since the last tag, changes nothing
```

`scripts/release.js` checks that you're on an up-to-date `main` with a clean tree, runs the tests, bumps `package.json`, commits, tags `vX.Y.Z` and pushes. Pushing the tag starts two workflows:

| Workflow | What it does |
|----------|--------------|
| `docker.yml` | Runs the tests on Node 22 and 24, then publishes the image as `X.Y.Z`, `X.Y`, `X` and `sha-<commit>` (pushes to `main` publish `latest`) |
| `release.yml` | Checks the tag matches `package.json`, then creates the GitHub Release with generated notes, a `docker-compose.yml` pinned to that version, and `sample.env`. Tags with a suffix such as `v1.2.0-rc.1` are marked as pre-releases |

Pull requests run the tests and build the image without publishing it.

## Database setup

SQLite needs nothing. For PostgreSQL (the bundled container, or any server) or MySQL, set `DB_TYPE` and the `PG_*` / `MYSQL_*` variables as described in `sample.env`; the tables are created on startup, but the database itself must already exist on an external server. Attachments and the raw message are stored in the database as binary columns, so for MySQL keep `max_allowed_packet` at least as large as `MAX_EMAIL_SIZE_MB`.

## Environment configuration

See `sample.env` for a commented template.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `30004` | Dashboard and API port |
| `SMTP_PORT` | `1025` | SMTP port |
| `SMTP_HOST` | `0.0.0.0` | Interface the SMTP server listens on |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | — | Optional. Set both to require SMTP login |
| `MAX_EMAIL_SIZE_MB` | `10` | Largest accepted message |
| `SMTP_SIMULATE` | `true` | `false` turns off the special failure recipients (`reject@` and so on) |
| `SMTP_ALLOWED_DOMAINS` | — | Comma separated domains (`example.com`, `*.example.com`) the server accepts mail for; empty accepts everything |
| `SMTP_TLS_KEY`, `SMTP_TLS_CERT` | — | PEM files; set both to offer STARTTLS |
| `SMTP_TLS_PORT` | — | Optional second SMTP port that is TLS from the first byte (needs the key and certificate) |
| `RELAY_HOST`, `RELAY_PORT` | —, `587` | Real mail server to forward allowlisted recipients to |
| `RELAY_SECURE` | `false` | `true` for a TLS-only relay port (465) |
| `RELAY_USER`, `RELAY_PASSWORD` | — | Relay login (set both or neither) |
| `RELAY_FROM` | — | Envelope sender used when relaying |
| `RELAY_ALLOW` | — | Required with `RELAY_HOST`: addresses, domains or `*.domains` that may be forwarded |
| `LINK_CHECK` | `true` | `false` turns off the dashboard's link checker (the server requesting the email's links) |
| `WEBHOOK_URL` | — | Optional. POSTed to for every stored email (see [Webhook](#webhook)) |
| `WEBHOOK_SECRET` | — | Optional. Signs webhook requests (`X-Signature-256`) |
| `ADMIN_USERNAME` | `admin` | Dashboard username |
| `ADMIN_PASSWORD` | — | Required. Dashboard password |
| `VIEWER_USERS` | — | Optional read-only dashboard accounts |
| `SESSION_SECRET` | — | Required. 32+ characters; signs session cookies and encrypts stored API keys |
| `ADMIN_TOKEN` | — | Optional bearer token for scripts (16+ characters) |
| `SESSION_TTL_HOURS` | `12` | How long a dashboard sign-in lasts |
| `AUTH_DISABLED` | `false` | `true` turns off dashboard and API authentication (local development only) |
| `TRUST_PROXY` | — | Number of reverse-proxy hops in front of the service |
| `API_RATE_LIMIT` | `120` | Max `POST /api/emails/test` requests per minute per client IP |
| `RETENTION_DAYS` | `0` | Delete emails older than this many days, checked hourly (`0` keeps everything) |
| `LOG_DIR`, `LOG_TO_FILE` | `./logs`, `true` | Log directory; `false` logs to stdout only |
| `DB_TYPE` | `sqlite` | `sqlite`, `postgres`, or `mysql` |
| `SQLITE_PATH` | `./email-db.sqlite` | SQLite file (the Docker image uses `/app/data/email-db.sqlite`) |
| `PG_*`, `MYSQL_*` | — | Connection settings, including `PG_SSL` / `MYSQL_SSL` and `*_SSL_CA` |

## Security notes

This is a test tool. Don't expose the SMTP port to the internet: it accepts mail for any recipient (and, without `SMTP_USERNAME`, from anyone), stores it, and each message can be up to `MAX_EMAIL_SIZE_MB`. Keep it on a development network or behind a VPN, and consider `RETENTION_DAYS`.

## License

MIT
