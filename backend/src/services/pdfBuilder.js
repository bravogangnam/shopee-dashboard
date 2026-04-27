/**
 * pdfBuilder.js  —  쇼피 공식 AWB 상단 크롭 + 커스텀 상품 목록 하단 합성
 *
 * 구조:
 *   ┌────────────────────────────────────┐
 *   │  [쇼피 공식 AWB 상단 크롭]          │
 *   │   Order ID: XXXXXXXXXX            │
 *   │   ┃┃┃┃┃┃┃┃ (바코드 이미지)  ┃┃┃  │
 *   │   Tracking NO.: XXXXXXXXX        │
 *   │━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│ ← 0.5pt 검정 구분선
 *   │  [커스텀 상품 목록]                 │
 *   │  상품명 (왼쪽, 굵게 14pt)           │
 *   │    옵션명 (28pt)       수량(12pt)   │
 *   │  ──────────────────────────────── │ ← 0.25pt #cccccc
 *   │  상품명2 ...                       │
 *   └────────────────────────────────────┘
 *
 * 용지: A6 (105×148mm = 297.638×419.528 pt)
 * AWB 크롭: Tracking NO. 텍스트 하단 y + CROP_PAD pt
 * 폰트: HelveticaBold/Helvetica (영문) + NotoSansSC-Regular (CJK)
 */

'use strict';

const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs      = require('fs');
const path    = require('path');

// ── CJK 폰트 경로 ────────────────────────────────────────────────
const CJK_FONT_PATH = path.resolve(__dirname, '../../assets/fonts/NotoSansSC-Regular.ttf');
const CJK_REGEX = /[\u1100-\u11FF\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE10-\uFE6F\uFF00-\uFFEF]/;
function hasCjk(str) { return CJK_REGEX.test(str); }

// ── A6 용지 치수 ─────────────────────────────────────────────────
const MM_TO_PT = 72 / 25.4;
const PAGE_W   = Math.round(105 * MM_TO_PT);   // 298pt
const PAGE_H   = Math.round(148 * MM_TO_PT);   // 420pt

// ── 레이아웃 상수 ─────────────────────────────────────────────────
const PAD       = 8;    // 전체 외곽 여백
const LEFT_M    = 10;   // 상품명 왼쪽 마진
const RIGHT_M   = 10;   // 수량 오른쪽 마진
const INDENT    = 18;   // 옵션명 들여쓰기 (LEFT_M 기준 추가)
const ITEM_SZ   = 12;   // 상품명 폰트
const MODEL_SZ  = 10;   // 옵션명/수량 폰트
const MIN_SZ    = 7;    // 최소 폰트
const DIV_H     = 6;    // 그룹 구분선 행 높이
const SEP_PAD   = 4;    // 구분선 위아래 여백
const CROP_PAD  = 4;    // Tracking NO. 하단 여백

// ── AWB 크롭 기준: Tracking NO. 텍스트 하단 y 탐색 ──────────────
/**
 * pdf-lib으로 AWB PDF를 로드한 뒤 "Tracking NO." 텍스트가 위치한
 * 하단 y 좌표를 찾아 반환.
 * pdf-lib은 텍스트 위치를 직접 파싱하지 않으므로,
 * 페이지 전체를 렌더링해 이미지로 변환 후 크롭 대신
 * → pdf-lib의 embedPage()로 크롭된 영역만 임베드하는 방식 사용.
 *
 * AWB 페이지 좌표계 (pdf-lib): 원점은 좌하단, y축 위쪽이 +
 * PyMuPDF 좌표계: 원점은 좌상단, y축 아래쪽이 +
 *
 * 분석 결과 (SG THERMAL_AIR_WAYBILL, 282.96×282.96pt):
 *   Tracking NO. bbox: y_top=82.7, y_bottom=92.7 (PyMuPDF 기준)
 *   → pdf-lib 기준: y_pdflib = pageH - y_bottom = 282.96 - 92.74 = 190.22
 *   크롭 영역: x=0, y=190.22-CROP_PAD, w=pageW, h=y_top_pdflib+CROP_PAD 방향
 *
 * 안전한 방법: 고정 비율(상단 35%) 크롭 + "Tracking NO." 텍스트 검색 fallback
 */

