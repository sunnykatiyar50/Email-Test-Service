// Request validation. Each validator either stores the cleaned values on req or responds with 400.

const MAX_PAGE_SIZE = 100;
const MAX_BULK_DELETE = 500;
const MAX_RECIPIENTS = 20;
const MAX_SUBJECT = 255;
const MAX_BODY = 200000;
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(res, errors) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
}

// Parses a date-only value as the start of that day in UTC
function parseDay(value) {
    if (!DATE_RE.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

// Filters: search (anywhere in the email), to, from, subject, and a time window given either as
// after/before (ISO date-times, e.g. local midnight from the browser) or startDate/endDate
// (YYYY-MM-DD in UTC, endDate inclusive)
function validateListQuery(req, res, next) {
    const q = req.query;
    const errors = {};
    const str = name => (typeof q[name] === 'string' ? q[name].trim() : '');

    const page = str('page') ? parseInt(str('page'), 10) : 1;
    if (!Number.isInteger(page) || page < 1) errors.page = 'must be a positive integer';

    const pageSize = str('pageSize') ? parseInt(str('pageSize'), 10) : 10;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
        errors.pageSize = `must be between 1 and ${MAX_PAGE_SIZE}`;
    }

    let after = null;
    let before = null;
    if (str('after')) {
        after = parseDateTime(str('after'));
        if (!after) errors.after = 'must be an ISO date-time';
    } else if (str('startDate')) {
        after = parseDay(str('startDate'));
        if (!after) errors.startDate = 'must be YYYY-MM-DD';
    }
    if (str('before')) {
        before = parseDateTime(str('before'));
        if (!before) errors.before = 'must be an ISO date-time';
    } else if (str('endDate')) {
        before = parseDay(str('endDate'));
        if (!before) errors.endDate = 'must be YYYY-MM-DD';
        else before = new Date(before.getTime() + 24 * 60 * 60 * 1000); // inclusive end day
    }

    if (Object.keys(errors).length) return badRequest(res, errors);
    req.listQuery = {
        page,
        pageSize,
        filters: {
            search: str('search').slice(0, 200),
            to: str('to').slice(0, 320),
            from: str('from').slice(0, 320),
            subject: str('subject').slice(0, 200),
            after,
            before,
        },
    };
    next();
}

function parseId(value) {
    const s = String(value);
    if (!/^[1-9][0-9]{0,15}$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
}

function validateIdParam(req, res, next) {
    const id = parseId(req.params.id);
    if (id === null) return badRequest(res, { id: 'must be a positive integer' });
    req.validated = { ids: [id], id };
    next();
}

function validateAttachmentParams(req, res, next) {
    const id = parseId(req.params.id);
    const attachmentId = parseId(req.params.attachmentId);
    if (id === null || attachmentId === null) return badRequest(res, { id: 'must be positive integers' });
    req.validated = { id, attachmentId };
    next();
}

function validateIdList(req, res, next) {
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_DELETE) {
        return badRequest(res, { ids: `must be an array of 1-${MAX_BULK_DELETE} ids` });
    }
    const parsed = ids.map(parseId);
    if (parsed.includes(null)) return badRequest(res, { ids: 'must contain only positive integers' });
    req.validated = { ids: [...new Set(parsed)] };
    next();
}

// The dashboard's "Send test" form: from, to (comma separated), subject, text and/or html
function validateTestEmail(req, res, next) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const errors = {};
    const text = typeof body.text === 'string' ? body.text : '';
    const html = typeof body.html === 'string' ? body.html : '';
    const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
    const from = typeof body.from === 'string' ? body.from.trim() : '';
    const fromName = typeof body.fromName === 'string' ? body.fromName.trim() : '';

    if (!EMAIL_RE.test(from)) errors.from = 'must be an email address';
    // Control characters would let a value inject extra headers
    if (fromName.length > 64 || /[\r\n"<>]/.test(fromName)) errors.fromName = 'must be at most 64 characters, without quotes, < > or line breaks';

    const to = (typeof body.to === 'string' ? body.to : '')
        .split(/[,;\s]+/)
        .map(s => s.trim())
        .filter(Boolean);
    if (to.length === 0 || to.length > MAX_RECIPIENTS || !to.every(a => EMAIL_RE.test(a))) {
        errors.to = `must be 1-${MAX_RECIPIENTS} email addresses separated by commas`;
    }

    if (subject.length > MAX_SUBJECT || /[\r\n]/.test(subject)) errors.subject = `must be one line of at most ${MAX_SUBJECT} characters`;
    if (!text.trim() && !html.trim()) errors.text = 'or html is required';
    if (text.length > MAX_BODY) errors.text = `must be at most ${MAX_BODY} characters`;
    if (html.length > MAX_BODY) errors.html = `must be at most ${MAX_BODY} characters`;

    if (Object.keys(errors).length) return badRequest(res, errors);
    req.validated = { from, fromName, to: [...new Set(to)], subject, text, html };
    next();
}

module.exports = {
    validateListQuery,
    validateIdParam,
    validateIdList,
    validateAttachmentParams,
    validateTestEmail,
};
