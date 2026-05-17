import { useMemo, useState } from 'react';

const COUNTRIES = ['SG', 'TW', 'MY', 'PH', 'TH', 'VN', 'BR', 'MX'];
const STORAGE_KEY = 'product_capture_v1';

const BOOKMARKLET_CODE = `javascript:(async()=>{const c=s=>String(s||"").replace(/\s+/g," ").trim(),g=(o,k)=>{try{return o&&typeof o==="object"?o[k]:void 0}catch(e){return void 0}},fmt=r=>{if(r==null||r==="")return"";const n=Number(r);if(!Number.isFinite(n))return String(r);if(n>=100000)return(n/100000).toFixed(2);if(n>=1000)return(n/100).toFixed(2);return n.toFixed(2)},parseIds=()=>{const h=location.href;let m=h.match(/i\.(\d+)\.(\d+)/);if(m)return{shop:m[1],item:m[2]};return{shop:"",item:""}},ids=parseIds(),title=()=>c(document.querySelector("h1")?.innerText)||c(document.title.replace(/\|.*Shopee.*/i,"")),sid=o=>String(g(o,"shopid")||g(o,"shop_id")||g(o,"shopId")||g(g(o,"item"),"shopid")||g(g(o,"item"),"shop_id")||g(g(o,"basic"),"shopid")||""),iid=o=>String(g(o,"itemid")||g(o,"item_id")||g(o,"itemId")||g(g(o,"item"),"itemid")||g(g(o,"item"),"item_id")||g(g(o,"basic"),"itemid")||""),tiers=o=>g(o,"tier_variations")||g(o,"tierVariations")||g(o,"tier_variation")||g(o,"tierVariation")||g(g(o,"item"),"tier_variations")||g(g(o,"item"),"tierVariations")||[],models=o=>g(o,"models")||g(o,"model_list")||g(o,"modelList")||g(g(o,"item"),"models")||g(g(o,"item"),"model_list")||[],idx=m=>g(m,"tier_index")||g(m,"tierIndex")||g(g(m,"extinfo"),"tier_index")||g(g(m,"extinfo"),"tierIndex")||g(g(m,"ext_info"),"tier_index")||[],price=m=>g(m,"price")??g(g(m,"price_stocks")?.[0],"price")??g(g(m,"priceStocks")?.[0],"price")??g(m,"price_min")??g(m,"priceMin")??"",opt=o=>{if(o==null)return"";if(typeof o==="string")return c(o);if(typeof o==="object")return c(g(o,"name")||g(o,"option")||g(o,"value")||g(o,"display_name")||g(o,"displayName")||g(o,"label")||g(o,"text")||"");return c(o)},pathMatch=path=>ids.item&&path.includes(ids.item),objectMatch=o=>{const it=iid(o),sh=sid(o);if(ids.item&&it&&it!==ids.item)return false;if(ids.shop&&sh&&sh!==ids.shop)return false;return true},seen=new WeakSet(),cand=[];function scan(o,path,d){try{if(!o||typeof o!=="object"||seen.has(o))return;seen.add(o);const ms=models(o),ts=tiers(o),hasModels=Array.isArray(ms)&&ms.length>0;if(hasModels&&objectMatch(o)){const it=iid(o),sh=sid(o),exact=(ids.item&&it===ids.item)||(ids.item&&pathMatch(path));cand.push({path,ts:Array.isArray(ts)?ts:[],ms,it,sh,exact:exact?1:0,priced:ms.filter(x=>price(x)!=="").length,mc:ms.length,tc:Array.isArray(ts)?ts.length:0});return}if(d<=0)return;let ks=[];try{ks=Object.keys(o).slice(0,900)}catch(e){return}for(const k of ks){const v=g(o,k);if(v&&typeof v==="object")scan(v,path+"."+k,d-1)}}catch(e){}}if(!ids.item){alert("현재 URL에서 Shopee item_id를 찾지 못했습니다. 상품 URL에 i.shop_id.item_id 형식이 있는지 확인하세요.");return}try{if(window.dataLayer)scan(window.dataLayer,"window.dataLayer",14)}catch(e){}for(const s of Array.from(document.scripts)){const raw=s.textContent||"",txt=c(raw),type=c(s.type||""),id=c(s.id||"");if(!txt)continue;if(type.includes("json")||type.includes("shopee")||id.includes("NEXT")||id.includes("INITIAL")||txt.startsWith("{")||txt.startsWith("[")){try{scan(JSON.parse(raw),"script#"+(id||type||"no-id"),14)}catch(e){}}}const exact=cand.filter(x=>x.exact);const best=exact.sort((a,b)=>b.priced-a.priced||b.tc-a.tc||b.mc-a.mc)[0];if(!best){alert("현재 상품과 일치하는 모델 데이터를 찾지 못했습니다. 상품 페이지를 새로고침하고 완전히 로딩된 뒤 다시 실행하세요.");return}const pn=title(),rows=best.ms.map(m=>{const ix=idx(m);let parts=[];if(Array.isArray(ix)&&ix.length&&best.ts.length){parts=ix.map((v,i)=>{const group=best.ts[i]||{},os=g(group,"options")||g(group,"values")||g(group,"option_list")||[];return opt(os[v])}).filter(Boolean)}let on=parts.length?parts.join(" / "):c(g(m,"name")||g(m,"model_name")||g(m,"modelName")||"");if(!on||on===pn)on="-";return{상품명:pn,옵션명:on,수집가격:fmt(price(m)),_idx:Array.isArray(ix)?ix:[]}}).sort((a,b)=>a._idx.map(v=>String(v).padStart(4,"0")).join("-").localeCompare(b._idx.map(v=>String(v).padStart(4,"0")).join("-"),void 0,{numeric:true})).map(({_idx,...r})=>r);const text=JSON.stringify(rows,null,2),fb=()=>{const ta=document.createElement("textarea");ta.value=text;ta.style.position="fixed";ta.style.left="20px";ta.style.top="20px";ta.style.width="700px";ta.style.height="400px";ta.style.zIndex="999999";document.body.appendChild(ta);ta.focus();ta.select();document.execCommand("copy");alert("복사창이 열렸습니다. Ctrl+C 후 붙여넣기 해보세요.")};try{await navigator.clipboard.writeText(text);alert("Shopee 상품수집 복사 완료: "+rows.length+"행")}catch(e){fb()}})();`;

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"products":[],"next":1}');
  } catch {
    return { products: [], next: 1 };
  }
}