// AWB 페이지에서 크롭 하단 y 계산 (pdf-lib 좌표계, 좌하단 원점)
// pdfBytes: Buffer, awbPageH: AWB 페이지 높이(pt)
// 반환: pdflib 기준 크롭 하단 y (이 값보다 위쪽만 크롭)
//   즉, cropBox = { x:0, y: cropY, width: pageW, height: pageH-cropY }
async function findCropY(pdfBytes) {
  // pdf-lib으로 로드해서 페이지 크기만 파악
  const awbDoc  = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const awbPage = awbDoc.getPage(0);
  const { width: awbW, height: awbH } = awbPage.getSize();

  // 크롭 기준 계산:
  //   SG THERMAL_AIR_WAYBILL: 282.96×282.96pt 정사각형
  //   Tracking NO. 텍스트 하단: pymupdf y_bottom ≈ 92.74pt (상단 기준)
  //   → pdflib 기준(하단 원점): cropY_pdflib = awbH - (y_bottom + CROP_PAD)
  //                                           = 282.96 - (92.74 + 4) ≈ 186.22pt
  //   크롭 높이: awbH - cropY_pdflib ≈ 96.74pt (전체의 약 34.2%)
  //
  //   다른 AWB 크기(TW 등)를 위한 fallback:
  //   - awbH에 비례하여 TRACKING_Y_RATIO 적용 (34.2%)
  //   SG AWB: 282.96pt → tracking bottom ≈ 96.74pt (34.2%)
  //   MY AWB: 정사각형 유사하게 동일 비율 적용
  const TRACKING_BOTTOM_PT = 92.74 + CROP_PAD;  // pymupdf y_bottom + 여백
  const TRACKING_RATIO     = TRACKING_BOTTOM_PT / 282.96;  // ≈ 0.342

  // awbH가 실제 AWB 높이 — 비율로 안전하게 계산
  const cropFromTop_pt = awbH * TRACKING_RATIO;
  const cropY_pdflib   = awbH - cropFromTop_pt;  // pdflib 하단 기준 y (이 y 이상만 크롭)

  return { awbW, awbH, cropY_pdflib, cropH: cropFromTop_pt };
}

// ════════════════════════════════════════════════════════════════
// 메인 함수
// ════════════════════════════════════════════════════════════════
/**
 * @param {Buffer}  awbBuffer     - Shopee API download_shipping_document 응답
 * @param {Array}   items         - order_items 배열
 * @param {string}  orderSn       - 주문번호
 * @param {string}  trackingNumber - 운송장번호
 * @param {string}  [currency]    - 통화 (미사용)
 */
