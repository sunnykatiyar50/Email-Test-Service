const { simpleParser } = require('mailparser');

const SNIPPET_LENGTH = 200;

// mailparser gives a single address object or an array of them (one per header); flatten to [{ name, address }]
function addressList(field) {
    if (!field) return [];
    return []
        .concat(field)
        .flatMap(entry => entry.value || [])
        .filter(entry => entry && entry.address)
        .map(entry => ({ name: entry.name || '', address: entry.address }));
}

// "Subject: a\r\n b" -> { key: 'Subject', value: 'a b' } (unfolds continuation lines)
function headerList(headerLines) {
    return (headerLines || []).map(({ key, line }) => ({
        key,
        value: line.slice(line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim(),
    }));
}

function snippetOf(text) {
    return (text || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH);
}

// Turns raw RFC 5322 bytes (plus the SMTP envelope) into the record stored by EmailModel.
// Parsing problems never lose the mail: the raw message is stored with a placeholder subject.
async function parseEmail(raw, { envelope = {}, smtpUser = null } = {}) {
    const envelopeFrom = (envelope.mailFrom && envelope.mailFrom.address) || '';
    const envelopeTo = (envelope.rcptTo || []).map(r => r.address).filter(Boolean);
    const base = { raw, size: raw.length, envelopeFrom, envelopeTo, smtpUser };

    let parsed;
    try {
        // keepCidLinks: leave cid: references in the HTML alone; the dashboard resolves them when previewing
        parsed = await simpleParser(raw, { keepCidLinks: true });
    } catch {
        return {
            ...base,
            messageId: null,
            from: { name: '', address: envelopeFrom },
            to: envelopeTo.map(address => ({ name: '', address })),
            cc: [],
            subject: '(could not parse message)',
            snippet: '',
            text: null,
            html: null,
            headers: [],
            attachments: [],
        };
    }

    const [from = { name: '', address: envelopeFrom }] = addressList(parsed.from);
    const text = typeof parsed.text === 'string' ? parsed.text : null;
    return {
        ...base,
        messageId: parsed.messageId || null,
        from,
        to: addressList(parsed.to),
        cc: addressList(parsed.cc),
        subject: parsed.subject || '',
        snippet: snippetOf(text),
        text,
        html: typeof parsed.html === 'string' ? parsed.html : null,
        headers: headerList(parsed.headerLines),
        attachments: (parsed.attachments || []).map((a, index) => ({
            filename: a.filename || `attachment-${index + 1}`,
            contentType: a.contentType || 'application/octet-stream',
            contentId: a.cid || null,
            size: a.size || (a.content ? a.content.length : 0),
            content: a.content,
        })),
    };
}

module.exports = { parseEmail, addressList };
