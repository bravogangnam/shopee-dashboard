import { useMemo, useState } from 'react';
import { normalizeClipboardText } from '../utils/clipboard.js';
import { getStoredToken } from '../api/client.js';

const STORAGE_KEY = 'product_capture_v1';

// Keep this self-contained: it runs in the Shopee product page, not in our React app.
const BOOKMARKLET_CODE = String.raw`javascript:(async()=>{const c=s=>String(s||"").replace(/\s+/g," ").trim(),g=(o,k)=>{try{return o&&typeof o==="object"?o[k]:void 0}catch(e){return void 0}},fmt=r=>{if(r==null||r==="")return"";const n=Number(r);if(!Number.isFinite(n))return String(r);if(n>=100000)return(n/100000).toFixed(2);if(n>=1000)return(n/100).toFixed(2);return n.toFixed(2)},parseIds=()=>{const m=location.href.match(/i\.(\d+)\.(\d+)/);return m?{shop:m[1],item:m[2]}:{shop:"",item:""}},ids=parseIds(),region=()=>{const h=location.hostname.toLowerCase(),m=h.match(/shopee\.([a-z.]+)$/);return({"co.id":"id","com.br":"br","com.mx":"mx","com.co":"co","cl":"cl","sg":"sg","com.my":"my","ph":"ph","vn":"vn","co.th":"th","tw":"tw"})[m?.[1]]||"sg"},img=v=>{if(v&&typeof v==="object")v=g(v,"url")||g(v,"image_url")||g(v,"imageUrl")||g(v,"image")||g(v,"image_id")||g(v,"imageId")||"";v=c(v);if(!v)return"";if(v.startsWith("//"))v="https:"+v;if(/^https?:\/\//i.test(v)){try{const u=new URL(v);u.pathname=u.pathname.replace(/_tn(?=\.|$)/," ").trim();return u.toString()}catch(e){return v.replace(/_tn(?=\.|$)/,"")}}return/^[-_a-zA-Z0-9]{12,}$/.test(v)?"https://down-"+region()+".img.susercontent.com/file/"+v.replace(/_tn$/,""):""},imgs=o=>g(o,"images")||g(o,"image_list")||g(o,"imageList")||g(g(o,"item"),"images")||g(g(o,"item"),"image_list")||[],title=()=>c(document.querySelector("h1")?.innerText)||c(document.title.replace(/\|.*Shopee.*/i,"")),sid=o=>String(g(o,"shopid")||g(o,"shop_id")||g(o,"shopId")||g(g(o,"item"),"shopid")||g(g(o,"item"),"shop_id")||g(g(o,"basic"),"shopid")||""),iid=o=>String(g(o,"itemid")||g(o,"item_id")||g(o,"itemId")||g(g(o,"item"),"itemid")||g(g(o,"item"),"item_id")||g(g(o,"basic"),"itemid")||""),tiers=o=>g(o,"tier_variations")||g(o,"tierVariations")||g(o,"tier_variation")||g(o,"tierVariation")||g(g(o,"item"),"tier_variations")||g(g(o,"item"),"tierVariations")||[],models=o=>g(o,"models")||g(o,"model_list")||g(o,"modelList")||g(g(o,"item"),"models")||g(g(o,"item"),"model_list")||[],idx=m=>g(m,"tier_index")||g(m,"tierIndex")||g(g(m,"extinfo"),"tier_index")||g(g(m,"extinfo"),"tierIndex")||g(g(m,"ext_info"),"tier_index")||[],price=m=>g(m,"price")??g(g(m,"price_stocks")?.[0],"price")??g(g(m,"priceStocks")?.[0],"price")??g(m,"price_min")??g(m,"priceMin")??"",opt=o=>{if(o==null)return"";if(typeof o==="string")return c(o);return c(g(o,"name")||g(o,"option")||g(o,"value")||g(o,"display_name")||g(o,"displayName")||g(o,"label")||g(o,"text")||"")},seen=new WeakSet(),cand=[];function scan(o,path,d){try{if(!o||typeof o!=="object"||seen.has(o))return;seen.add(o);const ms=models(o),ts=tiers(o);if(Array.isArray(ms)&&ms.length&&(!ids.item||!iid(o)||iid(o)===ids.item)&&(!ids.shop||!sid(o)||sid(o)===ids.shop)){const exact=(ids.item&&iid(o)===ids.item)||(ids.item&&path.includes(ids.item));cand.push({o,path,ts:Array.isArray(ts)?ts:[],ms,exact:exact?1:0,priced:ms.filter(x=>price(x)!=="").length});}if(d<=0)return;for(const k of Object.keys(o).slice(0,900)){const v=g(o,k);if(v&&typeof v==="object")scan(v,path+"."+k,d-1)}}catch(e){}}if(!ids.item){alert("현재 URL에서 Shopee item_id를 찾지 못했습니다. 상품 URL을 확인하세요.");return}try{scan(window.dataLayer,"window.dataLayer",14)}catch(e){}for(const s of Array.from(document.scripts)){const raw=s.textContent||"",cooked=c(raw),type=c(s.type||""),id=c(s.id||"");if(cooked&&(type.includes("json")||type.includes("shopee")||id.includes("NEXT")||id.includes("INITIAL")||cooked.startsWith("{")||cooked.startsWith("[")))try{scan(JSON.parse(raw),"script#"+(id||type||"no-id"),14)}catch(e){}}const best=cand.filter(x=>x.exact).sort((a,b)=>b.priced-a.priced||b.ms.length-a.ms.length)[0];if(!best){alert("현재 상품과 일치하는 모델 데이터를 찾지 못했습니다. 페이지가 완전히 로딩된 뒤 다시 실행하세요.");return}const pn=title(),main=[...new Set([...(Array.isArray(imgs(best.o))?imgs(best.o):[]),g(best.o,"image"),g(best.o,"image_id"),g(g(best.o,"item"),"image")].map(img).filter(Boolean))].map(url=>({url})),rows=best.ms.map(m=>{const ix=idx(m),parts=[],optionObjects=[];if(Array.isArray(ix)&&ix.length&&best.ts.length)ix.forEach((v,i)=>{const group=best.ts[i]||{},os=g(group,"options")||g(group,"values")||g(group,"option_list")||[],o=os[v];optionObjects.push(o);const n=opt(o);if(n)parts.push(n)});let on=parts.length?parts.join(" / "):c(g(m,"name")||g(m,"model_name")||g(m,"modelName")||"");if(!on||on===pn)on="-";const oi=[g(m,"image"),g(m,"image_url"),g(m,"image_id"),...optionObjects.map(o=>g(o,"image")||g(o,"image_url")||g(o,"image_id"))].map(img).find(Boolean)||"";return{optionName:on,price:fmt(price(m)),optionImage:oi,_idx:Array.isArray(ix)?ix:[]}}).sort((a,b)=>a._idx.map(v=>String(v).padStart(4,"0")).join("-").localeCompare(b._idx.map(v=>String(v).padStart(4,"0")).join("-"),void 0,{numeric:true})).map(({_idx,...r})=>r),payload={productName:pn,mainImages:main,rows},text=JSON.stringify(payload,null,2),fb=()=>{const ta=document.createElement("textarea");ta.value=text;Object.assign(ta.style,{position:"fixed",left:"20px",top:"20px",width:"700px",height:"400px",zIndex:"999999"});document.body.appendChild(ta);ta.focus();ta.select();document.execCommand("copy");alert("복사창이 열렸습니다. Ctrl+C 후 붙여넣기 해보세요.")};try{await navigator.clipboard.writeText(text);alert("Shopee 상품수집 복사 완료: "+rows.length+"행, 메인 사진 "+main.length+"장")}catch(e){fb()}})();`;

