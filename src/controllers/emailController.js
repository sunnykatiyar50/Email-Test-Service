const { logToFile } = require('../utils/logger');
const { extractOtp } = require('../utils/otp');
const { extractLinks } = require('../utils/links');
const { buildRawMessage } = require('../mail/compose');

const escapeHtml = value =>
    String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The preview is shown in a sandboxed iframe with this policy: no scripts, no network, no frames of its own.
// Remote images are blocked (they would also tell the sender the mail was opened); inline images are data: URIs.
const PREVIEW_CSP =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
    "frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox";

class EmailController {
    constructor(emailModel, ingest) {
        this.emailModel = emailModel;
        this.ingest = ingest;
    }

    // The email as the API returns it. Attachments get a download URL; full emails also get the detected
    // one-time code and the links found in the body.
    present(email) {
        const presented = { ...email };
        if (email.attachments) {
            presented.attachments = email.attachments.map(a => ({
                ...a,
                url: `/api/emails/${email.id}/attachments/${a.id}`,
            }));
            presented.code = extractOtp(email.text || '');
            presented.links = extractLinks(email.text, email.html);
        }
        return presented;
    }

    async getEmails(req, res) {
        const { page, pageSize, filters } = req.listQuery;
        const { total, emails } = await this.emailModel.list({ ...filters, limit: pageSize, offset: (page - 1) * pageSize });
        res.status(200).json({
            emails,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            totalEmails: total,
            currentPage: page,
        });
    }

    async getLatestEmail(req, res) {
        const email = await this.emailModel.latest(req.listQuery.filters);
        if (!email) return res.status(404).json({ error: 'No matching email found.' });
        res.status(200).json(this.present(email));
    }

    async getEmail(req, res) {
        const email = await this.emailModel.get(req.validated.id);
        if (!email) return res.status(404).json({ error: 'Email not found.' });
        res.status(200).json(this.present(email));
    }

    async getRaw(req, res) {
        const raw = await this.emailModel.getRaw(req.validated.id);
        if (!raw) return res.status(404).json({ error: 'Email not found.' });
        res.type('text/plain; charset=utf-8');
        if (req.query.download === 'true') res.attachment(`email-${req.validated.id}.eml`).type('message/rfc822');
        res.send(raw);
    }

    async getAttachment(req, res) {
        const { id, attachmentId } = req.validated;
        const attachment = await this.emailModel.getAttachment(id, attachmentId);
        if (!attachment) return res.status(404).json({ error: 'Attachment not found.' });
        // Always a download, never rendered inside this origin
        res.attachment(attachment.filename);
        res.type(/^[\w.+-]+\/[\w.+-]+$/.test(attachment.contentType) ? attachment.contentType : 'application/octet-stream');
        res.send(attachment.content);
    }

    // The HTML (or plain text) body as a standalone page for the dashboard's sandboxed iframe
    async getPreview(req, res) {
        const email = await this.emailModel.get(req.validated.id);
        if (!email) return res.status(404).json({ error: 'Email not found.' });

        let body;
        if (email.html) {
            body = email.html;
            if (/cid:/i.test(body)) {
                const inline = await this.emailModel.getInlineAttachments(email.id);
                body = body.replace(/cid:([^"'\s)>]+)/gi, (match, cid) => {
                    let wanted = cid;
                    try {
                        wanted = decodeURIComponent(cid);
                    } catch {
                        // keep the raw value
                    }
                    const found = inline.find(a => a.contentId === wanted);
                    return found ? `data:${found.contentType};base64,${found.content.toString('base64')}` : match;
                });
            }
        } else {
            body = `<pre style="white-space:pre-wrap;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:0">${escapeHtml(email.text || '')}</pre>`;
        }
        // frame-ancestors in the policy replaces X-Frame-Options; the sandboxed frame has an opaque origin, so
        // helmet's same-origin resource policy would refuse to serve it
        res.removeHeader('X-Frame-Options');
        res.set({
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': PREVIEW_CSP,
            'Cross-Origin-Resource-Policy': 'same-site',
            'Cache-Control': 'no-store',
        });
        // Links open in a new tab; the page has no other way to navigate
        res.send(`<!DOCTYPE html><meta charset="utf-8"><base target="_blank">${body}`);
    }

    // Dashboard "Send test": builds a message and stores it exactly like mail received over SMTP
    async sendTest(req, res) {
        const { from, to } = req.validated;
        const raw = buildRawMessage(req.validated);
        const { id, timestamp } = await this.ingest(raw, {
            envelope: { mailFrom: { address: from }, rcptTo: to.map(address => ({ address })) },
            smtpUser: req.auth.username || 'dashboard',
        });
        logToFile(`Stored test email id=${id} recipients=${to.length}`);
        res.status(201).json({ success: true, id, timestamp, message: 'Email stored successfully' });
    }

    async deleteEmails(req, res) {
        const { ids } = req.validated;
        const deleted = await this.emailModel.deleteMany(ids);
        logToFile(`Deleted ${deleted} email(s): ${ids.join(', ')}`);
        if (req.params.id !== undefined && deleted === 0) {
            return res.status(404).json({ error: 'Email not found.' });
        }
        res.status(200).json({ message: 'Emails deleted successfully.', deleted });
    }
}

module.exports = EmailController;
