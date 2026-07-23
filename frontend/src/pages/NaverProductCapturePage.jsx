import { useMemo, useState } from 'react';
import { getStoredToken } from '../api/client.js';
import { normalizeClipboardText } from '../utils/clipboard.js';

const STORAGE_KEY = 'naver_product_capture_v1';

function naverCollector() {
  const toast = (message, error = false) => {
    const element = document.createElement('div');
    element.textContent = message;
    Object.assign(element.style, { position: 'fixed', top: '20px', right: '20px', maxWidth: '460px', padding: '14px 18px', borderRadius: '10px', background: error ? '#b91c1c' : '#166534', color: '#fff', fontSize: '14px', fontWeight: '700', lineHeight: '1.5', boxShadow: '0 12px 30px rgba(0,0,0,.28)', zIndex: '2147483647', transition: 'opacity .3s' });
    document.body.appendChild(element);
    setTimeout(() => { element.style.opacity = '0'; setTimeout(() => element.remove(), 300); }, 5000);
  };
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const imageUrl = (value) => {
    if (value && typeof value === 'object') value = value.originalUrl || value.url || value.imageUrl || value.src;
    const text = clean(value);
    if (!/^https?:\/\//i.test(text)) return '';
    try { const url = new URL(text); url.searchParams.delete('type'); return url.toString(); } catch { return text; }
  };
  const unique = (values) => [...new Set(values.map(imageUrl).filter(Boolean))];
  const asArray = (value) => Array.isArray(value) ? value : value ? [value] : [];
  const state = window.__PRELOADED_STATE__ || {};
  const pathProductId = String(location.pathname.match(/\/products\/(\d+)/)?.[1] || '');
  const productImageValues = (product) => [
    product?.representativeImageUrl,
    ...asArray(product?.optionalImageUrls),
    ...asArray(product?.productImages),
    ...asArray(product?.channelProductImages),
    ...asArray(product?.galleryImages),
    ...asArray(product?.images),
  ];
  const findProduct = (root, expectedId = '') => {
    const seen = new WeakSet(); let best = null; let bestScore = -1;
    const walk = (value, depth) => {
      if (!value || typeof value !== 'object' || seen.has(value) || depth > 10) return;
      seen.add(value);
      const id = String(value.id || value.productId || value.channelProductNo || '');
      const imageCount = unique(productImageValues(value)).length;
      const optionCount = Array.isArray(value.optionCombinations) ? value.optionCombinations.length : 0;
      const score = (expectedId && id === expectedId ? 10000 : 0) + (value.name ? 100 : 0) + imageCount * 20 + optionCount;
      if ((imageCount || optionCount) && score > bestScore) {
        best = value;
        bestScore = score;
      }
      Object.keys(value).slice(0, 500).forEach((key) => walk(value[key], depth + 1));
    };
    walk(root, 0); return best;
  };
  const simpleRoot = state.simpleProductForDetailPage?.A || state.simpleProductForDetailPage || state.product || {};
  const simple = findProduct(simpleRoot, pathProductId) || simpleRoot;
  const stateProduct = findProduct(state, pathProductId) || simple;
  const productId = String(pathProductId || simple.id || stateProduct.id || '');
  const channelUid = simple.channel?.channelUid || stateProduct.channel?.channelUid || state.channel?.channelUid || '';
  if (!productId) { toast('네이버 상품번호를 찾지 못했습니다. 상품 페이지를 새로고침한 뒤 다시 실행하세요.', true); return; }
  const prefix = location.hostname.includes('brand.naver.com') ? '/n' : '/i';
  const optionImageMap = (product) => {
    const map = new Map();
    (product.standardOptions || []).forEach((group) => (group.options || []).forEach((option) => {
      const name = clean(option.optionName || option.name || option.optionValueText);
      const images = option.imageInfo?.images || option.images || [];
      const url = imageUrl(images[0] || option.imageInfo || option);
      if (name && url) map.set(name, url);
    }));
    return map;
  };
  const documents = () => {
    const result = [document];
    document.querySelectorAll('iframe').forEach((frame) => { try { if (frame.contentDocument) result.push(frame.contentDocument); } catch {} });
    return result;
  };
  const collectStructuredMainImages = () => {
    const values = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((element) => {
      try {
        const roots = [].concat(JSON.parse(element.textContent || 'null') || []);
        const visit = (value) => {
          if (!value || typeof value !== 'object') return;
          if (String(value['@type'] || '').toLowerCase() === 'product') {
            values.push(...[].concat(value.image || []));
          }
          if (Array.isArray(value['@graph'])) value['@graph'].forEach(visit);
        };
        roots.forEach(visit);
      } catch {}
    });
    return values;
  };
  const collectDomMainImages = () => {
    const values = [
      document.querySelector('meta[property="og:image"]')?.content,
      document.querySelector('meta[name="twitter:image"]')?.content,
      ...collectStructuredMainImages(),
    ];
    const detailRoots = new Set(documents().flatMap((doc) => [...doc.querySelectorAll('.se-main-container, [class*="detail_content"], [class*="detailContent"]')]));
    [...document.images].forEach((element) => {
      if ([...detailRoots].some((root) => root.contains(element))) return;
      const url = element.dataset.src || element.dataset.original || element.currentSrc || element.src;
      const width = Number(element.naturalWidth || element.width || 0);
      const height = Number(element.naturalHeight || element.height || 0);
      const looksLikeProductImage = /shop-phinf|shopping-phinf|pstatic\.net/i.test(url || '');
      const looksLikeGallery = /thumb|image|gallery|product/i.test(String(element.className || '') + String(element.parentElement?.className || ''));
      if (looksLikeProductImage && looksLikeGallery && width >= 80 && height >= 80) values.push(url);
    });
    return unique(values);
  };
  const collectDetailImages = () => unique(documents().flatMap((doc) => [...doc.querySelectorAll('img.se-image-resource, .se-main-container img')].map((element) => element.dataset.src || element.dataset.original || element.currentSrc || element.src)));
  const collectVideos = () => {
    const found = new Map();
    documents().forEach((doc) => doc.querySelectorAll('script.__se_module_data').forEach((element) => {
      const raw = element.getAttribute('data-module-v2') || element.getAttribute('data-module') || '';
      try {
        const module = JSON.parse(raw); const data = module.data || {};
        if (data.videoType === 'player' && data.vid && data.inkey && !found.has(data.vid)) found.set(data.vid, { vid: String(data.vid), inkey: String(data.inkey), thumbnail: imageUrl(data.thumbnail) });
      } catch {}
    }));
    return [...found.values()];
  };
  const collectDomOptions = (basePrice) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const optionHeading = [...document.querySelectorAll('body *')].find((element) => {
      const text = clean(element.textContent);
      return element.children.length < 3 && /^옵션\s*선택/.test(text);
    });
    if (!optionHeading) return [];
    let optionRoot = optionHeading.parentElement;
    for (let element = optionRoot; element && element !== document.body; element = element.parentElement) {
      const inputs = element.querySelectorAll('input[type="radio"], input[type="checkbox"]');
      if (inputs.length >= 2 && inputs.length <= 100) { optionRoot = element; break; }
    }
    const controls = [...optionRoot.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
    const found = []; const names = new Set();
    controls.forEach((control) => {
      let holder = control.labels?.[0] || control.closest('label');
      if (!holder) {
        for (let element = control.parentElement; element && element !== optionRoot; element = element.parentElement) {
          const text = clean(element.innerText || element.textContent);
          if (text && text.length <= 180) { holder = element; break; }
        }
      }
      if (holder && !visible(holder)) return;
      let name = clean(control.getAttribute('aria-label') || holder?.innerText || holder?.textContent || control.value);
      name = name.replace(/^옵션\s*선택(?:\s*\([^)]*\))?\s*/g, '').replace(/\s*[+-]\s*[\d,]+\s*원\s*$/g, '').trim();
      if (!name || /^(on|off|true|false)$/i.test(name) || names.has(name)) return;
      names.add(name);
      const imageElement = holder?.querySelector?.('img');
      const background = holder ? getComputedStyle(holder).backgroundImage.match(/url\(["']?(.+?)["']?\)/)?.[1] : '';
      const optionImage = imageUrl(imageElement?.dataset?.src || imageElement?.currentSrc || imageElement?.src || background);
      const extraPrice = clean(holder?.innerText || holder?.textContent).match(/[+]\s*([\d,]+)\s*원/);
      found.push({ optionName: name, price: basePrice + Number((extraPrice?.[1] || '0').replace(/,/g, '')), optionImage });
    });
    return found;
  };
  const fallbackCopy = (text) => {
    const textarea = document.createElement('textarea'); textarea.value = text;
    Object.assign(textarea.style, { position: 'fixed', left: '20px', top: '20px', width: '700px', height: '400px', zIndex: '2147483646' });
    document.body.appendChild(textarea); textarea.focus(); textarea.select(); document.execCommand('copy');
    toast('자동 복사가 실패했습니다. 열린 복사창에서 Ctrl+C를 눌러주세요.', true);
  };
  (async () => {
    let product = stateProduct || simple; let apiWarning = '';
    if (channelUid) {
      try {
        const endpoint = `${prefix}/v2/channels/${encodeURIComponent(channelUid)}/products/${encodeURIComponent(productId)}?withWindow=true`;
        let response = await fetch(endpoint, { credentials: 'include' });
        if (response.status === 429) {
          const retryAfter = Math.min(3000, Math.max(800, Number(response.headers.get('retry-after') || 1) * 1000));
          await new Promise((resolve) => setTimeout(resolve, retryAfter));
          response = await fetch(endpoint, { credentials: 'include' });
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const responseBody = await response.json();
        product = findProduct(responseBody, productId) || responseBody;
      } catch (error) { apiWarning = `상품 API ${error.message}`; }
    } else apiWarning = '채널 정보 없음';
    try {
      const productName = clean(product.name || simple.name || document.querySelector('h1')?.textContent || document.title.split(':')[0]);
      const basePrice = Number(product.benefitsView?.discountedSalePrice ?? product.discountedSalePrice ?? product.salePrice ?? simple.benefitsView?.discountedSalePrice ?? simple.salePrice ?? 0);
      const mainImages = unique([
        ...productImageValues(simple),
        ...productImageValues(stateProduct),
        ...productImageValues(product),
        ...collectDomMainImages(),
      ]).map((url) => ({ url }));
      const imageMap = optionImageMap(product);
      const combinations = Array.isArray(product.optionCombinations) ? product.optionCombinations : [];
      const apiRows = combinations.length ? combinations.map((option) => {
        const parts = [1, 2, 3, 4, 5].map((index) => clean(option[`optionName${index}`])).filter(Boolean);
        const optionName = parts.join(' / ') || '-';
        const directImage = imageUrl(option.imageInfo?.images?.[0] || option.imageInfo || option.imageUrl || option.image);
        const mappedImage = parts.map((part) => imageMap.get(part)).find(Boolean) || '';
        const price = Number(option.dispDiscountedSalePrice ?? option.discountedSalePrice ?? (basePrice + Number(option.price || 0)));
        return { optionName, price, optionImage: directImage || mappedImage };
      }) : [];
      const domRows = apiRows.length ? [] : collectDomOptions(basePrice);
      const rows = apiRows.length ? apiRows : domRows.length ? domRows : [{ optionName: '-', price: basePrice, optionImage: '' }];
      const detailImages = collectDetailImages().map((url) => ({ url }));
      const detailVideos = collectVideos();
      const payload = { source: 'naver', productName, mainImages, detailImages, detailVideos, rows, warning: apiWarning || undefined };
      const text = JSON.stringify(payload, null, 2);
      const status = `네이버 상품수집 완료 · 옵션 ${rows.length}개 · 메인 ${mainImages.length}장 · 상세 ${detailImages.length}장 · 동영상 ${detailVideos.length}개${apiWarning ? ` · 일부 정보 제한(${apiWarning})` : ''}`;
      try { await navigator.clipboard.writeText(text); toast(status); } catch { fallbackCopy(text); }
    } catch (error) { toast(`네이버 상품수집 실패: ${error.message}`, true); }
  })();
}

const BOOKMARKLET_CODE = `javascript:(${naverCollector.toString()})()`;
export const NAVER_BOOKMARKLET_CODE = BOOKMARKLET_CODE;
const cleanUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : '';
const safeStem = (value) => String(value || '파일').normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 48) || '파일';

function normalizeState(raw) {
  const product = raw?.product;
  if (!product) return { product: null };
  const name = String(product.name || '');
  return { product: {
    name, warning: String(product.warning || ''),
    mainImages: [...new Set((product.mainImages || []).map((item) => cleanUrl(item?.url || item)).filter(Boolean))].map((url) => ({ url })),
    detailImages: [...new Set((product.detailImages || []).map((item) => cleanUrl(item?.url || item)).filter(Boolean))].map((url) => ({ url })),
    detailVideos: [...new Map((product.detailVideos || []).filter((item) => /^[A-F0-9]+$/i.test(item?.vid || '') && item?.inkey).map((item) => [item.vid, { vid: String(item.vid), inkey: String(item.inkey), thumbnail: cleanUrl(item.thumbnail) }])).values()],
    rows: (product.rows || []).map((row) => {
      const option = String(row.option || '-');
      return { productName: String(row.productName || (option === '-' ? name : `${name} ${option}`)), option, price: String(row.price ?? ''), optionImage: cleanUrl(row.optionImage) };
    }),
  } };
}

function loadState() { try { return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); } catch { return { product: null }; } }
function parseCapture(text) {
  const parsed = JSON.parse(text);
  if (!parsed || parsed.source !== 'naver' || !Array.isArray(parsed.rows) || !parsed.rows.length) throw new Error('네이버 수집 JSON이 아닙니다.');
  return normalizeState({ product: { name: parsed.productName, warning: parsed.warning, mainImages: parsed.mainImages, detailImages: parsed.detailImages, detailVideos: parsed.detailVideos, rows: parsed.rows.map((row) => ({ option: row.optionName ?? row.option ?? '-', price: row.price, optionImage: row.optionImage })) } }).product;
}

export default function NaverProductCapturePage() {
  const [state, setState] = useState(loadState); const [pasteText, setPasteText] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [downloading, setDownloading] = useState(false);
  const product = state.product;
  const optionRows = useMemo(() => (product?.rows || []).map((row, index) => ({ ...row, sequence: index + 1 })), [product]);
  const persist = (next) => { const normalized = normalizeState(next); setState(normalized); localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); };
  const handlePaste = (value) => { setPasteText(value); if (!value.trim()) { localStorage.removeItem(STORAGE_KEY); setState({ product: null }); setError(''); setMessage(''); return; } try { const next = parseCapture(value); persist({ product: next }); setError(next.warning ? `일부 정보 제한: ${next.warning}. 페이지에 표시된 정보와 사진·동영상은 수집했습니다.` : ''); setMessage('붙여넣기 자동 적용 완료'); } catch (e) { if (value.trim().endsWith('}')) setError(`붙여넣기 오류: ${e.message}`); } };
  const reset = () => { localStorage.removeItem(STORAGE_KEY); setState({ product: null }); setPasteText(''); setError(''); setMessage(''); };
  const updateRow = (index, patch) => persist({ product: { ...product, rows: product.rows.map((row, rowIndex) => {
    if (rowIndex !== index) return row;
    if (patch.option !== undefined) return { ...row, ...patch, productName: patch.option === '-' ? product.name : `${product.name} ${patch.option}` };
    return { ...row, ...patch };
  }) } });
  const copy = async (text, success) => { try { await navigator.clipboard.writeText(normalizeClipboardText(text)); setMessage(success); setError(''); } catch { setError('복사에 실패했습니다.'); } };
  const authHeaders = () => { const token = getStoredToken(); return token ? { Authorization: `Bearer ${token}` } : {}; };
  const saveResponse = async (response, fallbackName) => { if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `HTTP ${response.status}`); } const blob = await response.blob(); const disposition = response.headers.get('content-disposition') || ''; const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]; const objectUrl = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = encoded ? decodeURIComponent(encoded) : fallbackName; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); };
  const downloadImage = async (url, name) => saveResponse(await fetch(`/api/product-capture/image-download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`, { credentials: 'include', headers: authHeaders() }), name);
  const downloadVideo = async (item, name) => saveResponse(await fetch(`/api/product-capture/naver-video-download?vid=${encodeURIComponent(item.vid)}&inkey=${encodeURIComponent(item.inkey)}&name=${encodeURIComponent(name)}`, { credentials: 'include', headers: authHeaders() }), `${name}.mp4`);
  const runDownloads = async (targets, action, nameFor) => { setDownloading(true); setError(''); const failures = []; for (let index = 0; index < targets.length; index += 1) { const name = nameFor(targets[index], index); try { await action(targets[index], name); } catch (e) { failures.push(`${name}: ${e.message}`); } } setDownloading(false); setMessage(`${targets.length - failures.length}개 다운로드 완료`); if (failures.length) setError(`${failures.length}개 실패: ${failures.join(' / ')}`); };
  const downloadMany = (items, kind) => { const seen = new Set(); const targets = items.filter((item) => { const url = item.url || item.optionImage; if (!url || seen.has(url)) return false; seen.add(url); return true; }); return runDownloads(targets, (item, name) => downloadImage(item.url || item.optionImage, name), (item, index) => { const number = String(item.sequence || index + 1).padStart(2, '0'); return kind === 'main' ? `main_${number}` : kind === 'detail' ? `detail_${number}` : `option_${number}_${safeStem(item.option)}`; }); };
  const downloadVideos = (items) => runDownloads(items, downloadVideo, (item, index) => `video_${String(item.sequence || index + 1).padStart(2, '0')}`);

  return <section className="page product-capture-page">
    <div className="page-header"><div><h1>네이버 상품 수집</h1><p>네이버 브랜드스토어와 스마트스토어의 상품명, 옵션, 가격, 상품 사진과 상세 사진·동영상을 수집합니다.</p></div></div>
    <div className="card"><h3>네이버 북마클릿 안내</h3><p>아래 링크를 <strong>북마크바로 드래그해서 등록</strong>하세요.</p><div className="bookmarklet-actions"><button className="action-btn" type="button" onClick={() => navigator.clipboard.writeText(BOOKMARKLET_CODE)}>북마클릿 코드 복사</button><a className="action-btn" href={BOOKMARKLET_CODE} onClick={(e) => e.preventDefault()}>네이버 상품수집 (드래그 등록)</a></div></div>
    <div className="product-capture-workspace">
      <section className="card"><h3>상품정보 붙여넣기</h3><textarea rows={3} value={pasteText} onChange={(e) => handlePaste(e.target.value)} placeholder="네이버 북마클릿 JSON을 붙여넣으세요." /><div className="product-capture-paste-actions"><button className="action-btn" type="button" onClick={reset}>전체 초기화</button><button className="action-btn" type="button" disabled={!product} onClick={() => copy(optionRows.map((row) => row.productName).join('\n'), '상품명 복사 완료')}>상품명 복사</button><button className="action-btn" type="button" disabled={!product} onClick={() => copy(optionRows.map((row) => row.option).join('\n'), '옵션명 복사 완료')}>옵션명 복사</button><button className="action-btn" type="button" disabled={!product} onClick={() => copy(optionRows.map((row) => row.option === '-' ? product.name : `${product.name}\t${row.option}`).join('\n'), '상품명+옵션명 복사 완료')}>상품명+옵션명 복사</button><button className="action-btn" type="button" disabled={!product} onClick={() => copy(optionRows.map((row) => row.price).join('\n'), '가격 복사 완료')}>가격 복사</button></div></section>
      <section className="card product-capture-reference-panel"><h3>수집 결과</h3><div className="table-wrap product-capture-result-wrap"><table className="table"><thead><tr><th>상품명</th><th>옵션명</th><th>가격</th></tr></thead><tbody>{optionRows.length ? optionRows.map((row, index) => <tr key={index}><td><input value={row.productName} onChange={(e) => updateRow(index, { productName: e.target.value })} /></td><td><input value={row.option} onChange={(e) => updateRow(index, { option: e.target.value })} /></td><td><input value={row.price} onChange={(e) => updateRow(index, { price: e.target.value })} /></td></tr>) : <tr><td colSpan="3" className="empty-cell">네이버 수집 JSON을 붙여넣으세요.</td></tr>}</tbody></table></div></section>
    </div>
    <div className="product-capture-image-sections">
      <NaverImages title="메인 사진" items={(product?.mainImages || []).map((item, index) => ({ ...item, sequence: index + 1 }))} empty="수집된 메인 사진이 없습니다" downloading={downloading} onAll={(items) => downloadMany(items, 'main')} onOne={(item) => downloadMany([item], 'main')} />
      <NaverImages title="옵션 사진" items={optionRows} empty="수집된 옵션이 없습니다" downloading={downloading} onAll={(items) => downloadMany(items, 'option')} onOne={(item) => downloadMany([item], 'option')} />
      <NaverImages className="naver-detail-panel" title="상세 사진" items={(product?.detailImages || []).map((item, index) => ({ ...item, sequence: index + 1 }))} empty="수집된 상세 사진이 없습니다" downloading={downloading} onAll={(items) => downloadMany(items, 'detail')} onOne={(item) => downloadMany([item], 'detail')} />
      <NaverVideos items={(product?.detailVideos || []).map((item, index) => ({ ...item, sequence: index + 1 }))} downloading={downloading} onAll={downloadVideos} onOne={(item) => downloadVideos([item])} />
    </div>
    {error && <div className="alert product-capture-status">{error}</div>}{message && <div className="notice product-capture-status">{message}</div>}
  </section>;
}