// Tier variation images are commonly stored as a parallel `images` array rather
// than on each option object. Patch both representations into the compact script.
const BOOKMARKLET_CODE_WITH_IMAGES = BOOKMARKLET_CODE
  .replace('u.pathname=u.pathname.replace(/_tn(?=\\.|$)/," ").trim()', 'u.pathname=u.pathname.replace(/_tn(?=\\.|$)/,"")')
  .replace('parts=[],optionObjects=[];', 'parts=[],optionObjects=[],optionPictures=[];')
  .replace('optionObjects.push(o);const n=opt(o)', 'optionObjects.push(o);optionPictures.push((Array.isArray(imgs(group))?imgs(group):[])[v]);const n=opt(o)')
  .replace('...optionObjects.map(o=>', '...optionPictures,...optionObjects.map(o=>');

const BOOKMARKLET_CODE_READY = BOOKMARKLET_CODE_WITH_IMAGES
  .replace('if(n>=100000)return(n/100000).toFixed(2);if(n>=1000)return(n/100).toFixed(2)', 'if(n>=1000)return(n/100000).toFixed(2)')
  .replace(
    'javascript:(async()=>{const c=',
    'javascript:(async()=>{const toast=(m,b=false)=>{const e=document.createElement("div");e.textContent=m;Object.assign(e.style,{position:"fixed",top:"20px",right:"20px",maxWidth:"420px",padding:"14px 18px",borderRadius:"10px",background:b?"#b91c1c":"#166534",color:"white",fontSize:"14px",fontWeight:"700",lineHeight:"1.5",boxShadow:"0 12px 30px rgba(0,0,0,.28)",zIndex:"2147483647",transition:"opacity .3s"});document.body.appendChild(e);setTimeout(()=>{e.style.opacity="0";setTimeout(()=>e.remove(),300)},4000)},c=',
  )
  .replace('alert("현재 URL에서 Shopee item_id를 찾지 못했습니다. 상품 URL을 확인하세요.")', 'toast("현재 URL에서 Shopee item_id를 찾지 못했습니다. 상품 URL을 확인하세요.",true)')
  .replace('alert("현재 상품과 일치하는 모델 데이터를 찾지 못했습니다. 페이지가 완전히 로딩된 뒤 다시 실행하세요.")', 'toast("현재 상품과 일치하는 모델 데이터를 찾지 못했습니다. 페이지가 완전히 로딩된 뒤 다시 실행하세요.",true)')
  .replace('alert("복사창이 열렸습니다. Ctrl+C 후 붙여넣기 해보세요.")', 'toast("자동 복사에 실패했습니다. 열린 복사창에서 Ctrl+C를 눌러주세요.",true)')
  .replace('alert("Shopee 상품수집 복사 완료: "+rows.length+"행, 메인 사진 "+main.length+"장")', 'toast("상품수집 완료 · 옵션 "+rows.length+"개 · 메인 사진 "+main.length+"장")');

