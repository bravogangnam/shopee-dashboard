import { useMemo, useState } from 'react';
import { getStoredToken } from '../api/client.js';
import { normalizeClipboardText } from '../utils/clipboard.js';
import { NAVER_BOOKMARKLET_CODE } from './NaverProductCapturePage.jsx';
import { SHOPEE_BOOKMARKLET_CODE } from './ProductCapturePage.jsx';

const STORAGE_KEY = 'unified_product_capture_v1';
const LEGACY_SHOPEE_KEY = 'product_capture_v1';
const LEGACY_NAVER_KEY = 'naver_product_capture_v1';

const scriptBody = (code) => String(code || '').replace(/^javascript:/i, '');
const UNIFIED_BOOKMARKLET_CODE = `javascript:(()=>{const h=location.hostname.toLowerCase();if(h==="brand.naver.com"||h==="smartstore.naver.com"||h.endsWith(".smartstore.naver.com")){${scriptBody(NAVER_BOOKMARKLET_CODE)}}else if(h==="shopee.com"||h.startsWith("shopee.")||h.includes(".shopee.")){${scriptBody(SHOPEE_BOOKMARKLET_CODE)}}else{alert("지원하지 않는 상품 페이지입니다. Shopee 또는 네이버 상품 페이지에서 실행하세요.")}})()`;

const cleanUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : '';
const safeStem = (value, fallback = '파일') => String(value || fallback).normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 48) || fallback;

function normalizeProduct(product) {
  if (!product) return null;
  const source = product.source === 'naver' ? 'naver' : 'shopee';
  const name = String(product.name || '');
  return {
    source,
    name,
    warning: String(product.warning || ''),
    collectorVersion: String(product.collectorVersion || ''),
    optionSource: String(product.optionSource || ''),
    diagnostics: product.diagnostics && typeof product.diagnostics === 'object' ? {
      optionExpected: Boolean(product.diagnostics.optionExpected),
      collectedOptionCount: Number(product.diagnostics.collectedOptionCount || 0),
      mainImageCount: Number(product.diagnostics.mainImageCount || 0),
    } : null,
    mainImages: [...new Set((product.mainImages || []).map((item) => cleanUrl(item?.url || item)).filter(Boolean))].map((url) => ({ url })),
    detailImages: [...new Set((product.detailImages || []).map((item) => cleanUrl(item?.url || item)).filter(Boolean))].map((url) => ({ url })),
    detailVideos: [...new Map((product.detailVideos || []).filter((item) => /^[A-F0-9]+$/i.test(item?.vid || '') && item?.inkey).map((item) => [String(item.vid), {
      vid: String(item.vid),
      inkey: String(item.inkey),
      thumbnail: cleanUrl(item.thumbnail),
    }])).values()],
    rows: (product.rows || []).map((row) => {
      const option = String(row.option || '-');
      return {
        productName: String(row.productName || (source === 'naver' && option !== '-' ? `${name} ${option}` : name)),
        option,
        price: String(row.price ?? ''),
        optionImage: cleanUrl(row.optionImage),
      };
    }),
  };
}

function normalizeState(raw) {
  return { product: normalizeProduct(raw?.product) };
}

