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
    const sourceHost = new URL(sourceUrl).hostname.toLowerCase();
    const referer = sourceHost.endsWith('pstatic.net') || sourceHost.endsWith('phinf.naver.net')
      ? 'https://shopping.naver.com/'
      : 'https://shopee.sg/';
    const upstream = await axios.get(sourceUrl, {
      responseType: 'stream',
      timeout: 20000,
      maxRedirects: 0,
      maxContentLength: 30 * 1024 * 1024,
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
        Referer: referer,
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

router.get('/naver-video-download', requireAuth, async (req, res) => {
  const vid = String(req.query.vid || '').trim();
  const inkey = String(req.query.inkey || '').trim();
  if (!/^[A-F0-9]{20,80}$/i.test(vid) || !/^[A-Za-z0-9_-]{20,200}$/.test(inkey)) {
    return res.status(400).json({ error: '올바르지 않은 네이버 동영상 정보입니다.' });
  }

  try {
    const metadataUrl = `https://apis.naver.com/rmcnmv/rmcnmv/vod/play/v2.0/${encodeURIComponent(vid)}?key=${encodeURIComponent(inkey)}`;
    const metadataResponse = await axios.get(metadataUrl, {
      timeout: 15000,
      headers: { Referer: 'https://smartstore.naver.com/', 'User-Agent': 'Mozilla/5.0' },
    });
    const candidates = Array.isArray(metadataResponse.data?.videos?.list) ? metadataResponse.data.videos.list : [];
    const videos = candidates
      .filter((item) => typeof item?.source === 'string' && /^https:\/\//i.test(item.source))
      .filter((item) => /(^|\.)pstatic\.net$/i.test(new URL(item.source).hostname))
      .sort((a, b) => Number(b.encodingOption?.width || 0) - Number(a.encodingOption?.width || 0));
    if (!videos.length) return res.status(404).json({ error: '다운로드할 수 있는 MP4 주소를 찾지 못했습니다.' });

    const upstream = await axios.get(videos[0].source, {
      responseType: 'stream', timeout: 30000, maxRedirects: 0, maxContentLength: 500 * 1024 * 1024,
      headers: { Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.5', Referer: 'https://smartstore.naver.com/', 'User-Agent': 'Mozilla/5.0' },
      validateStatus: (status) => status >= 200 && status < 300,
    });
    const contentType = String(upstream.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'video/mp4') {
      upstream.data.destroy();
      return res.status(415).json({ error: `MP4가 아닌 응답입니다 (${contentType || 'Content-Type 없음'}).` });
    }
    const filename = `${safeFilename(req.query.name || 'video')}.mp4`;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="video.mp4"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'no-store');
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    upstream.data.on('error', (error) => { if (!res.headersSent) res.status(502).json({ error: error.message }); else res.destroy(error); });
    upstream.data.pipe(res);
  } catch (error) {
    const status = error.response?.status;
    return res.status(502).json({ error: status ? `네이버 동영상 서버 HTTP ${status}` : `동영상 다운로드 실패: ${error.code || error.message}` });
  }
});

module.exports = router;
