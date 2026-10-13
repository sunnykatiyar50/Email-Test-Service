const crypto = require('crypto');

const base64Lines = value => Buffer.from(value, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

// RFC 2047 encoded-word for headers that contain non-ASCII text
const encodeHeader = value => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`);

// Builds a small RFC 5322 message for the dashboard's "Send test" form: text, HTML, or both
// (multipart/alternative). Body parts are base64 so any text survives the round trip.
function buildRawMessage({ from, fromName, to, subject, text, html }) {
    const headers = [
        `From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`,
        `To: ${to.join(', ')}`,
        `Subject: ${encodeHeader(subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${crypto.randomUUID()}@email-test-service.local>`,
        'MIME-Version: 1.0',
    ];
    const part = (type, body) =>
        `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(body)}`;

    let body;
    if (text.trim() && html.trim()) {
        const boundary = `=_${crypto.randomBytes(12).toString('hex')}`;
        headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        body = [`--${boundary}`, part('text/plain', text), `--${boundary}`, part('text/html', html), `--${boundary}--`, ''].join('\r\n');
    } else {
        const isHtml = !text.trim();
        body = part(isHtml ? 'text/html' : 'text/plain', isHtml ? html : text);
        // part() already carries its own Content-Type headers; hoist them into the main header block
        const [partHeaders, content] = body.split('\r\n\r\n');
        headers.push(...partHeaders.split('\r\n'));
        body = content;
    }
    return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8');
}

module.exports = { buildRawMessage };
