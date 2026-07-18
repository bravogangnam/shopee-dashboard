const express = require('express');
const { classifyPushRequest } = require('../services/shopeePushRequest');
const {
  verifyPushAuthorization,
  getPushContext,
  registerPushEvent,
  enqueuePushEvent,
} = require('../services/shopeePushService');

const router = express.Router();

router.post('/', async (req, res) => {
  const rawBody = req.rawBody?.toString('utf8') || '';
  const payload = req.body || {};
  if (!rawBody) return res.status(400).end();

  const { type, shopId, code } = classifyPushRequest(payload);
  if (type === 'verification') return res.status(204).end();

  const context = await getPushContext(shopId);
  if (!context || !Number(context.is_active)) return res.status(204).end();
  const callbackUrl = process.env.SHOPEE_PUSH_CALLBACK_URL ||
    `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}${req.originalUrl}`;
  const authorization = req.get('authorization') || '';
  if (!verifyPushAuthorization({
    callbackUrl,
    rawBody,
    partnerKey: process.env.SHOPEE_PUSH_PARTNER_KEY || context.partner_key,
    authorization,
  })) return res.status(401).end();

  const event = await registerPushEvent({ context, payload, rawBody });
  res.status(204).end();
  if (event) enqueuePushEvent(context, event);
});

module.exports = router;