async function buildInvoicePdf({ awbBuffer, items = [], orderSn, trackingNumber, currency }) {
  if (!awbBuffer || awbBuffer.length === 0) {
    throw new Error(`AWB PDF 없음: ${orderSn}`);
  }

  // ── 1) AWB 크롭 영역 계산 ────────────────────────────────────
  const { awbW, awbH, cropY_pdflib, cropH } = await findCropY(awbBuffer);

  // ── 2) 대상 PDF 생성 (A6) ────────────────────────────────────
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // 폰트 로드
  const { StandardFonts } = require('pdf-lib');
  const fontLatin  = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontLatinB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let fontCjk = null;
  try {
    const cjkBytes = fs.readFileSync(CJK_FONT_PATH);
    fontCjk = await pdfDoc.embedFont(cjkBytes, { subset: true });
    console.log('[pdfBuilder] CJK font loaded');
  } catch (e) {
    console.warn('[pdfBuilder] CJK font load failed:', e.message);
  }

  function pickFont(text, bold = false) {
    if (fontCjk && hasCjk(text)) return fontCjk;
    return bold ? fontLatinB : fontLatin;
  }

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  // ── 3) AWB 상단 크롭 임베드 ──────────────────────────────────
  // AWB PDF의 첫 페이지 상단 cropH 만큼만 임베드
  const awbDoc   = await PDFDocument.load(awbBuffer, { ignoreEncryption: true });
  const [awbEmbedPage] = await pdfDoc.embedPages([awbDoc.getPage(0)], [
    {
      left:   0,
      right:  awbW,
      bottom: cropY_pdflib,          // pdflib 기준 하단 (크롭 하단)
      top:    awbH,                  // pdflib 기준 상단 (AWB 최상단)
    }
  ]);

  // A6 전체 폭에 맞게 스케일, 비율 유지
  const drawW = PAGE_W;
  const drawH = cropH * (PAGE_W / awbW);

  // A6 페이지 상단에 배치 (pdflib 좌표: y축 상단이 PAGE_H)
  const awbDrawY = PAGE_H - drawH;
  page.drawPage(awbEmbedPage, {
    x: 0, y: awbDrawY,
    width: drawW, height: drawH,
  });

  console.log(`[pdfBuilder] AWB cropped: awb=${awbW.toFixed(0)}x${awbH.toFixed(0)}pt crop_y=${cropY_pdflib.toFixed(1)} draw=${drawW.toFixed(0)}x${drawH.toFixed(0)}pt`);

  // ── 4) 구분선 (AWB 하단 ~ 상품 목록 경계) ────────────────────
  let curY = awbDrawY - SEP_PAD;
  const sepY = curY;
  page.drawLine({
    start: { x: PAD,          y: sepY },
    end:   { x: PAGE_W - PAD, y: sepY },
    thickness: 0.5,
    color: rgb(0, 0, 0),
  });
  curY -= SEP_PAD;

  // ── 5) 상품 목록 ────────────────────────────────────────────
  const groups  = _groupByItemName(items);
  const rows    = _buildRows(groups);
  const BOT_RSV = PAD + 2;

  const usableH = curY - BOT_RSV;
  const { itemSz, modelSz } = _chooseFontSizes(rows, usableH, ITEM_SZ, MODEL_SZ, MIN_SZ, DIV_H);
  const itemLineH  = itemSz  + 3;
  const modelLineH = modelSz + 3;

  const QTY_COL = fontLatin.widthOfTextAtSize('999', modelSz) + 4;
  const W_FULL  = PAGE_W - LEFT_M - RIGHT_M;
  const W_MODEL = W_FULL - INDENT - QTY_COL - 2;

  for (const row of rows) {
    if (row.type === 'divider') {
      const divY = curY - DIV_H / 2;
      if (divY > BOT_RSV) {
        page.drawLine({
          start: { x: PAD,          y: divY },
          end:   { x: PAGE_W - PAD, y: divY },
          thickness: 0.25,
          color: rgb(0.80, 0.80, 0.80),
        });
      }
      curY -= DIV_H;
      continue;
    }

    if (row.type === 'item') {
      const textY = curY - itemLineH;
      if (textY < BOT_RSV) break;

      const font  = pickFont(row.text, true);
      const label = _truncateByWidth(row.text, W_FULL, font, itemSz);
      page.drawText(label, {
        x: LEFT_M, y: textY,
        size: itemSz, font, color: rgb(0, 0, 0),
      });
      curY -= itemLineH;

    } else {
      const textY = curY - modelLineH;
      if (textY < BOT_RSV) break;

      const fModel = pickFont(row.text);
      const label  = _truncateByWidth(row.text, W_MODEL, fModel, modelSz);
      page.drawText(label, {
        x: LEFT_M + INDENT, y: textY,
        size: modelSz, font: fModel,
        color: rgb(0.2, 0.2, 0.2),
      });

      const qtyStr = row.qty ?? '1';
      const qtyW   = fontLatin.widthOfTextAtSize(qtyStr, modelSz);
      page.drawText(qtyStr, {
        x: PAGE_W - RIGHT_M - qtyW, y: textY,
        size: modelSz, font: fontLatin, color: rgb(0, 0, 0),
      });
      curY -= modelLineH;
    }
  }

  return Buffer.from(await pdfDoc.save());
}


