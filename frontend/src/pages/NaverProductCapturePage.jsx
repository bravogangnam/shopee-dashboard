import { useMemo, useState } from 'react';
import { getStoredToken } from '../api/client.js';
import { normalizeClipboardText } from '../utils/clipboard.js';

const STORAGE_KEY = 'naver_product_capture_v1';

function naverCollector() {
  const toast = (message, error = false) => {
    const element = document.createElement('div');
    element.textContent = message;
    Object.assign(element.style, { position: 'fixed', top: '20px', right: '20px', maxWidth: '440px', padding: '14px 18px', borderRadius: '10px', background: error ? '#b91c1c' : '#166534', color: '#fff', fontSize: '14px', fontWeight: '700', lineHeight: '1.5', boxShadow: '0 12px 30px rgba(0,0,0,.28)', zIndex: '2147483647', transition: 'opacity .3s' });
    document.body.appendChild(element);
    setTimeout(() => { element.style.opacity = '0'; setTimeout(() => element.remove(), 300); }, 4500);
  };
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const imageUrl = (value) => {
    if (value && typeof value === 'object') value = value.originalUrl || value.url || value.imageUrl || value.src;
    const text = clean(value);
    if (!/^https?:\/\//i.test(text)) return '';
    try { const url = new URL(text); url.searchParams.delete('type'); return url.toString(); } catch { return text; }
  };
  const unique = (values) => [...new Set(values.map(imageUrl).filter(Boolean))];
  const state = window.__PRELOADED_STATE__ || {};
  const simple = state.simpleProductForDetailPage?.A || state.product || {};
  const productId = String(simple.id || location.pathname.match(/\/products\/(\d+)/)?.[1] || '');
  const channelUid = simple.channel?.channelUid || state.channel?.channelUid || '';
  if (!productId || !channelUid) { toast('네이버 상품 정보를 찾지 못했습니다. 상품 페이지가 완전히 열린 뒤 다시 실행하세요.', true); return; }
  const prefix = location.hostname.includes('brand.naver.com') ? '/n' : '/i';
  const findProduct = (root) => {
    const seen = new WeakSet(); let best = null;
    const walk = (value, depth) => {
      if (!value || typeof value !== 'object' || seen.has(value) || depth > 10) return;
      seen.add(value);
      if (Array.isArray(value.optionCombinations) || (value.name && (value.productImages || value.channelProductImages))) {
        if (!best || (value.optionCombinations?.length || 0) > (best.optionCombinations?.length || 0)) best = value;
      }
      Object.keys(value).slice(0, 500).forEach((key) => walk(value[key], depth + 1));
    };
    walk(root, 0); return best || root;
  };
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
  const fallbackCopy = (text) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    Object.assign(textarea.style, { position: 'fixed', left: '20px', top: '20px', width: '700px', height: '400px', zIndex: '2147483646' });
    document.body.appendChild(textarea); textarea.focus(); textarea.select(); document.execCommand('copy');
    toast('자동 복사에 실패했습니다. 열린 복사창에서 Ctrl+C를 눌러주세요.', true);
  };
  (async () => {
    try {
      const response = await fetch(`${prefix}/v2/channels/${encodeURIComponent(channelUid)}/products/${encodeURIComponent(productId)}?withWindow=true`, { credentials: 'include' });
      if (!response.ok) throw new Error(`상품 API HTTP ${response.status}`);
      const product = findProduct(await response.json());
      const productName = clean(product.name || simple.name || document.querySelector('h1')?.textContent || document.title.split(':')[0]);
      const basePrice = Number(product.benefitsView?.discountedSalePrice ?? product.discountedSalePrice ?? product.salePrice ?? simple.benefitsView?.discountedSalePrice ?? simple.salePrice ?? 0);
      const mainImages = unique([
        simple.representativeImageUrl, ...(simple.optionalImageUrls || []), product.representativeImageUrl,
        ...(product.optionalImageUrls || []), ...(product.productImages || []), ...(product.channelProductImages || []), ...(product.galleryImages || []),
      ]).map((url) => ({ url }));
      const imageMap = optionImageMap(product);
      const combinations = Array.isArray(product.optionCombinations) ? product.optionCombinations : [];
      const rows = combinations.length ? combinations.map((option) => {
        const parts = [1, 2, 3, 4, 5].map((index) => clean(option[`optionName${index}`])).filter(Boolean);
        const optionName = parts.join(' / ') || '-';
        const directImage = imageUrl(option.imageInfo?.images?.[0] || option.imageInfo || option.imageUrl || option.image);
        const mappedImage = parts.map((part) => imageMap.get(part)).find(Boolean) || '';
        const price = Number(option.dispDiscountedSalePrice ?? option.discountedSalePrice ?? (basePrice + Number(option.price || 0)));
        return { optionName, price, optionImage: directImage || mappedImage };
      }) : [{ optionName: '-', price: basePrice, optionImage: '' }];
      const payload = { source: 'naver', productName, mainImages, rows };
      const text = JSON.stringify(payload, null, 2);
      try { await navigator.clipboard.writeText(text); toast(`네이버 상품수집 완료 · 옵션 ${rows.length}개 · 메인 사진 ${mainImages.length}장`); }
      catch { fallbackCopy(text); }
    } catch (error) { toast(`네이버 상품수집 실패: ${error.message}`, true); }
  })();
}

