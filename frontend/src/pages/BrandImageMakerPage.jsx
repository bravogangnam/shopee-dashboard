import { useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_KEY = 'brand_image_maker_v1';
const DEFAULT_TEMPLATE = {
  top: 5,
  left: 10,
  width: 80,
  height: 16,
  color: '#ffffff',
  fontFamily: 'Arial, sans-serif',
  fontWeight: 800,
  minFontSize: 12,
  maxFontSize: 220,
  shadow: true,
};

function loadStoredSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      pasteText: String(saved.pasteText || ''),
      template: { ...DEFAULT_TEMPLATE, ...(saved.template || {}) },
    };
  } catch {
    return { pasteText: '', template: DEFAULT_TEMPLATE };
  }
}

function normalizeSku(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function skuFromFilename(filename) {
  const stem = String(filename || '')
    .replace(/\.[^.]+$/, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/(?:[-_\s]+C)$/i, '')
    .trim();
  return normalizeSku(stem);
}

function parseSkuBrandText(text) {
  const map = new Map();
  const conflicts = new Set();
  const rows = String(text || '').split(/\r?\n/).map(line => line.split('\t')).filter(parts => parts.some(value => value.trim()));

  for (const parts of rows) {
    const skuIndex = parts.findIndex(value => /^[A-Za-z]{1,6}[_-]?\d{3,}$/i.test(String(value || '').trim()));
    if (skuIndex < 0) continue;
    const sku = normalizeSku(parts[skuIndex]);
    const brand = String(parts[skuIndex + 1] || '').trim();
    if (!brand || /^(브랜드|brand)$/i.test(brand)) continue;
    if (map.has(sku) && map.get(sku) !== brand) conflicts.add(sku);
    if (!map.has(sku)) map.set(sku, brand);
  }

  return { map, conflicts, rowCount: rows.length };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));
    image.src = url;
  });
}

function fitFontSize(context, text, maxWidth, maxHeight, template) {
  let low = Math.max(1, Number(template.minFontSize) || 12);
  let high = Math.max(low, Math.min(Number(template.maxFontSize) || 220, maxHeight));
  let best = low;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    context.font = `${template.fontWeight} ${size}px ${template.fontFamily}`;
    if (context.measureText(text).width <= maxWidth && size <= maxHeight) {
      best = size;
      low = size + 1;
    } else {
      high = size - 1;
    }
  }
  return best;
}

async function drawComposite(canvas, imageUrl, brand, template) {
  const image = await loadImage(imageUrl);
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  if (!brand) return;

  const boxX = canvas.width * Number(template.left) / 100;
  const boxY = canvas.height * Number(template.top) / 100;
  const boxWidth = canvas.width * Number(template.width) / 100;
  const boxHeight = canvas.height * Number(template.height) / 100;
  const fontSize = fitFontSize(context, brand, boxWidth, boxHeight, template);
  context.font = `${template.fontWeight} ${fontSize}px ${template.fontFamily}`;
  context.fillStyle = template.color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  if (template.shadow) {
    context.shadowColor = 'rgba(0, 0, 0, .55)';
    context.shadowBlur = Math.max(2, fontSize * 0.08);
    context.shadowOffsetY = Math.max(1, fontSize * 0.035);
  }
  context.fillText(brand, boxX + boxWidth / 2, boxY + boxHeight / 2, boxWidth);
}

function extensionFor(file) {
  if (file.type === 'image/jpeg') return 'jpg';
  if (file.type === 'image/webp') return 'webp';
  return 'png';
}

function outputMime(file) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/png';
}

function CompositePreview({ item, template, canvasRef }) {
  const localRef = useRef(null);
  useEffect(() => {
    const canvas = localRef.current;
    if (!canvas) return;
    let active = true;
    drawComposite(canvas, item.url, item.brand, template).catch(() => {
      if (active) canvas.dataset.failed = 'true';
    });
    return () => { active = false; };
  }, [item.url, item.brand, template]);

  return <canvas ref={(node) => { localRef.current = node; canvasRef?.(node); }} aria-label={`${item.filename} 합성 미리보기`} />;
}