const cleanUrl = (value) => (typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : '');

function normalizeStoredState(raw) {
  const products = Array.isArray(raw?.products) ? raw.products : [];
  return {
    products: products.map((product, productIndex) => ({
      id: product.id || `P${String(productIndex + 1).padStart(4, '0')}`,
      name: String(product.name || ''),
      mainImages: [...new Set((Array.isArray(product.mainImages) ? product.mainImages : []).map((item) => cleanUrl(item?.url || item)).filter(Boolean))].map((url) => ({ url })),
      rows: (Array.isArray(product.rows) ? product.rows : []).map((row) => ({
        option: String(row.option || '-'),
        price: String(row.price ?? row.prices?.SG ?? Object.values(row.prices || {})[0] ?? ''),
        optionImage: cleanUrl(row.optionImage),
      })),
    })),
    next: Number(raw?.next || products.length + 1) || 1,
  };
}

function loadState() {
  try { return normalizeStoredState(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); }
  catch { return normalizeStoredState({}); }
}

function parseCapture(text) {
  const parsed = JSON.parse(text);
  const legacy = Array.isArray(parsed);
  const rows = legacy ? parsed : parsed?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('상품 행이 없는 JSON입니다.');
  const productName = legacy ? rows[0]?.['상품명'] : (parsed.productName ?? rows[0]?.['상품명']);
  const normalizedRows = rows.map((row) => {
    const option = legacy ? row['옵션명'] : (row.optionName ?? row.option ?? row['옵션명']);
    const price = legacy ? row['수집가격'] : (row.price ?? row['수집가격']);
    if (option == null) throw new Error('옵션명 누락');
    if (price == null) throw new Error('수집가격 누락');
    return { option: String(option || '-'), price: String(price), optionImage: cleanUrl(row.optionImage) };
  });
  return {
    name: String(productName || ''),
    mainImages: [...new Set((Array.isArray(parsed?.mainImages) ? parsed.mainImages : []).map((item) => cleanUrl(item?.url || item)).filter(Boolean))].map((url) => ({ url })),
    rows: normalizedRows,
  };
}

function safeStem(value, fallback) {
  const stem = String(value || '').normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 48);
  return stem || fallback;
}

function orderedOptionRows(products) {
  let sequence = 0;
  return products.flatMap((product) => product.rows.map((row) => ({
    ...row,
    productName: product.name,
    sequence: ++sequence,
  })));
}

