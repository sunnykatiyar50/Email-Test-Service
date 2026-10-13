const { toIso } = require('../utils/time');

const SUMMARY_COLUMNS =
    'id, message_id, from_address, from_name, to_addresses, cc_addresses, envelope_from, envelope_to, ' +
    'subject, snippet, size, attachment_count, smtp_user, timestamp';
const FULL_COLUMNS = `${SUMMARY_COLUMNS}, text_body, html_body, headers`;

function parseJson(value, fallback) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

// Databases return binary columns as Buffer (PostgreSQL, MySQL) or Uint8Array (SQLite)
const toBuffer = value => (value ? Buffer.from(value) : Buffer.alloc(0));

function toSummary(row) {
    return {
        id: Number(row.id),
        messageId: row.message_id || null,
        from: { name: row.from_name || '', address: row.from_address || '' },
        to: parseJson(row.to_addresses, []),
        cc: parseJson(row.cc_addresses, []),
        envelope: { from: row.envelope_from || '', to: parseJson(row.envelope_to, []) },
        subject: row.subject || '',
        snippet: row.snippet || '',
        size: Number(row.size),
        attachmentCount: Number(row.attachment_count),
        smtpUser: row.smtp_user || null,
        timestamp: toIso(row.timestamp),
    };
}

function toAttachment(row) {
    return {
        id: Number(row.id),
        filename: row.filename,
        contentType: row.content_type,
        contentId: row.content_id || null,
        size: Number(row.size),
    };
}

// "%" and "_" in a search term are matched literally ("!" is the escape character in every query below)
const likeTerm = value => `%${value.toLowerCase().replace(/[!%_]/g, '!$&')}%`;

class EmailModel {
    // db is the adapter returned by database/initDatabase.js
    constructor(db) {
        this.db = db;
    }

    buildFilters({ search, to, from, subject, after, before } = {}) {
        const clauses = [];
        const params = [];
        const matchAny = (columns, term) => {
            clauses.push(`(${columns.map(c => `LOWER(${c}) LIKE ? ESCAPE '!'`).join(' OR ')})`);
            columns.forEach(() => params.push(likeTerm(term)));
        };
        if (search) matchAny(['subject', 'from_address', 'from_name', 'to_addresses', 'envelope_to', 'text_body'], search);
        if (to) {
            // An exact address (case-insensitive) in To, Cc or the SMTP envelope (so Bcc too), not a substring:
            // "alice@example.com" must not match "malice@example.com". The columns hold JSON, so the
            // address is matched as a whole JSON string.
            const address = JSON.stringify(to.toLowerCase());
            const escaped = text => `%${text.replace(/[!%_]/g, '!$&')}%`;
            clauses.push(
                "(LOWER(to_addresses) LIKE ? ESCAPE '!' OR LOWER(cc_addresses) LIKE ? ESCAPE '!' OR LOWER(envelope_to) LIKE ? ESCAPE '!')"
            );
            params.push(escaped(`"address":${address}`), escaped(`"address":${address}`), escaped(address));
        }
        if (from) matchAny(['from_address', 'from_name'], from);
        if (subject) matchAny(['subject'], subject);
        if (after) {
            clauses.push('timestamp >= ?');
            params.push(after);
        }
        if (before) {
            clauses.push('timestamp < ?');
            params.push(before);
        }
        return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
    }