function NaverImages({ className = '', title, items, empty, downloading, onAll, onOne }) {
  return <section className={`card ${className}`}><div className="product-capture-image-header"><h3>{title}</h3><button className="action-btn" type="button" disabled={downloading || !items.some((item) => item.url || item.optionImage)} onClick={() => onAll(items)}>{title} 전체 다운로드</button></div>{items.length ? <div className="product-capture-image-grid">{items.map((item, index) => { const url = item.url || item.optionImage; const label = title === '옵션 사진' ? `${item.sequence}. ${item.option}` : `${title} ${item.sequence}`; return <article className="product-capture-image-card" key={`${item.sequence}-${url || index}`}><div className="product-capture-image-label" title={label}>{label}</div>{url ? <img src={url} alt={label} referrerPolicy="no-referrer" /> : <div className="product-capture-no-image">사진 없음</div>}<button className="action-btn" type="button" disabled={!url || downloading} onClick={() => onOne(item)}>개별 다운로드</button></article>; })}</div> : <p className="product-capture-image-empty">{empty}</p>}</section>;
}

function NaverVideos({ items, downloading, onAll, onOne }) {
  return <section className="card naver-detail-panel"><div className="product-capture-image-header"><h3>상세 동영상</h3><button className="action-btn" type="button" disabled={downloading || !items.length} onClick={() => onAll(items)}>상세 동영상 전체 다운로드</button></div>{items.length ? <div className="product-capture-image-grid">{items.map((item) => <article className="product-capture-image-card" key={item.vid}><div className="product-capture-image-label">상세 동영상 {item.sequence}</div>{item.thumbnail ? <img src={item.thumbnail} alt={`상세 동영상 ${item.sequence}`} referrerPolicy="no-referrer" /> : <div className="product-capture-no-image">미리보기 없음</div>}<button className="action-btn" type="button" disabled={downloading} onClick={() => onOne(item)}>MP4 다운로드</button></article>)}</div> : <p className="product-capture-image-empty">수집된 상세 동영상이 없습니다</p>}</section>;
}