export default function ProductCapturePage() {
  const [state, setState] = useState(loadState);
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [downloading, setDownloading] = useState(false);

  const tableRows = useMemo(() => state.products.flatMap((product) => product.rows.map((row, idx) => ({ id: `${product.id}-${idx}`, productId: product.id, rowIndex: idx, productName: product.name, ...row, isFirst: idx === 0 }))), [state.products]);
  const mainImages = useMemo(() => state.products.flatMap((product) => product.mainImages), [state.products]);
  const optionImages = useMemo(() => orderedOptionRows(state.products), [state.products]);

  function persist(nextState) {
    const normalized = normalizeStoredState(nextState);
    setState(normalized);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }

  function applyCapture(capture) {
    const existingId = state.products[0]?.id;
    const id = existingId || `P${String(state.next).padStart(4, '0')}`;
    persist({ products: [{ id, ...capture }], next: existingId ? state.next : state.next + 1 });
    setError('');
    setMessage('붙여넣기 자동 적용 완료');
  }

  function handlePasteTextChange(value) {
    setPasteText(value);
    const text = value.trim();
    if (!text) {
      persist({ products: [], next: 1 });
      setError(''); setMessage('');
      return;
    }
    try { applyCapture(parseCapture(text)); }
    catch (e) {
      if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
        setError(`붙여넣기 오류: ${e.message}`); setMessage('');
      }
    }
  }

  function resetAll() {
    localStorage.removeItem(STORAGE_KEY);
    setState(normalizeStoredState({})); setPasteText(''); setError(''); setMessage('');
  }

  function updateProductName(productId, value) { persist({ ...state, products: state.products.map((p) => p.id === productId ? { ...p, name: value } : p) }); }
  function updateRow(productId, rowIndex, patch) { persist({ ...state, products: state.products.map((p) => p.id === productId ? { ...p, rows: p.rows.map((r, i) => i === rowIndex ? { ...r, ...patch } : r) } : p) }); }

  async function copyToClipboard(text, success) {
    try { await navigator.clipboard.writeText(normalizeClipboardText(text)); setMessage(success); setError(''); }
    catch { setError('복사에 실패했습니다. HTTPS 환경인지 확인하거나 직접 선택해서 복사하세요.'); }
  }

  function copyNamesAndOptions() { copyToClipboard(state.products.flatMap((p) => p.rows.map((r) => r.option && r.option !== '-' ? `${p.name}\t${r.option}` : p.name)).join('\n'), '상품명+옵션명 복사 완료'); }
  function copyPrices() { copyToClipboard(state.products.flatMap((p) => p.rows.map((r) => r.price || '')).join('\n'), '가격 복사 완료'); }

  async function downloadImage(item, fallbackName) {
    const token = getStoredToken();
    const response = await fetch(`/api/product-capture/image-download?url=${encodeURIComponent(item.url || item.optionImage)}&name=${encodeURIComponent(fallbackName)}`, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `HTTP ${response.status}`); }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const filename = encoded ? decodeURIComponent(encoded) : fallbackName;
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  async function downloadMany(items, kind) {
    setDownloading(true); setError(''); setMessage('');
    const failures = [];
    const usedNames = new Map();
    const seenUrls = new Set();
    const downloadableItems = items.filter((item) => {
      const url = item.url || item.optionImage;
      if (!url || (kind === 'option' && seenUrls.has(url))) return false;
      seenUrls.add(url);
      return true;
    });
    for (let index = 0; index < downloadableItems.length; index += 1) {
      const item = downloadableItems[index];
      const optionNumber = String(item.sequence || index + 1).padStart(2, '0');
      const base = kind === 'main' ? `main_${String(index + 1).padStart(2, '0')}` : `option_${optionNumber}_${safeStem(item.option, '사진')}`;
      const count = (usedNames.get(base) || 0) + 1; usedNames.set(base, count);
      const name = count === 1 ? base : `${base}_${count}`;
      try { await downloadImage(item, name); }
      catch (e) { failures.push(`${kind === 'main' ? `메인 ${index + 1}` : item.option}: ${e.message}`); }
    }
    setDownloading(false);
    if (failures.length) setError(`${failures.length}개 이미지 다운로드 실패: ${failures.join(' / ')}`);
    setMessage(`${downloadableItems.length - failures.length}개 이미지 다운로드 완료${failures.length ? `, ${failures.length}개 실패` : ''}`);
  }

  return (
    <section className="page product-capture-page">
      <div className="page-header"><div><h1>상품 수집</h1><p>Shopee 상품명, 옵션명, 가격과 상품 사진을 수집해 정리합니다.</p></div></div>
      <div className="card product-capture-bookmarklet-panel"><h3>북마클릿 안내</h3><p>아래 링크를 <strong>북마크바로 드래그해서 등록</strong>하세요.</p><div className="bookmarklet-actions"><button type="button" className="action-btn" onClick={() => navigator.clipboard.writeText(BOOKMARKLET_CODE_READY)}>북마클릿 코드 복사</button><a className="action-btn" href={BOOKMARKLET_CODE_READY} onClick={(e) => e.preventDefault()}>Shopee 상품수집 (드래그 등록용)</a></div></div>
      <div className="product-capture-workspace">
        <section className="card product-capture-paste-panel"><h3>상품정보 붙여넣기</h3><textarea rows={3} value={pasteText} onChange={(e) => handlePasteTextChange(e.target.value)} placeholder="북마클릿 JSON을 붙여넣으세요. 붙여넣으면 자동 적용됩니다." /><div className="product-capture-paste-actions"><button type="button" className="action-btn" onClick={resetAll}>전체 초기화</button><button type="button" className="action-btn" onClick={copyNamesAndOptions} disabled={!tableRows.length}>상품명+옵션명 복사</button><button type="button" className="action-btn" onClick={copyPrices} disabled={!tableRows.length}>가격 복사</button></div></section>
        <section className="card product-capture-reference-panel"><h3>수집 결과</h3><div className="table-wrap product-capture-result-wrap"><table className="table product-capture-result-table"><colgroup><col className="product-capture-name-col" /><col className="product-capture-option-col" /><col className="product-capture-price-col" /></colgroup><thead><tr><th>상품명</th><th>옵션명</th><th>가격</th></tr></thead><tbody>{tableRows.length ? tableRows.map((row) => <tr key={row.id}><td>{row.isFirst ? <input value={row.productName} onChange={(e) => updateProductName(row.productId, e.target.value)} /> : ''}</td><td><input value={row.option} onChange={(e) => updateRow(row.productId, row.rowIndex, { option: e.target.value })} /></td><td><input value={row.price} onChange={(e) => updateRow(row.productId, row.rowIndex, { price: e.target.value })} /></td></tr>) : <tr><td colSpan="3" className="empty-cell">북마클릿 JSON을 붙여넣으면 수집 결과가 표시됩니다.</td></tr>}</tbody></table></div></section>
      </div>
      <div className="product-capture-image-sections">
        <ImageSection title="메인 사진" empty="수집된 메인 사진이 없습니다" items={mainImages} downloading={downloading} onAll={() => downloadMany(mainImages, 'main')} renderLabel={(_, i) => `메인 사진 ${i + 1}`} onOne={(item, i) => downloadMany([item], 'main')} />
        <ImageSection title="옵션 사진" empty="수집된 옵션이 없습니다" items={optionImages} downloading={downloading} onAll={() => downloadMany(optionImages, 'option')} renderLabel={(item) => `${item.sequence}. ${item.option}`} onOne={(item) => downloadMany([item], 'option')} />
      </div>
      {error && <div className="alert product-capture-status">{error}</div>}
      {message && <div className="notice product-capture-status">{message}</div>}
    </section>
  );
}

function ImageSection({ title, empty, items, downloading, onAll, onOne, renderLabel }) {
  const downloadableCount = items.filter((item) => item.url || item.optionImage).length;
  return <section className="card product-capture-image-panel"><div className="product-capture-image-header"><h3>{title}</h3><button type="button" className="action-btn" disabled={!downloadableCount || downloading} onClick={onAll}>{title} 전체 다운로드</button></div>{items.length ? <div className="product-capture-image-grid">{items.map((item, index) => { const url = item.url || item.optionImage; const label = renderLabel(item, index); return <article className="product-capture-image-card" key={`${item.sequence || index}-${url || 'no-image'}`}><div className="product-capture-image-label" title={label}>{label}</div>{url ? <img src={url} alt={label} loading="lazy" referrerPolicy="no-referrer" /> : <div className="product-capture-no-image">사진 없음</div>}<button type="button" className="action-btn" disabled={!url || downloading} onClick={() => onOne(item, index)}>개별 다운로드</button></article>; })}</div> : <p className="product-capture-image-empty">{empty}</p>}</section>;
}
