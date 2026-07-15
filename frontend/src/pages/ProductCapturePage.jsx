import { useMemo, useState } from 'react';

const STORAGE_KEY = 'product_capture_v1';

const BOOKMARKLET_CODE = String.raw`javascript:(async()=>{const c=s=>String(s||"").replace(/\s+/g," ").trim(),g=(o,k)=>{try{return o&&typeof o==="object"?o[k]:void 0}catch(e){return void 0}},fmt=r=>{if(r==null||r==="")return"";const n=Number(r);if(!Number.isFinite(n))return String(r);if(n>=100000)return(n/100000).toFixed(2);if(n>=1000)return(n/100).toFixed(2);return n.toFixed(2)},parseIds=()=>{const h=location.href;let m=h.match(/i\.(\d+)\.(\d+)/);if(m)return{shop:m[1],item:m[2]};return{shop:"",item:""}},ids=parseIds(),title=()=>c(document.querySelector("h1")?.innerText)||c(document.title.replace(/\|.*Shopee.*/i,"")),sid=o=>String(g(o,"shopid")||g(o,"shop_id")||g(o,"shopId")||g(g(o,"item"),"shopid")||g(g(o,"item"),"shop_id")||g(g(o,"basic"),"shopid")||""),iid=o=>String(g(o,"itemid")||g(o,"item_id")||g(o,"itemId")||g(g(o,"item"),"itemid")||g(g(o,"item"),"item_id")||g(g(o,"basic"),"itemid")||""),tiers=o=>g(o,"tier_variations")||g(o,"tierVariations")||g(o,"tier_variation")||g(o,"tierVariation")||g(g(o,"item"),"tier_variations")||g(g(o,"item"),"tierVariations")||[],models=o=>g(o,"models")||g(o,"model_list")||g(o,"modelList")||g(g(o,"item"),"models")||g(g(o,"item"),"model_list")||[],idx=m=>g(m,"tier_index")||g(m,"tierIndex")||g(g(m,"extinfo"),"tier_index")||g(g(m,"extinfo"),"tierIndex")||g(g(m,"ext_info"),"tier_index")||[],price=m=>g(m,"price")??g(g(m,"price_stocks")?.[0],"price")??g(g(m,"priceStocks")?.[0],"price")??g(m,"price_min")??g(m,"priceMin")??"",opt=o=>{if(o==null)return"";if(typeof o==="string")return c(o);if(typeof o==="object")return c(g(o,"name")||g(o,"option")||g(o,"value")||g(o,"display_name")||g(o,"displayName")||g(o,"label")||g(o,"text")||"");return c(o)},pathMatch=path=>ids.item&&path.includes(ids.item),objectMatch=o=>{const it=iid(o),sh=sid(o);if(ids.item&&it&&it!==ids.item)return false;if(ids.shop&&sh&&sh!==ids.shop)return false;return true},seen=new WeakSet(),cand=[];function scan(o,path,d){try{if(!o||typeof o!=="object"||seen.has(o))return;seen.add(o);const ms=models(o),ts=tiers(o),hasModels=Array.isArray(ms)&&ms.length>0;if(hasModels&&objectMatch(o)){const it=iid(o),sh=sid(o),exact=(ids.item&&it===ids.item)||(ids.item&&pathMatch(path));cand.push({path,ts:Array.isArray(ts)?ts:[],ms,it,sh,exact:exact?1:0,priced:ms.filter(x=>price(x)!=="").length,mc:ms.length,tc:Array.isArray(ts)?ts.length:0});return}if(d<=0)return;let ks=[];try{ks=Object.keys(o).slice(0,900)}catch(e){return}for(const k of ks){const v=g(o,k);if(v&&typeof v==="object")scan(v,path+"."+k,d-1)}}catch(e){}}if(!ids.item){alert("현재 URL에서 Shopee item_id를 찾지 못했습니다. 상품 URL에 i.shop_id.item_id 형식이 있는지 확인하세요.");return}try{if(window.dataLayer)scan(window.dataLayer,"window.dataLayer",14)}catch(e){}for(const s of Array.from(document.scripts)){const raw=s.textContent||"",txt=c(raw),type=c(s.type||""),id=c(s.id||"");if(!txt)continue;if(type.includes("json")||type.includes("shopee")||id.includes("NEXT")||id.includes("INITIAL")||txt.startsWith("{")||txt.startsWith("[")){try{scan(JSON.parse(raw),"script#"+(id||type||"no-id"),14)}catch(e){}}}const exact=cand.filter(x=>x.exact);const best=exact.sort((a,b)=>b.priced-a.priced||b.tc-a.tc||b.mc-a.mc)[0];if(!best){alert("현재 상품과 일치하는 모델 데이터를 찾지 못했습니다. 상품 페이지를 새로고침하고 완전히 로딩된 뒤 다시 실행하세요.");return}const pn=title(),rows=best.ms.map(m=>{const ix=idx(m);let parts=[];if(Array.isArray(ix)&&ix.length&&best.ts.length){parts=ix.map((v,i)=>{const group=best.ts[i]||{},os=g(group,"options")||g(group,"values")||g(group,"option_list")||[];return opt(os[v])}).filter(Boolean)}let on=parts.length?parts.join(" / "):c(g(m,"name")||g(m,"model_name")||g(m,"modelName")||"");if(!on||on===pn)on="-";return{상품명:pn,옵션명:on,수집가격:fmt(price(m)),_idx:Array.isArray(ix)?ix:[]}}).sort((a,b)=>a._idx.map(v=>String(v).padStart(4,"0")).join("-").localeCompare(b._idx.map(v=>String(v).padStart(4,"0")).join("-"),void 0,{numeric:true})).map(({_idx,...r})=>r);const text=JSON.stringify(rows,null,2),fb=()=>{const ta=document.createElement("textarea");ta.value=text;ta.style.position="fixed";ta.style.left="20px";ta.style.top="20px";ta.style.width="700px";ta.style.height="400px";ta.style.zIndex="999999";document.body.appendChild(ta);ta.focus();ta.select();document.execCommand("copy");alert("복사창이 열렸습니다. Ctrl+C 후 붙여넣기 해보세요.")};try{await navigator.clipboard.writeText(text);alert("Shopee 상품수집 복사 완료: "+rows.length+"행")}catch(e){fb()}})();`;

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"products":[],"next":1}');
  } catch {
    return { products: [], next: 1 };
  }
}