// ════════════════════════════════════════════════════════════════
// 헬퍼
// ════════════════════════════════════════════════════════════════
function _groupByItemName(items) {
  const groups = [];
  const idx    = new Map();
  for (const item of items) {
    const key = (item.item_name || '').trim();
    if (idx.has(key)) {
      groups[idx.get(key)].models.push(item);
    } else {
      idx.set(key, groups.length);
      groups.push({ item_name: key, models: [item] });
    }
  }
  return groups;
}

function _buildRows(groups) {
  const rows = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    rows.push({ type: 'item', text: g.item_name });
    for (const m of g.models) {
      rows.push({
        type: 'model',
        text: m.model_name || '-',
        qty:  String(m.model_quantity_purchased ?? 1),
      });
    }
    if (gi < groups.length - 1) rows.push({ type: 'divider' });
  }
  return rows;
}

function _chooseFontSizes(rows, usableH, baseItem, baseModel, minSz, divH) {
  for (let step = 0; ; step++) {
    const itemSz  = Math.max(baseItem  - step, minSz);
    const modelSz = Math.max(baseModel - step, minSz);
    let h = 0;
    for (const r of rows) {
      if (r.type === 'divider')    h += divH;
      else if (r.type === 'item')  h += itemSz  + 3;
      else                         h += modelSz + 3;
    }
    if (h <= usableH || (itemSz === minSz && modelSz === minSz)) return { itemSz, modelSz };
  }
}

function _textWidth(text, font, size) {
  try {
    const w = font.widthOfTextAtSize(text, size);
    if (w > 0) return w;
  } catch (_) {}
  let w = 0;
  for (const ch of text) w += CJK_REGEX.test(ch) ? size : size * 0.55;
  return w;
}

const _estimateWidth = (text, size) => {
  let w = 0;
  for (const ch of text) w += CJK_REGEX.test(ch) ? size : size * 0.55;
  return w;
};

function _truncateByWidth(text, maxWidth, font, size) {
  if (!text) return '';
  const EL = '…';
  try {
    const tw = font.widthOfTextAtSize(text, size);
    if (tw > 0) {
      if (tw <= maxWidth) return text;
      const ew = font.widthOfTextAtSize(EL, size);
      let lo = 1, hi = text.length - 1, best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (font.widthOfTextAtSize(text.slice(0, mid), size) + ew <= maxWidth) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return best > 0 ? text.slice(0, best) + EL : EL;
    }
  } catch (_) {}
  const EW = size * 0.6;
  if (_estimateWidth(text, size) <= maxWidth) return text;
  let lo = 1, hi = text.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (_estimateWidth(text.slice(0, mid), size) + EW <= maxWidth) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best > 0 ? text.slice(0, best) + EL : EL;
}

// ════════════════════════════════════════════════════════════════
// PDF 합치기 / 유틸
// ════════════════════════════════════════════════════════════════
async function mergePdfs(pdfBuffers) {
  const merged = await PDFDocument.create();
  for (const buf of pdfBuffers) {
    try {
      const src   = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    } catch (e) {
      console.warn(`[pdfBuilder] mergePdfs error: ${e.message}`);
    }
  }
  return Buffer.from(await merged.save());
}

function isHtmlContent(buffer) {
  if (!buffer || buffer.length < 5) return false;
  const s = buffer.slice(0, 500).toString('utf8').toLowerCase();
  return s.includes('<!doctype html') || s.includes('<html');
}

module.exports = { buildInvoicePdf, mergePdfs, isHtmlContent, PAGE_W, PAGE_H };