function buildCompareRows(baseRows, capturedRows) {
  return baseRows.map((row, idx) => ({
    baseOption: row.option,
    capturedOption: capturedRows[idx]?.option ?? '',
    nextPrice: capturedRows[idx]?.price ?? '',
  }));
}

export default function ProductCapturePage() {
  const [state, setState] = useState(loadState);
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [confirm, setConfirm] = useState(null);

  const selected = useMemo(() => state.products.find((p) => p.id === selectedId), [state.products, selectedId]);

  function persist(nextState) {
    setState(nextState);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  }

  function applyPaste() {
    try {
      const arr = JSON.parse(pasteText);
      if (!Array.isArray(arr) || !arr.length) throw new Error('JSON 배열이 아닙니다.');
      arr.forEach((r) => {
        if (!r['상품명'] && r['상품명'] !== '') throw new Error('상품명 누락');
        if (r['옵션명'] == null) throw new Error('옵션명 누락');
        if (r['수집가격'] == null) throw new Error('수집가격 누락');
      });

      setPreview({
        name: arr[0]['상품명'] || '',
        rows: arr.map((r) => ({ option: String(r['옵션명'] || '-'), price: String(r['수집가격'] || '') })),
      });
      setError('');
    } catch (e) {
      setError(`붙여넣기 오류: ${e.message}`);
    }
  }

  function createProduct(country) {
    if (!preview) return;

    const id = `P${String(state.next).padStart(4, '0')}`;
    const product = {
      id,
      name: preview.name,
      rows: preview.rows.map((row) => ({
        option: row.option,
        prices: Object.fromEntries(COUNTRIES.map((c) => [c, c === country ? row.price : ''])),
      })),
    };

    persist({ products: [...state.products, product], next: state.next + 1 });
    setSelectedId(id);
  }

  function openConnectConfirm(country) {
    if (!preview) return;
    if (!selected) {
      setError('먼저 기준 상품을 선택하세요.');
      return;
    }

    setConfirm({
      country,
      rowMismatch: selected.rows.length !== preview.rows.length,
      overwrite: selected.rows.some((row) => row.prices[country]),
      rows: buildCompareRows(selected.rows, preview.rows),
    });
  }

  function applyConnect() {
    const { country, rowMismatch } = confirm;
    const next = {
      ...state,
      products: state.products.map((product) => {
        if (product.id !== selected.id) return product;
        return {
          ...product,
          rows: product.rows.map((row, idx) => ({
            ...row,
            prices: { ...row.prices, [country]: preview.rows[idx]?.price ?? row.prices[country] },
          })),
        };
      }),
    };

    persist(next);
    setConfirm(null);
    if (rowMismatch) setError('행 수 불일치 상태로 연결되었습니다. 결과를 다시 확인하세요.');
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

      <div className="card">
        <h3>붙여넣기 영역</h3>
        <textarea rows={4} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="북마클릿 JSON 결과를 붙여넣으세요." />
        <button type="button" className="action-btn primary" onClick={applyPaste}>붙여넣기 적용</button>
      </div>

      {error && <div className="alert">{error}</div>}

      {preview && (
        <div className="card">
          <h3>미리보기 카드</h3>
          <label>
            상품명
            <input value={preview.name} onChange={(e) => setPreview({ ...preview, name: e.target.value })} />
          </label>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>옵션명</th><th>수집가격</th></tr></thead>
              <tbody>
                {preview.rows.map((row, idx) => (
                  <tr key={idx}>
                    <td><input value={row.option} onChange={(e) => setPreview({ ...preview, rows: preview.rows.map((r, i) => i === idx ? { ...r, option: e.target.value } : r) })} /></td>
                    <td><input value={row.price} onChange={(e) => setPreview({ ...preview, rows: preview.rows.map((r, i) => i === idx ? { ...r, price: e.target.value } : r) })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>새 기준 상품으로 추가: {COUNTRIES.map((c) => <button key={c} type="button" className="action-btn" onClick={() => createProduct(c)}>{c}</button>)}</div>
          <div>선택된 기준 상품: {selected ? `${selected.id} / ${selected.name}` : '없음'}</div>
          <div>선택한 기준 상품에 가격 연결: {COUNTRIES.map((c) => <button key={c} type="button" className="action-btn" onClick={() => openConnectConfirm(c)}>{c}</button>)}</div>
        </div>
      )}

      <div className="card">
        <h3>기준 상품 목록</h3>
        <div className="product-list">
          {state.products.map((product) => (
            <label key={product.id} className={`product-item ${selectedId === product.id ? 'selected' : ''}`}>
              <input type="radio" checked={selectedId === product.id} onChange={() => setSelectedId(product.id)} />
              <span>{product.id} {product.name} / {product.rows.length}행</span>
            </label>
          ))}
        </div>
      </div>

      {confirm && (
        <div className="card">
          <h3>연결 확인 패널</h3>
          {confirm.rowMismatch ? (
            <div className="alert">기준 상품은 {selected.rows.length}행, 수집 상품은 {preview.rows.length}행입니다. 가격이 다른 옵션에 들어갈 수 있으니 확인 후 연결하세요.</div>
          ) : (
            <div className="notice">기준 상품 행 수: {selected.rows.length}행 / 수집 상품 행 수: {preview.rows.length}행 (일치)</div>
          )}
          {confirm.overwrite && <div className="alert">{confirm.country} 가격이 이미 입력되어 있습니다. 연결 시 덮어씁니다.</div>}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>기준 옵션명</th><th>수집 옵션명</th><th>연결될 가격</th></tr></thead>
              <tbody>
                {confirm.rows.map((row, idx) => <tr key={idx}><td>{row.baseOption}</td><td>{row.capturedOption}</td><td>{row.nextPrice}</td></tr>)}
              </tbody>
            </table>
          </div>
          <button type="button" className="action-btn primary" onClick={applyConnect}>연결하기</button>
          <button type="button" className="action-btn" onClick={() => setConfirm(null)}>취소</button>
        </div>
      )}

      <div className="card">
        <h3>전체 기준표</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>상품ID</th><th>기준 상품명</th><th>기준 옵션명</th>{COUNTRIES.map((c) => <th key={c}>{c} 가격</th>)}</tr>
            </thead>
            <tbody>
              {state.products.flatMap((p) => p.rows.map((row, idx) => (
                <tr key={`${p.id}-${idx}`}>
                  <td>{p.id}</td>
                  <td>{idx === 0 ? <input value={p.name} onChange={(e) => persist({ ...state, products: state.products.map((x) => x.id === p.id ? { ...x, name: e.target.value } : x) })} /> : ''}</td>
                  <td><input value={row.option} onChange={(e) => persist({ ...state, products: state.products.map((x) => x.id === p.id ? { ...x, rows: x.rows.map((r, i) => i === idx ? { ...r, option: e.target.value } : r) } : x) })} /></td>
                  {COUNTRIES.map((c) => <td key={c}><input value={row.prices[c] || ''} onChange={(e) => persist({ ...state, products: state.products.map((x) => x.id === p.id ? { ...x, rows: x.rows.map((r, i) => i === idx ? { ...r, prices: { ...r.prices, [c]: e.target.value } } : r) } : x) })} /></td>)}
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>복사/초기화 버튼</h3>
        <button type="button" className="action-btn" onClick={() => navigator.clipboard.writeText(state.products.flatMap((p) => p.rows.map((r) => `${p.name}\t${r.option}`)).join('\n'))}>상품명+옵션명 복사</button>
        {COUNTRIES.map((c) => <button key={c} type="button" className="action-btn" onClick={() => navigator.clipboard.writeText(state.products.flatMap((p) => p.rows.map((r) => r.prices[c] || '')).join('\n'))}>{c} 가격 복사</button>)}
        <button
          type="button"
          className="action-btn"
          onClick={() => {
            if (window.confirm('누적된 상품 수집 데이터를 전부 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) {
              persist({ products: [], next: 1 });
              setSelectedId('');
            }
          }}
        >
          전체 초기화
        </button>
      </div>
    </section>
  );
}