function migrateLegacyState() {
  try {
    const currentRaw = localStorage.getItem(STORAGE_KEY);
    if (currentRaw !== null) return normalizeState(JSON.parse(currentRaw));
  } catch {}

  try {
    const naver = JSON.parse(localStorage.getItem(LEGACY_NAVER_KEY) || 'null');
    if (naver?.product) {
      const migrated = normalizeState({ product: { ...naver.product, source: 'naver' } });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch {}

  try {
    const shopee = JSON.parse(localStorage.getItem(LEGACY_SHOPEE_KEY) || 'null');
    const legacyProduct = shopee?.products?.[0];
    if (legacyProduct) {
      const migrated = normalizeState({ product: { ...legacyProduct, source: 'shopee' } });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch {}
  return { product: null };
}

function parseCapture(text) {
  const parsed = JSON.parse(text);
  const legacyRows = Array.isArray(parsed);
  const rows = legacyRows ? parsed : parsed?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('상품 행이 없는 JSON입니다.');

  const source = parsed?.source === 'naver' ||
    Array.isArray(parsed?.detailImages) ||
    Array.isArray(parsed?.detailVideos)
    ? 'naver'
    : 'shopee';
  const name = String(legacyRows ? rows[0]?.['상품명'] : (parsed.productName ?? rows[0]?.['상품명'] ?? ''));
  const productRows = rows.map((row) => {
    const option = legacyRows ? row['옵션명'] : (row.optionName ?? row.option ?? row['옵션명']);
    const price = legacyRows ? row['수집가격'] : (row.price ?? row['수집가격']);
    if (option == null) throw new Error('옵션명 누락');
    if (price == null) throw new Error('수집가격 누락');
    const normalizedOption = String(option || '-');
    return {
      productName: source === 'naver' && normalizedOption !== '-' ? `${name} ${normalizedOption}` : name,
      option: normalizedOption,
      price: String(price),
      optionImage: row.optionImage,
    };
  });

  return normalizeProduct({
    source,
    name,
    warning: [
      parsed?.warning,
      parsed?.diagnostics?.optionExpected && !parsed?.diagnostics?.collectedOptionCount ? '옵션이 있는 상품이지만 옵션 목록을 확인하지 못함' : '',
      !name ? '상품명 누락' : '',
      productRows.some((row) => !row.price || !Number.isFinite(Number(row.price)) || Number(row.price) <= 0) ? '가격 확인 필요' : '',
    ].filter(Boolean).filter((warning, index, warnings) => warnings.indexOf(warning) === index).join(' / '),
    collectorVersion: parsed?.collectorVersion,
    optionSource: parsed?.optionSource,
    diagnostics: parsed?.diagnostics,
    mainImages: parsed?.mainImages,
    detailImages: parsed?.detailImages,
    detailVideos: parsed?.detailVideos,
    rows: productRows,
  });
}

export default function UnifiedProductCapturePage() {
  const [state, setState] = useState(migrateLegacyState);
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [downloading, setDownloading] = useState(false);
  const product = state.product;

  const rows = useMemo(() => (product?.rows || []).map((row, index) => ({ ...row, sequence: index + 1 })), [product]);
  const mainImages = useMemo(() => (product?.mainImages || []).map((item, index) => ({ ...item, sequence: index + 1 })), [product]);
  const detailImages = useMemo(() => (product?.detailImages || []).map((item, index) => ({ ...item, sequence: index + 1 })), [product]);
  const detailVideos = useMemo(() => (product?.detailVideos || []).map((item, index) => ({ ...item, sequence: index + 1 })), [product]);
  const optionSourceLabel = {
    'api-combinations': 'API 조합형',
    'api-standards': 'API 표준형',
    'api-simple': 'API 단독형',
    'shopee-models': 'Shopee 모델',
    dom: '화면 옵션',
    none: '옵션 없음',
    missing: '옵션 확인 실패',
  }[product?.optionSource] || '';

  const persist = (next) => {
    const normalized = normalizeState(next);
    setState(normalized);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  };

  const handlePaste = (value) => {
    setPasteText(value);
    const text = value.trim();
    if (!text) {
      persist({ product: null });
      setError('');
      setMessage('');
      return;
    }
    try {
      const next = parseCapture(text);
      persist({ product: next });
      setError(next.warning ? `일부 정보 제한: ${next.warning}. 페이지에서 확인된 정보는 정상 적용했습니다.` : '');
      setMessage(`${next.source === 'naver' ? '네이버' : 'Shopee'} 상품정보 자동 적용 완료`);
    } catch (captureError) {
      if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
        setError(`붙여넣기 오류: ${captureError.message}`);
        setMessage('');
      }
    }
  };

  const reset = () => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_SHOPEE_KEY);
    localStorage.removeItem(LEGACY_NAVER_KEY);
    setState({ product: null });
    setPasteText('');
    setError('');
    setMessage('');
  };

  const updateRow = (index, patch) => persist({
    product: {
      ...product,
      rows: product.rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row),
    },
  });

  const copy = async (text, success) => {
    try {
      await navigator.clipboard.writeText(normalizeClipboardText(text));
      setMessage(success);
      setError('');
    } catch {
      setError('복사에 실패했습니다. HTTPS 환경인지 확인하거나 직접 선택해서 복사하세요.');
    }
  };

  const authHeaders = () => {
    const token = getStoredToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const saveResponse = async (response, fallbackName) => {
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = encoded ? decodeURIComponent(encoded) : fallbackName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };

  const downloadImage = (url, name) => fetch(`/api/product-capture/image-download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`, {
    credentials: 'include',
    headers: authHeaders(),
  }).then((response) => saveResponse(response, name));

  const downloadVideo = (item, name) => fetch(`/api/product-capture/naver-video-download?vid=${encodeURIComponent(item.vid)}&inkey=${encodeURIComponent(item.inkey)}&name=${encodeURIComponent(name)}`, {
    credentials: 'include',
    headers: authHeaders(),
  }).then((response) => saveResponse(response, `${name}.mp4`));

  const runDownloads = async (targets, action, nameFor) => {
    setDownloading(true);
    setError('');
    setMessage('');
    const failures = [];
    for (let index = 0; index < targets.length; index += 1) {
      const name = nameFor(targets[index], index);
      try { await action(targets[index], name); }
      catch (downloadError) { failures.push(`${name}: ${downloadError.message}`); }
    }
    setDownloading(false);
    setMessage(`${targets.length - failures.length}개 다운로드 완료${failures.length ? `, ${failures.length}개 실패` : ''}`);
    if (failures.length) setError(`${failures.length}개 다운로드 실패: ${failures.join(' / ')}`);
  };

  const downloadImages = (items, kind) => {
    const seen = new Set();
    const targets = items.filter((item) => {
      const url = item.url || item.optionImage;
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
    return runDownloads(
      targets,
      (item, name) => downloadImage(item.url || item.optionImage, name),
      (item, index) => {
        const number = String(item.sequence || index + 1).padStart(2, '0');
        if (kind === 'main') return `main_${number}`;
        if (kind === 'detail') return `detail_${number}`;
        return `option_${number}_${safeStem(item.option, '사진')}`;
      },
    );
  };

  const downloadVideos = (items) => runDownloads(
    items,
    downloadVideo,
    (item, index) => `video_${String(item.sequence || index + 1).padStart(2, '0')}`,
  );

  return (
    <section className="page product-capture-page">
      <div className="page-header"><div><h1>상품 수집</h1><p>Shopee와 네이버 상품명, 옵션, 가격, 상품 사진을 하나의 화면에서 수집합니다.</p></div></div>
      <section className="card product-capture-bookmarklet-panel">
        <div className="product-capture-panel-header"><div><h3>통합 북마크릿 안내</h3><p>Shopee와 네이버 상품 페이지에서 같은 북마크릿을 실행하세요.</p></div></div>
        <div className="bookmarklet-actions">
          <button className="action-btn" type="button" onClick={() => navigator.clipboard.writeText(UNIFIED_BOOKMARKLET_CODE)}>통합 북마크릿 코드 복사</button>
          <a className="action-btn" href={UNIFIED_BOOKMARKLET_CODE} onClick={(event) => event.preventDefault()}>통합 상품수집 (드래그 등록)</a>
        </div>
      </section>

      <div className="product-capture-workspace">
        <section className="card product-capture-paste-panel">
          <div className="product-capture-panel-header"><h3>상품정보 붙여넣기</h3>{product && <div className="capture-source-meta"><span className={`capture-source-badge source-${product.source}`}>{product.source === 'naver' ? '네이버' : 'Shopee'}</span>{optionSourceLabel && <span className="capture-source-badge">{optionSourceLabel} · 옵션 {product.diagnostics?.collectedOptionCount ?? rows.length}개</span>}</div>}</div>
          <textarea rows={3} value={pasteText} onChange={(event) => handlePaste(event.target.value)} placeholder="Shopee 또는 네이버 북마크릿 JSON을 붙여넣으세요." />
          <div className="product-capture-paste-actions">
            <button className="action-btn" type="button" onClick={reset}>전체 초기화</button>
            <button className="action-btn" type="button" disabled={!rows.length} onClick={() => copy(rows.map((row) => row.productName).join('\n'), '상품명 복사 완료')}>상품명 복사</button>
            <button className="action-btn" type="button" disabled={!rows.length} onClick={() => copy(rows.map((row) => row.option).join('\n'), '옵션명 복사 완료')}>옵션명 복사</button>
            <button className="action-btn" type="button" disabled={!rows.length} onClick={() => copy(rows.map((row) => row.option === '-' ? product.name : `${product.name}\t${row.option}`).join('\n'), '상품명+옵션명 복사 완료')}>상품명+옵션명 복사</button>
            <button className="action-btn" type="button" disabled={!rows.length} onClick={() => copy(rows.map((row) => row.price).join('\n'), '가격 복사 완료')}>가격 복사</button>
          </div>
        </section>

        <section className="card product-capture-reference-panel">
          <h3>수집 결과</h3>
          <div className="table-wrap product-capture-result-wrap">
            <table className="table product-capture-result-table">
              <thead><tr><th>상품명</th><th>옵션명</th><th>가격</th></tr></thead>
              <tbody>{rows.length ? rows.map((row, index) => <tr key={`${row.sequence}-${index}`}><td><input value={row.productName} onChange={(event) => updateRow(index, { productName: event.target.value })} /></td><td><input value={row.option} onChange={(event) => updateRow(index, { option: event.target.value })} /></td><td><input value={row.price} onChange={(event) => updateRow(index, { price: event.target.value })} /></td></tr>) : <tr><td colSpan="3" className="empty-cell">Shopee 또는 네이버 수집 JSON을 붙여넣으세요.</td></tr>}</tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="product-capture-image-sections">
        <ImageSection title="메인 사진" items={mainImages} empty="수집된 메인 사진이 없습니다" downloading={downloading} onAll={() => downloadImages(mainImages, 'main')} onOne={(item) => downloadImages([item], 'main')} />
        <ImageSection title="옵션 사진" items={rows} empty="수집된 옵션이 없습니다" downloading={downloading} onAll={() => downloadImages(rows, 'option')} onOne={(item) => downloadImages([item], 'option')} />
        {product?.source === 'naver' && <>
          <ImageSection className="naver-detail-panel" title="상세 사진" items={detailImages} empty="수집된 상세 사진이 없습니다" downloading={downloading} onAll={() => downloadImages(detailImages, 'detail')} onOne={(item) => downloadImages([item], 'detail')} />
          <VideoSection items={detailVideos} downloading={downloading} onAll={() => downloadVideos(detailVideos)} onOne={(item) => downloadVideos([item])} />
        </>}
      </div>
      {error && <div className="alert product-capture-status">{error}</div>}
      {message && <div className="notice product-capture-status">{message}</div>}
    </section>
  );
}

function ImageSection({ className = '', title, items, empty, downloading, onAll, onOne }) {
  const hasDownload = items.some((item) => item.url || item.optionImage);
  return <section className={`card product-capture-image-panel ${className}`}><div className="product-capture-image-header"><h3>{title}</h3><button className="action-btn" type="button" disabled={downloading || !hasDownload} onClick={onAll}>{title} 전체 다운로드</button></div>{items.length ? <div className="product-capture-image-grid">{items.map((item, index) => { const url = item.url || item.optionImage; const label = title === '옵션 사진' ? `${item.sequence}. ${item.option}` : `${title} ${item.sequence}`; return <article className="product-capture-image-card" key={`${item.sequence}-${url || index}`}><div className="product-capture-image-label" title={label}>{label}</div>{url ? <img src={url} alt={label} loading="lazy" referrerPolicy="no-referrer" /> : <div className="product-capture-no-image">사진 없음</div>}<button className="action-btn" type="button" disabled={downloading || !url} onClick={() => onOne(item)}>개별 다운로드</button></article>; })}</div> : <p className="product-capture-image-empty">{empty}</p>}</section>;
}

function VideoSection({ items, downloading, onAll, onOne }) {
  return <section className="card naver-detail-panel"><div className="product-capture-image-header"><h3>상세 동영상</h3><button className="action-btn" type="button" disabled={downloading || !items.length} onClick={onAll}>상세 동영상 전체 다운로드</button></div>{items.length ? <div className="product-capture-image-grid">{items.map((item) => <article className="product-capture-image-card" key={item.vid}><div className="product-capture-image-label">상세 동영상 {item.sequence}</div>{item.thumbnail ? <img src={item.thumbnail} alt={`상세 동영상 ${item.sequence}`} loading="lazy" referrerPolicy="no-referrer" /> : <div className="product-capture-no-image">미리보기 없음</div>}<button className="action-btn" type="button" disabled={downloading} onClick={() => onOne(item)}>MP4 다운로드</button></article>)}</div> : <p className="product-capture-image-empty">수집된 상세 동영상이 없습니다</p>}</section>;
}