    // One page of emails (newest first, without bodies) plus the total number of matches
    async list({ limit, offset, ...filters }) {
        if (!Number.isInteger(limit) || !Number.isInteger(offset)) {
            throw new TypeError('limit and offset must be integers');
        }
        const { where, params } = this.buildFilters(filters);
        const [countRow] = await this.db.all(`SELECT COUNT(*) AS total FROM emails ${where}`, params);
        // limit/offset are validated integers, so they are safe to inline (MySQL rejects them as bound params)
        const rows = await this.db.all(
            `SELECT ${SUMMARY_COLUMNS} FROM emails ${where} ORDER BY timestamp DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
            params
        );
        return { total: Number(countRow.total), emails: rows.map(toSummary) };
    }

    // The newest matching email with its body, or null
    async latest(filters) {
        const { emails } = await this.list({ ...filters, limit: 1, offset: 0 });
        return emails.length ? this.get(emails[0].id) : null;
    }

    // One email with its text, HTML, headers and attachment list (not the attachment contents)
    async get(id) {
        const [row] = await this.db.all(`SELECT ${FULL_COLUMNS} FROM emails WHERE id = ?`, [id]);
        if (!row) return null;
        const attachments = await this.db.all(
            'SELECT id, filename, content_type, content_id, size FROM attachments WHERE email_id = ? ORDER BY id',
            [id]
        );
        return {
            ...toSummary(row),
            text: row.text_body ?? null,
            html: row.html_body ?? null,
            headers: parseJson(row.headers, []),
            attachments: attachments.map(toAttachment),
        };
    }

    async getRaw(id) {
        const [row] = await this.db.all('SELECT raw FROM emails WHERE id = ?', [id]);
        return row ? toBuffer(row.raw) : null;
    }

    async getAttachment(emailId, attachmentId) {
        const [row] = await this.db.all(
            'SELECT id, filename, content_type, content_id, size, content FROM attachments WHERE email_id = ? AND id = ?',
            [emailId, attachmentId]
        );
        return row ? { ...toAttachment(row), content: toBuffer(row.content) } : null;
    }

    // Attachments referenced from the HTML as cid:... (inline images), with their contents
    async getInlineAttachments(emailId) {
        const rows = await this.db.all(
            'SELECT id, filename, content_type, content_id, size, content FROM attachments WHERE email_id = ? AND content_id IS NOT NULL',
            [emailId]
        );
        return rows.map(row => ({ ...toAttachment(row), content: toBuffer(row.content) }));
    }

    // record: the object produced by mail/parse.js
    async create(record) {
        const timestamp = new Date();
        const id = Number(
            await this.db.insert(
                `INSERT INTO emails (message_id, from_address, from_name, to_addresses, cc_addresses, envelope_from, envelope_to,
                                     subject, snippet, text_body, html_body, headers, raw, size, attachment_count, smtp_user, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    record.messageId,
                    record.from.address,
                    record.from.name,
                    JSON.stringify(record.to),
                    JSON.stringify(record.cc),
                    record.envelopeFrom,
                    JSON.stringify(record.envelopeTo),
                    record.subject,
                    record.snippet,
                    record.text,
                    record.html,
                    JSON.stringify(record.headers),
                    record.raw,
                    record.size,
                    record.attachments.length,
                    record.smtpUser,
                    timestamp,
                ]
            )
        );
        for (const attachment of record.attachments) {
            await this.db.insert(
                'INSERT INTO attachments (email_id, filename, content_type, content_id, size, content) VALUES (?, ?, ?, ?, ?, ?)',
                [id, attachment.filename, attachment.contentType, attachment.contentId, attachment.size, attachment.content]
            );
        }
        return { id, timestamp: timestamp.toISOString() };
    }

    // Deletes the given ids (and their attachments); returns the number of emails removed
    async deleteMany(ids) {
        if (ids.length === 0) return 0;
        const placeholders = ids.map(() => '?').join(', ');
        await this.db.run(`DELETE FROM attachments WHERE email_id IN (${placeholders})`, ids);
        return this.db.run(`DELETE FROM emails WHERE id IN (${placeholders})`, ids);
    }

    // Deletes every email matching the filters (and their attachments); returns how many were removed
    async deleteMatching(filters) {
        const { where, params } = this.buildFilters(filters);
        const rows = await this.db.all(`SELECT id FROM emails ${where}`, params);
        const ids = rows.map(row => Number(row.id));
        let deleted = 0;
        for (let i = 0; i < ids.length; i += 500) deleted += await this.deleteMany(ids.slice(i, i + 500));
        return deleted;
    }

    async deleteOlderThan(date) {
        await this.db.run('DELETE FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE timestamp < ?)', [date]);
        return this.db.run('DELETE FROM emails WHERE timestamp < ?', [date]);
    }

    async ping() {
        await this.db.all('SELECT 1 AS ok');
    }
}

module.exports = EmailModel;