export default function BrandImageMakerPage() {
  const stored = useMemo(loadStoredSettings, []);
  const [pasteText, setPasteText] = useState(stored.pasteText);
  const [template, setTemplate] = useState(stored.template);
  const [images, setImages] = useState([]);
  const [manualBrands, setManualBrands] = useState({});
  const [message, setMessage] = useState('');
  const [downloading, setDownloading] = useState(false);
  const canvasMap = useRef(new Map());
  const parsed = useMemo(() => parseSkuBrandText(pasteText), [pasteText]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ pasteText, template }));
  }, [pasteText, template]);

  useEffect(() => () => images.forEach(item => URL.revokeObjectURL(item.url)), [images]);

  const matchedImages = useMemo(() => images.map(item => {
    const automaticBrand = parsed.conflicts.has(item.sku) ? '' : (parsed.map.get(item.sku) || '');
    return {
      ...item,
      brand: manualBrands[item.id] ?? automaticBrand,
      conflict: parsed.conflicts.has(item.sku),
      matched: Boolean(manualBrands[item.id] ?? automaticBrand),
    };
  }), [images, parsed, manualBrands]);

  const matchedCount = matchedImages.filter(item => item.matched).length;

  function updateTemplate(field, value) {
    setTemplate(current => ({ ...current, [field]: value }));
  }

  function handleFiles(event) {
    const files = Array.from(event.target.files || []).filter(file => file.type.startsWith('image/'));
    images.forEach(item => URL.revokeObjectURL(item.url));
    canvasMap.current.clear();
    setManualBrands({});
    setImages(files.map((file, index) => ({
      id: `${file.name}-${file.lastModified}-${index}`,
      file,
      filename: file.name,
      sku: skuFromFilename(file.name),
      url: URL.createObjectURL(file),
    })));
    setMessage(files.length ? `이미지 ${files.length.toLocaleString('ko-KR')}장을 불러왔습니다.` : '');
    event.target.value = '';
  }

  function canvasBlob(canvas, file) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('이미지 생성 실패')), outputMime(file), file.type === 'image/jpeg' ? 0.95 : undefined);
    });
  }

  async function downloadItem(item) {
    if (!item.matched) return;
    const canvas = canvasMap.current.get(item.id);
    if (!canvas) throw new Error(`${item.filename}: 미리보기가 준비되지 않았습니다.`);
    await drawComposite(canvas, item.url, item.brand, template);
    const blob = await canvasBlob(canvas, item.file);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${item.filename.replace(/\.[^.]+$/, '')}.${extensionFor(item.file)}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function downloadAll() {
    const targets = matchedImages.filter(item => item.matched);
    if (!targets.length) return;
    setDownloading(true);
    let failed = 0;
    for (const item of targets) {
      try { await downloadItem(item); }
      catch { failed += 1; }
      await new Promise(resolve => window.setTimeout(resolve, 220));
    }
    setDownloading(false);
    setMessage(failed ? `${targets.length - failed}장 다운로드 완료 · ${failed}장 실패` : `${targets.length}장 다운로드를 시작했습니다.`);
  }

  function resetAll() {
    images.forEach(item => URL.revokeObjectURL(item.url));
    canvasMap.current.clear();
    localStorage.removeItem(STORAGE_KEY);
    setPasteText('');
    setTemplate(DEFAULT_TEMPLATE);
    setImages([]);
    setManualBrands({});
    setMessage('전체 초기화 완료');
  }

  return (
    <section className="page brand-image-maker-page">
      <div className="page-header">
        <div>
          <span className="brand-maker-eyebrow">IMAGE TOOL</span>
          <h1>브랜드 이미지 제작</h1>
          <p>메인 이미지 파일명의 SKU와 마진차트 브랜드를 연결해 정해진 틀에 자동 합성합니다.</p>
        </div>
        <button type="button" className="ghost-button" onClick={resetAll}>전체 초기화</button>
      </div>

      <div className="brand-maker-privacy">
        <strong>이미지는 서버에 전송하거나 저장하지 않습니다.</strong>
        <span>업로드·합성·다운로드가 모두 현재 브라우저 안에서만 처리됩니다.</span>
      </div>

      <div className="brand-maker-setup">
        <section className="brand-maker-card">
          <div className="brand-maker-card-head">
            <div><span>1</span><div><h2>SKU·브랜드 붙여넣기</h2><p>마진차트에서 SKU와 브랜드 열을 그대로 복사하세요.</p></div></div>
            <b>{parsed.map.size.toLocaleString('ko-KR')}개 SKU</b>
          </div>
          <textarea value={pasteText} onChange={event => setPasteText(event.target.value)} placeholder={'JK00335\tDIAR\nJK00336\tDIAR'} />
          {parsed.conflicts.size > 0 && <p className="brand-maker-warning">브랜드가 서로 다른 중복 SKU {parsed.conflicts.size}개는 자동 연결하지 않습니다.</p>}
        </section>

        <section className="brand-maker-card">
          <div className="brand-maker-card-head">
            <div><span>2</span><div><h2>메인 이미지 업로드</h2><p>예: JK00335-c.png · 여러 장을 한 번에 선택할 수 있습니다.</p></div></div>
            <b>{images.length.toLocaleString('ko-KR')}장</b>
          </div>
          <label className="brand-maker-dropzone">
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={handleFiles} />
            <strong>이미지 선택</strong>
            <span>PNG · JPG · WebP</span>
          </label>
        </section>
      </div>

      <section className="brand-maker-card brand-maker-template-card">
        <div className="brand-maker-card-head">
          <div><span>3</span><div><h2>브랜드 틀 설정</h2><p>브랜드명은 지정한 영역을 넘지 않는 가장 큰 한 줄 글자로 들어갑니다.</p></div></div>
          <button type="button" className="ghost-button" onClick={() => setTemplate(DEFAULT_TEMPLATE)}>기본값</button>
        </div>
        <div className="brand-maker-controls">
          <label>위쪽 위치 (%)<input type="number" min="0" max="90" value={template.top} onChange={e => updateTemplate('top', e.target.value)} /></label>
          <label>왼쪽 위치 (%)<input type="number" min="0" max="90" value={template.left} onChange={e => updateTemplate('left', e.target.value)} /></label>
          <label>틀 너비 (%)<input type="number" min="10" max="100" value={template.width} onChange={e => updateTemplate('width', e.target.value)} /></label>
          <label>틀 높이 (%)<input type="number" min="5" max="50" value={template.height} onChange={e => updateTemplate('height', e.target.value)} /></label>
          <label>글자 색상<input type="color" value={template.color} onChange={e => updateTemplate('color', e.target.value)} /></label>
          <label>글자 굵기<select value={template.fontWeight} onChange={e => updateTemplate('fontWeight', e.target.value)}><option value="600">보통</option><option value="700">굵게</option><option value="800">매우 굵게</option><option value="900">최대 굵게</option></select></label>
          <label className="brand-maker-check"><input type="checkbox" checked={template.shadow} onChange={e => updateTemplate('shadow', e.target.checked)} />그림자 사용</label>
        </div>
      </section>

      <section className="brand-maker-results">
        <div className="brand-maker-results-head">
          <div><h2>합성 결과</h2><p>연결 완료 {matchedCount}장 · 연결 필요 {images.length - matchedCount}장</p></div>
          <button type="button" className="action-btn primary" onClick={downloadAll} disabled={!matchedCount || downloading}>{downloading ? '다운로드 중' : '연결된 이미지 전체 다운로드'}</button>
        </div>
        {matchedImages.length ? (
          <div className="brand-maker-grid">
            {matchedImages.map(item => (
              <article className={`brand-maker-result ${item.matched ? 'matched' : 'unmatched'}`} key={item.id}>
                <div className="brand-maker-canvas-wrap">
                  <CompositePreview item={item} template={template} canvasRef={node => node ? canvasMap.current.set(item.id, node) : canvasMap.current.delete(item.id)} />
                </div>
                <div className="brand-maker-result-info">
                  <div><strong>{item.sku || 'SKU 인식 실패'}</strong><span>{item.filename}</span></div>
                  <span className={`brand-maker-status ${item.matched ? 'ok' : ''}`}>{item.matched ? '연결 완료' : item.conflict ? '중복 확인 필요' : '브랜드 없음'}</span>
                </div>
                <label>브랜드명<input value={item.brand} onChange={event => setManualBrands(current => ({ ...current, [item.id]: event.target.value }))} placeholder="직접 입력 가능" /></label>
                <button type="button" className="ghost-button" disabled={!item.matched} onClick={() => downloadItem(item)}>개별 다운로드</button>
              </article>
            ))}
          </div>
        ) : <div className="brand-maker-empty">SKU·브랜드를 붙여넣고 메인 이미지를 업로드하세요.</div>}
      </section>
      {message && <div className="notice brand-maker-message">{message}</div>}
    </section>
  );
}
