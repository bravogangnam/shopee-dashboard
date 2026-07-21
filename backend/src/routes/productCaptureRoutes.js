const express = require('express');
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const { isAllowedImageUrl, safeFilename } = require('../utils/productCaptureImage');

const router = express.Router();
const IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'],
  ['image/gif', 'gif'], ['image/avif', 'avif'], ['image/bmp', 'bmp'],
]);

router.get('/image-download', requireAuth, async (req, res) => {
  const sourceUrl = String(req.query.url || '');
  if (!isAllowedImageUrl(sourceUrl)) return res.status(400).json({ error: '허용되지 않은 이미지 URL입니다.' });

  try {
    const upstream = await axios.get(sourceUrl, {
      responseType: 'stream',
      timeout: 20000,
      maxRedirects: 0,
      maxContentLength: 30 * 1024 * 1024,
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
        Referer: 'https://shopee.sg/',
        'User-Agent': 'Mozilla/5.0 (compatible; ShopeeDashboardImageDownloader/1.0)',
      },
      validateStatus: (status) => status >= 200 && status < 300,
    });
    const contentType = String(upstream.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const extension = IMAGE_TYPES.get(contentType);
    if (!extension) {
      upstream.data.destroy();
      return res.status(415).json({ error: `이미지가 아닌 응답입니다 (${contentType || 'Content-Type 없음'}).` });
    }
    const filename = `${safeFilename(req.query.name)}.${extension}`;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="image.${extension}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'no-store');
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    upstream.data.on('error', (error) => { if (!res.headersSent) res.status(502).json({ error: error.message }); else res.destroy(error); });
    upstream.data.pipe(res);
  } catch (error) {
    const status = error.response?.status;
    return res.status(502).json({ error: status ? `Shopee 이미지 서버 HTTP ${status}` : `이미지 다운로드 실패: ${error.code || error.message}` });
  }
});

module.exports = router;
