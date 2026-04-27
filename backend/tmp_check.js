const https = require('https');
const crypto = require('crypto');
require('dotenv').config({ path: '/var/www/shopee-dashboard/backend/.env' });

const partnerId  = parseInt(process.env.SHOPEE_PARTNER_ID);
const partnerKey = process.env.SHOPEE_PARTNER_KEY;

function buildUrl(path, params, accessToken, shopId) {
  const ts = Math.floor(Date.now() / 1000);
  const baseStr = [partnerId, path, ts, accessToken, shopId].join('');
  const sign = crypto.createHmac('sha256', partnerKey).update(baseStr).digest('hex');
  const q = new URLSearchParams({ ...params, partner_id: partnerId, timestamp: ts, access_token: accessToken, shop_id: shopId, sign });
  return 'https://partner.shopeemobile.com' + path + '?' + q.toString();
}

async function getEscrow(shopId, orderSn, accessToken) {
  const url = buildUrl('/api/v2/payment/get_escrow_detail', { order_sn: orderSn }, accessToken, shopId);
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

const mysql = require('mysql2/promise');

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME
  });

  const [[shop]] = await db.query(SELECT access_token FROM shops WHERE shop_id=1607024749 AND token_status=active);
  const resp = await getEscrow(1607024749, '260404V63ND5M0', shop.access_token);
  const bp = resp?.response?.buyer_payment_info;
  const oi = resp?.response?.order_income;
  console.log('buyer_payment_info:', JSON.stringify(bp, null, 2));
  console.log('order_income.original_price:', oi?.original_price);
  console.log('order_income items:');
  (oi?.items || []).forEach(i => console.log(' ', i.item_id, 'qty:', i.quantity_purchased, 'disc_price:', i.discounted_price, 'orig:', i.original_price));
  await db.end();
}
main().catch(console.error);