function normalizeStoredState(raw) {
  const products = Array.isArray(raw?.products) ? raw.products : [];
  return {
    products: products.map((product, productIndex) => ({
      id: product.id || `P${String(productIndex + 1).padStart(4, '0')}`,
      name: product.name || '',
      rows: Array.isArray(product.rows)
        ? product.rows.map((row) => ({
            option: String(row.option || '-'),
            price: String(row.price ?? row.prices?.SG ?? Object.values(row.prices || {})[0] ?? ''),
          }))
        : [],
    })),
    next: Number(raw?.next || products.length + 1) || 1,
  };
}

function buildProductFromRows(rows, id) {
  return {
    id,
    name: rows[0]?.['상품명'] || '',
    rows: rows.map((row) => ({
      option: String(row['옵션명'] || '-'),
      price: String(row['수집가격'] || ''),
    })),
  };
}


export default function ProductCapturePage() {
  const [state, setState] = useState(() => normalizeStoredState(loadState()));
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');

  const tableRows = useMemo(() => state.products.flatMap((product) => (
    product.rows.map((row, idx) => ({
      id: `${product.id}-${idx}`,
      productId: product.id,
      rowIndex: idx,
      productName: product.name,
      option: row.option,
      price: row.price,
      isFirst: idx === 0,
    }))
  )), [state.products]);

  function persist(nextState) {
    const normalized = normalizeStoredState(nextState);
    setState(normalized);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }

  function parseCaptureRows(text) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr) || !arr.length) throw new Error('JSON 배열이 아닙니다.');
    arr.forEach((row) => {
      if (!row['상품명'] && row['상품명'] !== '') throw new Error('상품명 누락');
      if (row['옵션명'] == null) throw new Error('옵션명 누락');
      if (row['수집가격'] == null) throw new Error('수집가격 누락');
    });
    return arr;
  }

  function applyCaptureRows(arr) {
    const existingId = state.products[0]?.id;
    const id = existingId || `P${String(state.next).padStart(4, '0')}`;
    const product = buildProductFromRows(arr, id);
    persist({ products: [product], next: existingId ? state.next : state.next + 1 });
    setError('');
    setCopyMessage('붙여넣기 자동 적용 완료');
  }

  function handlePasteTextChange(nextValue) {
    setPasteText(nextValue);
    const text = nextValue.trim();

    if (!text) {
      persist({ products: [], next: 1 });
      setError('');
      setCopyMessage('');
      return;
    }

    try {
      applyCaptureRows(parseCaptureRows(text));
    } catch (e) {
      const looksComplete = text.startsWith('[') && text.endsWith(']');
      if (looksComplete) {
        setError(`붙여넣기 오류: ${e.message}`);
        setCopyMessage('');
      }
    }
  }

  function resetAll() {
    if (!window.confirm('붙여넣기와 수집 데이터를 전부 초기화할까요?')) return;
    persist({ products: [], next: 1 });
    setPasteText('');
    setError('');
    setCopyMessage('');
  }

  function updateProductName(productId, value) {
    persist({
      ...state,
      products: state.products.map((product) => (
        product.id === productId ? { ...product, name: value } : product
      )),
    });
  }

  function updateRow(productId, rowIndex, patch) {
    persist({
      ...state,
      products: state.products.map((product) => (
        product.id === productId
          ? { ...product, rows: product.rows.map((row, idx) => (idx === rowIndex ? { ...row, ...patch } : row)) }
          : product
      )),
    });
  }

  async function copyToClipboard(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage(message);
      setError('');
    } catch (e) {
      setError('복사에 실패했습니다. HTTPS 환경인지 확인하거나 직접 선택해서 복사하세요.');
    }
  }

  function copyNamesAndOptions() {
    const text = state.products.flatMap((product) => product.rows.map((row) => {
      const option = row.option && row.option !== '-' ? row.option : '';
      return option ? `${product.name}\t${option}` : product.name;
    })).join('\n');
    copyToClipboard(text, '상품명+옵션명 복사 완료');
  }

  function copyPrices() {
    const text = state.products.flatMap((product) => product.rows.map((row) => row.price || '')).join('\n');
    copyToClipboard(text, '가격 복사 완료');
  }

  return (
    <section className="page product-capture-page">
      <div className="page-header">
        <div>
          <h1>상품 수집</h1>
          <p>Shopee 상품페이지에서 북마클릿으로 상품명, 옵션명, 바우처 제외 가격을 가져와 마진차트에 붙여넣기 쉽게 정리합니다.</p>
        </div>
      </div>

      <div className="card">
        <h3>북마클릿 안내</h3>
        <p>아래 링크는 클릭 실행용이 아니라, <strong>북마크바로 드래그해서 등록</strong>하는 용도입니다.</p>
        <div className="bookmarklet-actions">
          <button type="button" className="action-btn" onClick={() => navigator.clipboard.writeText(BOOKMARKLET_CODE)}>북마클릿 코드 복사</button>
          <a className="action-btn" href={BOOKMARKLET_CODE} onClick={(e) => e.preventDefault()} title="북마크바로 드래그해서 등록">Shopee 상품수집 (드래그 등록용)</a>
        </div>
      </div>

      <div className="product-capture-workspace">
        <section className="card product-capture-paste-panel">
          <h3>상품정보 붙여넣기</h3>
          <textarea rows={3} value={pasteText} onChange={(e) => handlePasteTextChange(e.target.value)} placeholder="북마클릿 JSON을 붙여넣으세요. 붙여넣으면 자동으로 적용됩니다." />
          <div className="product-capture-paste-actions">
            <button type="button" className="action-btn" onClick={resetAll}>전체 초기화</button>
          </div>
        </section>

        <section className="card product-capture-reference-panel">
          <div className="product-capture-panel-header">
            <h3>수집 결과</h3>
            <div className="product-capture-result-actions">
              <button type="button" className="action-btn" onClick={copyNamesAndOptions} disabled={!tableRows.length}>상품명+옵션명 복사</button>
              <button type="button" className="action-btn" onClick={copyPrices} disabled={!tableRows.length}>가격 복사</button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table product-capture-result-table">
              <colgroup>
                <col className="product-capture-name-col" />
                <col className="product-capture-option-col" />
                <col className="product-capture-price-col" />
              </colgroup>
              <thead>
                <tr><th>상품명</th><th>옵션명</th><th>가격</th></tr>
              </thead>
              <tbody>
                {tableRows.length ? tableRows.map((row, idx) => (
                  <tr key={row.id}>
                    <td>{row.isFirst ? <input value={row.productName} onChange={(e) => updateProductName(row.productId, e.target.value)} /> : ''}</td>
                    <td><input value={row.option} onChange={(e) => updateRow(row.productId, row.rowIndex, { option: e.target.value })} /></td>
                    <td><input value={row.price} onChange={(e) => updateRow(row.productId, row.rowIndex, { price: e.target.value })} /></td>
                  </tr>
                )) : (
                  <tr><td colSpan="3" className="empty-cell">북마클릿 JSON을 붙여넣으면 수집 결과가 자동 표시됩니다.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {error && <div className="alert">{error}</div>}
      {copyMessage && <div className="notice">{copyMessage}</div>}

    </section>
  );
}
