function isAllowedImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return /(^|\.)shopee\.[a-z.]+$/.test(host)
      || /(^|\.)susercontent\.com$/.test(host)
      || /(^|\.)shopeemobile\.com$/.test(host)
      || /(^|\.)pstatic\.net$/.test(host)
      || /(^|\.)phinf\.naver\.net$/.test(host);
  } catch {
    return false;
  }
}

function safeFilename(value) {
  return String(value || 'image')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^\.+|[. ]+$/g, '')
    .slice(0, 60) || 'image';
}

module.exports = { isAllowedImageUrl, safeFilename };
