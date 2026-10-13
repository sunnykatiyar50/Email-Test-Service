const express = require('express');
const rateLimit = require('express-rate-limit');
const EmailController = require('../controllers/emailController');
const {
    validateListQuery,
    validateIdParam,
    validateBulkDelete,
    validateAttachmentParams,
    validateTestEmail,
} = require('../middleware/validate');

function createEmailRoutes({ emailModel, ingest, events, auth, config }) {
    const router = express.Router();
    const controller = new EmailController(emailModel, ingest, events);

    const testLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: config.apiRateLimit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many requests, slow down.' },
    });

    // Reading: a Read key, a viewer, or an admin
    router.get('/', auth.requireRead, validateListQuery, (req, res) => controller.getEmails(req, res));
    router.get('/latest', auth.requireRead, validateListQuery, (req, res) => controller.getLatestEmail(req, res));
    router.get('/wait', auth.requireRead, validateListQuery, (req, res) => controller.waitForEmail(req, res));
    router.get('/:id', auth.requireRead, validateIdParam, (req, res) => controller.getEmail(req, res));
    router.get('/:id/preview', auth.requireRead, validateIdParam, (req, res) => controller.getPreview(req, res));
    router.get('/:id/raw', auth.requireRead, validateIdParam, (req, res) => controller.getRaw(req, res));
    router.get('/:id/attachments/:attachmentId', auth.requireRead, validateAttachmentParams, (req, res) =>
        controller.getAttachment(req, res)
    );

    // Adding a test email and deleting: admin only
    router.post('/test', testLimiter, auth.requireAdmin, validateTestEmail, (req, res) => controller.sendTest(req, res));
    router.delete('/', auth.requireAdmin, validateBulkDelete, (req, res) => controller.deleteEmails(req, res));
    router.delete('/:id', auth.requireAdmin, validateIdParam, (req, res) => controller.deleteEmails(req, res));

    return router;
}

module.exports = createEmailRoutes;