const BOOKMARKLET_CODE = `javascript:(${naverCollector.toString()})()`;
const cleanUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : '';
const safeStem = (value) => String(value || '사진').normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 48) || '사진';

function normalizeState(raw) {
  const product = raw?.product;
  if (!product) return { product: null };
  return { product: {
    name: String(product.name || ''),
    mainImages: [...new Set((product.mainImages || []).map((item) => cleanUrl(item?.url || item)).filter(Boolean))].map((url) => ({ url })),
    rows: (product.rows || []).map((row) => ({ option: String(row.option || '-'), price: String(row.price ?? ''), optionImage: cleanUrl(row.optionImage) })),
  } };
}

function loadState() { try { return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); } catch { return { product: null }; } }

function parseCapture(text) {
  const parsed = JSON.parse(text);
  if (!parsed || parsed.source !== 'naver' || !Array.isArray(parsed.rows) || !parsed.rows.length) throw new Error('네이버 수집 JSON이 아닙니다.');
  return normalizeState({ product: {
    name: parsed.productName,
    mainImages: parsed.mainImages,
    rows: parsed.rows.map((row) => ({ option: row.optionName ?? row.option ?? '-', price: row.price, optionImage: row.optionImage })),
  } }).product;
}

export default function NaverProductCapturePage() {
  const [state, setState] = useState(loadState);
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [downloading, setDownloading] = useState(false);
  const product = state.product;
  const optionRows = useMemo(() => (product?.rows || []).map((row, index) => ({ ...row, sequence: index + 1 })), [product]);

  const persist = (next) => { const normalized = normalizeState(next); setState(normalized); localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); };
  const handlePaste = (value) => {
    setPasteText(value); if (!value.trim()) { localStorage.removeItem(STORAGE_KEY); setState({ product: null }); setError(''); setMessage(''); return; }
    try { persist({ product: parseCapture(value) }); setError(''); setMessage('붙여넣기 자동 적용 완료'); } catch (e) { if (value.trim().endsWith('}')) setError(`붙여넣기 오류: ${e.message}`); }
  };
  const reset = () => { localStorage.removeItem(STORAGE_KEY); setState({ product: null }); setPasteText(''); setError(''); setMessage(''); };
  const updateName = (name) => persist({ product: { ...product, name } });
  const updateRow = (index, patch) => persist({ product: { ...product, rows: product.rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row) } });
  const copy = async (text, success) => { try { await navigator.clipboard.writeText(normalizeClipboardText(text)); setMessage(success); setError(''); } catch { setError('복사에 실패했습니다.'); } };
  const downloadOne = async (url, name) => {
    const token = getStoredToken(); const response = await fetch(`/api/product-capture/image-download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`, { credentials: 'include', headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `HTTP ${response.status}`); }
    const blob = await response.blob(); const disposition = response.headers.get('content-disposition') || ''; const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const objectUrl = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = encoded ? decodeURIComponent(encoded) : name; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };
  const downloadMany = async (items, kind) => {
    setDownloading(true); setError(''); const seen = new Set(), failures = []; const targets = items.filter((item) => { const url = item.url || item.optionImage; if (!url || seen.has(url)) return false; seen.add(url); return true; });
    for (let index = 0; index < targets.length; index += 1) { const item = targets[index], number = String(item.sequence || index + 1).padStart(2, '0'), name = kind === 'main' ? `main_${number}` : `option_${number}_${safeStem(item.option)}`; try { await downloadOne(item.url || item.optionImage, name); } catch (e) { failures.push(`${name}: ${e.message}`); } }
    setDownloading(false); setMessage(`${targets.length - failures.length}개 이미지 다운로드 완료`); if (failures.length) setError(`${failures.length}개 실패: ${failures.join(' / ')}`);
  };

  return <section className="page product-capture-page">
    <div className="page-header"><div><h1>네이버 상품 수집</h1><p>네이버 브랜드스토어와 스마트스토어의 상품명, 옵션, 가격과 상품 사진을 수집합니다.</p></div></div>
    <div className="card"><h3>네이버 북마클릿 안내</h3><p>아래 링크를 <strong>북마크바로 드래그해서 등록</strong>하세요.</p><div className="bookmarklet-actions"><button className="action-btn" type="button" onClick={() => navigator.clipboard.writeText(BOOKMARKLET_CODE)}>북마클릿 코드 복사</button><a className="action-btn" href={BOOKMARKLET_CODE} onClick={(e) => e.preventDefault()}>네이버 상품수집 (드래그 등록용)</a></div></div>
    <div className="product-capture-workspace">
      <section className="card"><h3>상품정보 붙여넣기</h3><textarea rows={3} value={pasteText} onChange={(e) => handlePaste(e.target.value)} placeholder="네이버 북마클릿 JSON을 붙여넣으세요." /><div className="product-capture-paste-actions"><button className="action-btn" type="button" onClick={reset}>전체 초기화</button><button className="action-btn" type="button" disabled={!product} onClick={() => copy(optionRows.map((row) => row.option === '-' ? product.name : `${product.name}\t${row.option}`).join('\n'), '상품명+옵션명 복사 완료')}>상품명+옵션명 복사</button><button className="action-btn" type="button" disabled={!product} onClick={() => copy(optionRows.map((row) => row.price).join('\n'), '가격 복사 완료')}>가격 복사</button></div></section>
      <section className="card product-capture-reference-panel"><h3>수집 결과</h3><div className="table-wrap product-capture-result-wrap"><table className="table"><thead><tr><th>상품명</th><th>옵션명</th><th>가격</th></tr></thead><tbody>{optionRows.length ? optionRows.map((row, index) => <tr key={index}><td>{index === 0 ? <input value={product.name} onChange={(e) => updateName(e.target.value)} /> : ''}</td><td><input value={row.option} onChange={(e) => updateRow(index, { option: e.target.value })} /></td><td><input value={row.price} onChange={(e) => updateRow(index, { price: e.target.value })} /></td></tr>) : <tr><td colSpan="3" className="empty-cell">네이버 수집 JSON을 붙여넣으세요.</td></tr>}</tbody></table></div></section>
    </div>
    <div className="product-capture-image-sections">
      <NaverImages title="메인 사진" items={(product?.mainImages || []).map((item, index) => ({ ...item, sequence: index + 1 }))} empty="수집된 메인 사진이 없습니다" downloading={downloading} onAll={(items) => downloadMany(items, 'main')} onOne={(item) => downloadMany([item], 'main')} />
      <NaverImages title="옵션 사진" items={optionRows} empty="수집된 옵션이 없습니다" downloading={downloading} onAll={(items) => downloadMany(items, 'option')} onOne={(item) => downloadMany([item], 'option')} />
    </div>
    {error && <div className="alert product-capture-status">{error}</div>}{message && <div className="notice product-capture-status">{message}</div>}
  </section>;
}

function NaverImages({ title, items, empty, downloading, onAll, onOne }) {
  return <section className="card"><div className="product-capture-image-header"><h3>{title}</h3><button className="action-btn" type="button" disabled={downloading || !items.some((item) => item.url || item.optionImage)} onClick={() => onAll(items)}>{title} 전체 다운로드</button></div>{items.length ? <div className="product-capture-image-grid">{items.map((item, index) => { const url = item.url || item.optionImage, label = title === '메인 사진' ? `메인 사진 ${item.sequence}` : `${item.sequence}. ${item.option}`; return <article className="product-capture-image-card" key={`${item.sequence}-${url || index}`}><div className="product-capture-image-label" title={label}>{label}</div>{url ? <img src={url} alt={label} referrerPolicy="no-referrer" /> : <div className="product-capture-no-image">사진 없음</div>}<button className="action-btn" type="button" disabled={!url || downloading} onClick={() => onOne(item)}>개별 다운로드</button></article>; })}</div> : <p className="product-capture-image-empty">{empty}</p>}</section>;
}
