import { useEffect, useMemo, useRef, useState } from "react";
import { getStoredToken } from "../api/client.js";

const STORAGE_KEY = "brand_image_maker_v2";
const FONT_OPTIONS = [
  ["Arial Black", "Arial Black, Arial, sans-serif"],
  ["기본 고딕", "Arial, sans-serif"],
  ["Impact", "Impact, Arial Black, sans-serif"],
  ["Trebuchet", "Trebuchet MS, Arial, sans-serif"],
  ["Georgia", "Georgia, serif"],
];
const DEFAULT_SETTINGS = {
  product: { left: 0, top: 0, width: 100, height: 100 },
  brand: {
    left: 10,
    top: 5,
    width: 80,
    height: 16,
    color: "#111111",
    fontFamily: FONT_OPTIONS[0][1],
    fontWeight: 800,
    minFontSize: 12,
    maxFontSize: 220,
    autoFit: true,
    fontSize: 80,
    shadow: false,
  },
};

const clamp = (value, min, max) =>
  Math.min(Math.max(Number(value) || 0, min), max);

function cloneSettings(value = DEFAULT_SETTINGS) {
  return {
    product: { ...DEFAULT_SETTINGS.product, ...(value.product || {}) },
    brand: { ...DEFAULT_SETTINGS.brand, ...(value.brand || value || {}) },
  };
}

function loadStoredSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      pasteText: String(saved.pasteText || ""),
      settings: cloneSettings(saved.settings),
    };
  } catch {
    return { pasteText: "", settings: cloneSettings() };
  }
}

function normalizeSku(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function skuFromFilename(filename) {
  return normalizeSku(
    String(filename || "")
      .replace(/\.[^.]+$/, "")
      .replace(/\s*\(\d+\)\s*$/, "")
      .replace(/(?:[-_\s]+C)$/i, "")
      .trim(),
  );
}

function parseSkuBrandText(text) {
  const map = new Map();
  const conflicts = new Set();
  const rows = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((parts) => parts.some((value) => value.trim()));
  for (const parts of rows) {
    const skuIndex = parts.findIndex((value) =>
      /^[A-Za-z]{1,6}[_-]?\d{3,}$/i.test(String(value || "").trim()),
    );
    if (skuIndex < 0) continue;
    const sku = normalizeSku(parts[skuIndex]);
    const brand = String(parts[skuIndex + 1] || "").trim();
    if (!brand || /^(브랜드|brand)$/i.test(brand)) continue;
    if (map.has(sku) && map.get(sku) !== brand) conflicts.add(sku);
    if (!map.has(sku)) map.set(sku, brand);
  }
  return { map, conflicts };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    if (!url) return resolve(null);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
    image.src = url;
  });
}

function drawContain(context, image, box) {
  if (!image) return;
  const x = (1000 * box.left) / 100;
  const y = (1000 * box.top) / 100;
  const width = (1000 * box.width) / 100;
  const height = (1000 * box.height) / 100;
  const scale = Math.min(
    width / image.naturalWidth,
    height / image.naturalHeight,
  );
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function textLines(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n");
}

function fitFontSize(context, text, maxWidth, maxHeight, brand) {
  if (!brand.autoFit) return clamp(brand.fontSize, 6, 400);
  const lines = textLines(text);
  let low = Math.max(1, Number(brand.minFontSize) || 12);
  let high = Math.max(
    low,
    Math.min(
      Number(brand.maxFontSize) || 220,
      maxHeight / Math.max(lines.length, 1),
    ),
  );
  let best = low;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    context.font = `${brand.fontWeight} ${size}px ${brand.fontFamily}`;
    const widest = Math.max(
      ...lines.map((line) => context.measureText(line || " ").width),
    );
    if (widest <= maxWidth && size * 1.12 * lines.length <= maxHeight) {
      best = size;
      low = size + 1;
    } else high = size - 1;
  }
  return best;
}

async function drawComposite(
  canvas,
  productUrl,
  backgroundUrl,
  brandText,
  settings,
) {
  const [productImage, backgroundImage] = await Promise.all([
    loadImage(productUrl),
    loadImage(backgroundUrl),
  ]);
  canvas.width = 1000;
  canvas.height = 1000;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 1000, 1000);
  drawContain(context, productImage, settings.product);
  if (brandText) {
    const brand = settings.brand;
    const boxX = (1000 * brand.left) / 100;
    const boxY = (1000 * brand.top) / 100;
    const boxWidth = (1000 * brand.width) / 100;
    const boxHeight = (1000 * brand.height) / 100;
    const lines = textLines(brandText);
    const fontSize = fitFontSize(context, brandText, boxWidth, boxHeight, brand);
    const lineHeight = fontSize * 1.12;
    const naturalHeight = lineHeight * lines.length;
    const verticalScale = brand.autoFit
      ? boxHeight / Math.max(naturalHeight, 1)
      : 1;
    context.save();
    context.font = `${brand.fontWeight} ${fontSize}px ${brand.fontFamily}`;
    context.fillStyle = brand.color;
    context.textAlign = "center";
    context.textBaseline = "middle";
    if (brand.shadow) {
      context.shadowColor = "rgba(0,0,0,.55)";
      context.shadowBlur = Math.max(2, fontSize * 0.08);
      context.shadowOffsetY = Math.max(1, fontSize * 0.035);
    }
    context.translate(boxX + boxWidth / 2, boxY + boxHeight / 2);
    context.scale(1, verticalScale);
    lines.forEach((line, index) => {
      const lineY = (index - (lines.length - 1) / 2) * lineHeight;
      context.fillText(line || " ", 0, lineY, boxWidth);
    });
    context.restore();
  }
  if (backgroundImage) context.drawImage(backgroundImage, 0, 0, 1000, 1000);
}

function authHeaders(extra = {}) {
  const token = getStoredToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers: authHeaders(options.headers),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function PreviewCanvas({
  item,
  backgroundUrl,
  settings,
  canvasRef,
  onClick,
  large = false,
}) {
  const localRef = useRef(null);
  useEffect(() => {
    if (localRef.current)
      drawComposite(
        localRef.current,
        item.url,
        backgroundUrl,
        item.brand,
        settings,
      ).catch(() => {});
  }, [item.url, item.brand, backgroundUrl, settings]);
  return (
    <canvas
      className={large ? "brand-editor-canvas" : ""}
      ref={(node) => {
        localRef.current = node;
        canvasRef?.(node);
      }}
      onClick={onClick}
      aria-label={`${item.filename} 합성 미리보기`}
    />
  );
}

function TransformBox({ box, target, stageRef, onChange }) {
  function start(event, action) {
    event.preventDefault();
    event.stopPropagation();
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const original = { ...box };
    const minSize = target === "product" ? 12 : 5;

    function move(pointerEvent) {
      const dx = ((pointerEvent.clientX - startX) / rect.width) * 100;
      const dy = ((pointerEvent.clientY - startY) / rect.height) * 100;
      if (action === "move") {
        onChange({
          ...original,
          left: clamp(original.left + dx, 0, 100 - original.width),
          top: clamp(original.top + dy, 0, 100 - original.height),
        });
        return;
      }
      let left = original.left;
      let top = original.top;
      let right = original.left + original.width;
      let bottom = original.top + original.height;
      if (action.includes("w"))
        left = clamp(original.left + dx, 0, right - minSize);
      if (action.includes("e")) right = clamp(right + dx, left + minSize, 100);
      if (action.includes("n"))
        top = clamp(original.top + dy, 0, bottom - minSize);
      if (action.includes("s")) bottom = clamp(bottom + dy, top + minSize, 100);
      if (target === "product") {
        const size = clamp(Math.max(right - left, bottom - top), minSize, 100);
        if (action.includes("w"))
          left = clamp(right - size, 0, right - minSize);
        else right = clamp(left + size, left + minSize, 100);
        if (action.includes("n"))
          top = clamp(bottom - size, 0, bottom - minSize);
        else bottom = clamp(top + size, top + minSize, 100);
      }
      onChange({ left, top, width: right - left, height: bottom - top });
    }

    function end() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  }

  return (
    <div
      className={`brand-transform-box ${target}`}
      style={{
        left: `${box.left}%`,
        top: `${box.top}%`,
        width: `${box.width}%`,
        height: `${box.height}%`,
      }}
      onPointerDown={(event) => start(event, "move")}
    >
      {["nw", "ne", "sw", "se"].map((corner) => (
        <button
          type="button"
          key={corner}
          className={`brand-transform-handle ${corner}`}
          onPointerDown={(event) => start(event, corner)}
          aria-label={`${corner} 크기 조절`}
        />
      ))}
    </div>
  );
}

function RangeField({ label, value, min = 0, max = 100, onChange }) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step="1"
        value={Math.round(Number(value) * 10) / 10}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export default function BrandImageMakerPage() {
  const stored = useMemo(loadStoredSettings, []);
  const [pasteText, setPasteText] = useState(stored.pasteText);
  const [commonSettings, setCommonSettings] = useState(stored.settings);
  const [images, setImages] = useState([]);
  const [backgrounds, setBackgrounds] = useState([]);
  const [selectedBackgroundId, setSelectedBackgroundId] = useState("");
  const [manualBrands, setManualBrands] = useState({});
  const [overrides, setOverrides] = useState({});
  const [editingId, setEditingId] = useState("");
  const [editTarget, setEditTarget] = useState("brand");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragTarget, setDragTarget] = useState("");
  const canvasMap = useRef(new Map());
  const editorCanvas = useRef(null);
  const editorStage = useRef(null);
  const imagesRef = useRef([]);
  const backgroundsRef = useRef([]);
  const parsed = useMemo(() => parseSkuBrandText(pasteText), [pasteText]);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ pasteText, settings: commonSettings }),
    );
  }, [pasteText, commonSettings]);
  useEffect(() => {
    loadBackgrounds();
  }, []);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(
    () => () =>
      imagesRef.current.forEach((item) => URL.revokeObjectURL(item.url)),
    [],
  );
  useEffect(() => {
    backgroundsRef.current = backgrounds;
  }, [backgrounds]);
  useEffect(
    () => () =>
      backgroundsRef.current.forEach(
        (item) => item.objectUrl && URL.revokeObjectURL(item.objectUrl),
      ),
    [],
  );

  async function loadBackgrounds(preferredId = "") {
    try {
      const result = await apiJson("/api/brand-image-maker/backgrounds");
      const loaded = await Promise.all(
        result.backgrounds.map(async (row) => {
          const response = await fetch(row.url, {
            credentials: "include",
            headers: authHeaders(),
          });
          if (!response.ok)
            throw new Error(`${row.name} 배경을 불러오지 못했습니다.`);
          return {
            ...row,
            objectUrl: URL.createObjectURL(await response.blob()),
          };
        }),
      );
      setBackgrounds((current) => {
        current.forEach(
          (item) => item.objectUrl && URL.revokeObjectURL(item.objectUrl),
        );
        return loaded;
      });
      const selected =
        preferredId ||
        loaded.find((item) => item.isDefault)?.id ||
        loaded[0]?.id ||
        "";
      setSelectedBackgroundId((current) =>
        loaded.some((item) => item.id === current) ? current : selected,
      );
    } catch (loadError) {
      setError(loadError.message);
    }
  }

  async function saveBackgroundFiles(fileList) {
    const files = Array.from(fileList || []).filter(
      (file) => file.type === "image/png" || /\.png$/i.test(file.name),
    );
    if (!files.length) return;
    const formData = new FormData();
    files.forEach((file) => formData.append("backgrounds", file));
    setBusy(true);
    setError("");
    try {
      const result = await apiJson("/api/brand-image-maker/backgrounds", {
        method: "POST",
        body: formData,
      });
      await loadBackgrounds(result.backgrounds[0]?.id);
      setMessage(`배경 ${result.backgrounds.length}장을 저장했습니다.`);
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setBusy(false);
    }
  }

  function uploadBackgrounds(event) {
    saveBackgroundFiles(event.target.files);
    event.target.value = "";
  }

  function dropBackgrounds(event) {
    event.preventDefault();
    setDragTarget("");
    saveBackgroundFiles(event.dataTransfer.files);
  }

  async function chooseBackground(id) {
    setSelectedBackgroundId(id);
    try {
      await apiJson(`/api/brand-image-maker/backgrounds/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault: true }),
      });
    } catch (chooseError) {
      setError(chooseError.message);
    }
  }

  async function renameBackground(item, name) {
    if (!name.trim() || name.trim() === item.name) return;
    try {
      await apiJson(`/api/brand-image-maker/backgrounds/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await loadBackgrounds(item.id);
    } catch (renameError) {
      setError(renameError.message);
    }
  }

  async function deleteBackground(item) {
    if (item.deleteArmed !== true) {
      setBackgrounds((current) =>
        current.map((row) => ({ ...row, deleteArmed: row.id === item.id })),
      );
      return;
    }
    try {
      await apiJson(`/api/brand-image-maker/backgrounds/${item.id}`, {
        method: "DELETE",
      });
      await loadBackgrounds();
      setMessage("배경을 삭제했습니다.");
    } catch (deleteError) {
      setError(deleteError.message);
    }
  }

  const selectedBackground = backgrounds.find(
    (item) => item.id === selectedBackgroundId,
  );
  const matchedImages = useMemo(
    () =>
      images.map((item) => {
        const automaticBrand = parsed.conflicts.has(item.sku)
          ? ""
          : parsed.map.get(item.sku) || "";
        const override = overrides[item.id];
        return {
          ...item,
          brand: manualBrands[item.id] ?? automaticBrand,
          conflict: parsed.conflicts.has(item.sku),
          matched: Boolean(manualBrands[item.id] ?? automaticBrand),
          settings: override?.settings || commonSettings,
          backgroundId: override?.backgroundId || selectedBackgroundId,
          customized: Boolean(override),
        };
      }),
    [
      images,
      parsed,
      manualBrands,
      overrides,
      commonSettings,
      selectedBackgroundId,
    ],
  );
  const editingItem = matchedImages.find((item) => item.id === editingId);
  const editingBackground = backgrounds.find(
    (item) => item.id === editingItem?.backgroundId,
  );
  const matchedCount = matchedImages.filter((item) => item.matched).length;

  function updateCommon(target, field, value) {
    setCommonSettings((current) => ({
      ...current,
      [target]: { ...current[target], [field]: value },
    }));
  }

  function updateOverride(itemId, target, patch) {
    setOverrides((current) => {
      const base = current[itemId]?.settings || cloneSettings(commonSettings);
      return {
        ...current,
        [itemId]: {
          ...current[itemId],
          settings: { ...base, [target]: { ...base[target], ...patch } },
        },
      };
    });
  }

  function addProductFiles(fileList) {
    const selected = Array.from(fileList || []);
    const supported = selected.filter(
      (file) =>
        /^image\/(png|jpeg|webp|gif|bmp|avif)$/i.test(file.type) ||
        /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name),
    );
    const existingKeys = new Set(
      imagesRef.current.map(
        (item) => `${item.file.name}-${item.file.size}-${item.file.lastModified}`,
      ),
    );
    const added = supported
      .filter((file) => {
        const key = `${file.name}-${file.size}-${file.lastModified}`;
        if (existingKeys.has(key)) return false;
        existingKeys.add(key);
        return true;
      })
      .map((file, index) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${Date.now()}-${index}`,
        file,
        filename: file.name,
        sku: skuFromFilename(file.name),
        url: URL.createObjectURL(file),
      }));
    if (added.length) setImages((current) => [...current, ...added]);
    const skipped = selected.length - added.length;
    setMessage(
      selected.length
        ? `제품 이미지 ${added.length}장을 추가했습니다.${skipped ? ` 중복·지원하지 않는 파일 ${skipped}장은 제외했습니다.` : ""} 모두 1000×1000 작업판에 자동 맞춤됩니다.`
        : "",
    );
  }

  function handleFiles(event) {
    addProductFiles(event.target.files);
    event.target.value = "";
  }

  function dropProductFiles(event) {
    event.preventDefault();
    setDragTarget("");
    addProductFiles(event.dataTransfer.files);
  }

  async function downloadItem(item) {
    if (!item.matched) return;
    const canvas = canvasMap.current.get(item.id) || editorCanvas.current;
    if (!canvas)
      throw new Error(`${item.filename}: 미리보기가 준비되지 않았습니다.`);
    const background = backgrounds.find((row) => row.id === item.backgroundId);
    await drawComposite(
      canvas,
      item.url,
      background?.objectUrl,
      item.brand,
      item.settings,
    );
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error("이미지 생성 실패")),
        "image/png",
      ),
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${item.filename.replace(/\.[^.]+$/, "")}.png`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function downloadAll() {
    const targets = matchedImages.filter((item) => item.matched);
    if (!targets.length) return;
    setBusy(true);
    let failed = 0;
    for (const item of targets) {
      try {
        await downloadItem(item);
      } catch {
        failed += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
    setBusy(false);
    setMessage(
      failed
        ? `${targets.length - failed}장 완료 · ${failed}장 실패`
        : `${targets.length}장 다운로드를 시작했습니다.`,
    );
  }

  function removeImage(itemId) {
    setImages((current) => {
      const removed = current.find((item) => item.id === itemId);
      if (removed) URL.revokeObjectURL(removed.url);
      return current.filter((item) => item.id !== itemId);
    });
    canvasMap.current.delete(itemId);
    setManualBrands((current) => {
      const next = { ...current };
      delete next[itemId];
      return next;
    });
    setOverrides((current) => {
      const next = { ...current };
      delete next[itemId];
      return next;
    });
    if (editingId === itemId) setEditingId("");
    setMessage("선택한 이미지를 작업 목록에서 제거했습니다.");
  }

  function resetAll() {
    images.forEach((item) => URL.revokeObjectURL(item.url));
    canvasMap.current.clear();
    localStorage.removeItem(STORAGE_KEY);
    setPasteText("");
    setCommonSettings(cloneSettings());
    setImages([]);
    setManualBrands({});
    setOverrides({});
    setEditingId("");
    setMessage("작업 데이터를 초기화했습니다. 저장된 배경은 유지됩니다.");
  }

  function resetSettings() {
    setCommonSettings(cloneSettings());
    setOverrides({});
    setMessage("모든 공통·개별 편집 설정을 기본값으로 초기화했습니다.");
  }

  return (
    <section className="page brand-image-maker-page">
      <div className="page-header">
        <div>
          <span className="brand-maker-eyebrow">IMAGE TOOL</span>
          <h1>브랜드 이미지 제작</h1>
          <p>저장된 배경, 제품 누끼, 브랜드명을 1000×1000 PNG로 합성합니다.</p>
        </div>
        <button type="button" className="ghost-button" onClick={resetAll}>
          작업 초기화
        </button>
      </div>
      <div className="brand-maker-privacy">
        <strong>배경만 서버에 저장됩니다.</strong>
        <span>
          제품 누끼와 완성 이미지는 현재 브라우저에서만 처리되며 서버로 전송되지
          않습니다.
        </span>
      </div>
      {error && <div className="alert">{error}</div>}

      <div className="brand-maker-setup three-columns">
        <section className="brand-maker-card">
          <div className="brand-maker-card-head">
            <div>
              <span>1</span>
              <div>
                <h2>SKU·브랜드 붙여넣기</h2>
                <p>마진차트의 두 열을 그대로 복사하세요.</p>
              </div>
            </div>
            <div className="brand-maker-card-actions">
              <b>{parsed.map.size}개 SKU</b>
              <button
                type="button"
                className="ghost-button compact"
                onClick={() => setPasteText("")}
                disabled={!pasteText}
              >
                초기화
              </button>
            </div>
          </div>
          <textarea
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder={"JK00335\tDIAR\nJK00336\tDIAR"}
          />
          {parsed.conflicts.size > 0 && (
            <p className="brand-maker-warning">
              브랜드가 다른 중복 SKU {parsed.conflicts.size}개는 확인이
              필요합니다.
            </p>
          )}
        </section>

        <section className="brand-maker-card">
          <div className="brand-maker-card-head">
            <div>
              <span>2</span>
              <div>
                <h2>배경 보관함</h2>
                <p>PNG는 서버에서 1000×1000으로 맞춰 저장됩니다.</p>
              </div>
            </div>
            <b>{backgrounds.length}장</b>
          </div>
          <label
            className={`brand-maker-dropzone compact ${dragTarget === "background" ? "dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragTarget("background");
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDragTarget("background");
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setDragTarget("");
            }}
            onDrop={dropBackgrounds}
          >
            <input
              type="file"
              accept="image/png"
              multiple
              onChange={uploadBackgrounds}
              disabled={busy}
            />
            <strong>{busy ? "처리 중" : "배경 PNG 추가"}</strong>
            <span>클릭하거나 PNG 파일을 여기에 끌어놓으세요</span>
          </label>
          <div className="brand-background-list">
            {backgrounds.map((item) => (
              <article
                className={item.id === selectedBackgroundId ? "selected" : ""}
                key={item.id}
              >
                <button
                  type="button"
                  className="brand-background-thumb"
                  onClick={() => chooseBackground(item.id)}
                >
                  <img src={item.objectUrl} alt="" />
                  <span>
                    {item.id === selectedBackgroundId ? "사용 중" : "선택"}
                  </span>
                </button>
                <input
                  defaultValue={item.name}
                  onBlur={(event) => renameBackground(item, event.target.value)}
                  aria-label={`${item.name} 이름`}
                />
                <button
                  type="button"
                  className={`brand-background-delete ${item.deleteArmed ? "armed" : ""}`}
                  onClick={() => deleteBackground(item)}
                >
                  {item.deleteArmed ? "삭제 확인" : "삭제"}
                </button>
              </article>
            ))}
          </div>
          {!backgrounds.length && (
            <div className="brand-background-empty">
              저장된 배경이 없습니다.
            </div>
          )}
        </section>

        <section className="brand-maker-card">
          <div className="brand-maker-card-head">
            <div>
              <span>3</span>
              <div>
                <h2>제품 누끼 업로드</h2>
                <p>SKU-c 형식의 PNG·JPG·WebP 이미지를 선택하세요.</p>
              </div>
            </div>
            <b>{images.length}장</b>
          </div>
          <label
            className={`brand-maker-dropzone ${dragTarget === "product" ? "dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragTarget("product");
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDragTarget("product");
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setDragTarget("");
            }}
            onDrop={dropProductFiles}
          >
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
              multiple
              onChange={handleFiles}
            />
            <strong>제품 이미지 선택 또는 드래그</strong>
            <span>여러 번 추가 가능 · 크기가 달라도 1000×1000에 자동 맞춤</span>
          </label>
        </section>
      </div>

      <section className="brand-maker-card brand-maker-template-card">
        <div className="brand-maker-card-head">
          <div>
            <span>4</span>
            <div>
              <h2>공통 설정</h2>
              <p>모든 이미지에 적용할 기본 제품 위치와 브랜드 틀입니다.</p>
            </div>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={resetSettings}
          >
            전체 설정 초기화
          </button>
        </div>
        <div className="brand-common-groups">
          <div>
            <strong>제품</strong>
            <div className="brand-maker-controls product-controls">
              <RangeField
                label="위쪽 (%)"
                value={commonSettings.product.top}
                onChange={(value) => updateCommon("product", "top", value)}
              />
              <RangeField
                label="왼쪽 (%)"
                value={commonSettings.product.left}
                onChange={(value) => updateCommon("product", "left", value)}
              />
              <RangeField
                label="크기 (%)"
                value={commonSettings.product.width}
                min={12}
                onChange={(value) => {
                  updateCommon("product", "width", value);
                  updateCommon("product", "height", value);
                }}
              />
            </div>
          </div>
          <div>
            <strong>브랜드명</strong>
            <div className="brand-maker-controls">
              <RangeField
                label="위쪽 (%)"
                value={commonSettings.brand.top}
                onChange={(value) => updateCommon("brand", "top", value)}
              />
              <RangeField
                label="왼쪽 (%)"
                value={commonSettings.brand.left}
                onChange={(value) => updateCommon("brand", "left", value)}
              />
              <RangeField
                label="틀 너비 (%)"
                value={commonSettings.brand.width}
                min={5}
                onChange={(value) => updateCommon("brand", "width", value)}
              />
              <RangeField
                label="틀 높이 (%)"
                value={commonSettings.brand.height}
                min={5}
                onChange={(value) => updateCommon("brand", "height", value)}
              />
              <label>
                글자 색상
                <input
                  type="color"
                  value={commonSettings.brand.color}
                  onChange={(event) =>
                    updateCommon("brand", "color", event.target.value)
                  }
                />
              </label>
              <label>
                기본 글씨체
                <select
                  value={commonSettings.brand.fontFamily}
                  onChange={(event) =>
                    updateCommon("brand", "fontFamily", event.target.value)
                  }
                >
                  {FONT_OPTIONS.map(([label, value]) => (
                    <option value={value} key={label}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="brand-maker-check">
                <input
                  type="checkbox"
                  checked={commonSettings.brand.shadow}
                  onChange={(event) =>
                    updateCommon("brand", "shadow", event.target.checked)
                  }
                />
                그림자
              </label>
            </div>
          </div>
        </div>
      </section>

      <section className="brand-maker-results">
        <div className="brand-maker-results-head">
          <div>
            <h2>합성 결과</h2>
            <p>
              연결 완료 {matchedCount}장 · 개별 수정{" "}
              {matchedImages.filter((item) => item.customized).length}장 · 연결
              필요 {images.length - matchedCount}장
            </p>
          </div>
          <button
            type="button"
            className="action-btn primary"
            onClick={downloadAll}
            disabled={!matchedCount || busy}
          >
            {busy ? "처리 중" : "전체 다운로드"}
          </button>
        </div>
        {matchedImages.length ? (
          <div className="brand-maker-grid">
            {matchedImages.map((item) => {
              const bg = backgrounds.find(
                (row) => row.id === item.backgroundId,
              );
              return (
                <article
                  className={`brand-maker-result ${item.matched ? "matched" : "unmatched"} ${item.customized ? "customized" : ""}`}
                  key={item.id}
                >
                  <button
                    type="button"
                    className="brand-maker-canvas-wrap"
                    onClick={() => {
                      setEditingId(item.id);
                      setEditTarget("brand");
                    }}
                  >
                    <PreviewCanvas
                      item={item}
                      backgroundUrl={bg?.objectUrl}
                      settings={item.settings}
                      canvasRef={(node) =>
                        node
                          ? canvasMap.current.set(item.id, node)
                          : canvasMap.current.delete(item.id)
                      }
                    />
                    <span>클릭해서 크게 편집</span>
                  </button>
                  <div className="brand-maker-result-info">
                    <div>
                      <strong>{item.sku || "SKU 인식 실패"}</strong>
                      <span>{item.filename}</span>
                    </div>
                    <span
                      className={`brand-maker-status ${item.matched ? "ok" : ""}`}
                    >
                      {item.customized
                        ? "개별 수정됨"
                        : item.matched
                          ? "연결 완료"
                          : item.conflict
                            ? "중복 확인"
                            : "브랜드 없음"}
                    </span>
                  </div>
                  <label>
                    브랜드명
                    <textarea
                      className="brand-name-textarea compact"
                      rows={2}
                      value={item.brand}
                      onChange={(event) =>
                        setManualBrands((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))
                      }
                      placeholder="직접 입력 가능 · Enter로 줄바꿈"
                    />
                  </label>
                  <div className="brand-maker-result-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!item.matched}
                      onClick={() => downloadItem(item)}
                    >
                      개별 다운로드
                    </button>
                    <button
                      type="button"
                      className="ghost-button danger"
                      onClick={() => removeImage(item.id)}
                    >
                      이미지 제거
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="brand-maker-empty">
            브랜드 목록과 제품 이미지를 준비하세요.
          </div>
        )}
      </section>
      {message && <div className="notice brand-maker-message">{message}</div>}

      {editingItem && (
        <div className="brand-editor-backdrop">
          <section className="brand-editor-panel">
            <header>
              <div>
                <span>INDIVIDUAL EDIT</span>
                <h2>{editingItem.sku} 개별 편집</h2>
                <p>
                  이미지 안의 틀을 끌어 이동하고 네 모서리 꼭지점으로 크기를
                  조절하세요.
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setEditingId("")}
                aria-label="닫기"
              >
                ×
              </button>
            </header>
            <div className="brand-editor-body">
              <div className="brand-editor-preview">
                <div className="brand-editor-stage" ref={editorStage}>
                  <PreviewCanvas
                    large
                    item={editingItem}
                    backgroundUrl={editingBackground?.objectUrl}
                    settings={editingItem.settings}
                    canvasRef={(node) => {
                      editorCanvas.current = node;
                    }}
                  />
                  <TransformBox
                    box={editingItem.settings[editTarget]}
                    target={editTarget}
                    stageRef={editorStage}
                    onChange={(box) =>
                      updateOverride(editingItem.id, editTarget, box)
                    }
                  />
                </div>
                <div className="brand-editor-mode">
                  <button
                    type="button"
                    className={editTarget === "product" ? "active" : ""}
                    onClick={() => setEditTarget("product")}
                  >
                    제품 이동·크기
                  </button>
                  <button
                    type="button"
                    className={editTarget === "brand" ? "active" : ""}
                    onClick={() => setEditTarget("brand")}
                  >
                    글자 이동·크기
                  </button>
                </div>
              </div>
              <aside className="brand-editor-settings">
                <label>
                  개별 배경
                  <select
                    value={editingItem.backgroundId}
                    onChange={(event) =>
                      setOverrides((current) => ({
                        ...current,
                        [editingItem.id]: {
                          ...current[editingItem.id],
                          settings:
                            current[editingItem.id]?.settings ||
                            cloneSettings(commonSettings),
                          backgroundId: event.target.value,
                        },
                      }))
                    }
                  >
                    {backgrounds.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                {editTarget === "product" ? (
                  <div className="brand-editor-field-grid">
                    <RangeField
                      label="위쪽 (%)"
                      value={editingItem.settings.product.top}
                      onChange={(value) =>
                        updateOverride(editingItem.id, "product", {
                          top: value,
                        })
                      }
                    />
                    <RangeField
                      label="왼쪽 (%)"
                      value={editingItem.settings.product.left}
                      onChange={(value) =>
                        updateOverride(editingItem.id, "product", {
                          left: value,
                        })
                      }
                    />
                    <RangeField
                      label="너비 (%)"
                      value={editingItem.settings.product.width}
                      min={12}
                      onChange={(value) =>
                        updateOverride(editingItem.id, "product", {
                          width: value,
                          height: value,
                        })
                      }
                    />
                  </div>
                ) : (
                  <>
                    <label>
                      브랜드명
                      <textarea
                        className="brand-name-textarea"
                        rows={3}
                        value={editingItem.brand}
                        onChange={(event) =>
                          setManualBrands((current) => ({
                            ...current,
                            [editingItem.id]: event.target.value,
                          }))
                        }
                        placeholder="Enter로 줄바꿈할 수 있습니다."
                      />
                    </label>
                    <div className="brand-editor-field-grid">
                      <RangeField
                        label="위쪽 (%)"
                        value={editingItem.settings.brand.top}
                        onChange={(value) =>
                          updateOverride(editingItem.id, "brand", {
                            top: value,
                          })
                        }
                      />
                      <RangeField
                        label="왼쪽 (%)"
                        value={editingItem.settings.brand.left}
                        onChange={(value) =>
                          updateOverride(editingItem.id, "brand", {
                            left: value,
                          })
                        }
                      />
                      <RangeField
                        label="틀 너비 (%)"
                        value={editingItem.settings.brand.width}
                        min={5}
                        onChange={(value) =>
                          updateOverride(editingItem.id, "brand", {
                            width: value,
                          })
                        }
                      />
                      <RangeField
                        label="틀 높이 (%)"
                        value={editingItem.settings.brand.height}
                        min={5}
                        onChange={(value) =>
                          updateOverride(editingItem.id, "brand", {
                            height: value,
                          })
                        }
                      />
                      <label>
                        글자 크기
                        <input
                          type="number"
                          min="6"
                          max="400"
                          value={editingItem.settings.brand.fontSize}
                          disabled={editingItem.settings.brand.autoFit}
                          onChange={(event) =>
                            updateOverride(editingItem.id, "brand", {
                              fontSize: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        글자 색상
                        <input
                          type="color"
                          value={editingItem.settings.brand.color}
                          onChange={(event) =>
                            updateOverride(editingItem.id, "brand", {
                              color: event.target.value,
                            })
                          }
                        />
                      </label>
                    </div>
                    <label className="brand-editor-checkbox">
                      <input
                        type="checkbox"
                        checked={editingItem.settings.brand.autoFit}
                        onChange={(event) =>
                          updateOverride(editingItem.id, "brand", {
                            autoFit: event.target.checked,
                          })
                        }
                      />
                      틀에 글자 크기 자동 맞춤
                    </label>
                  </>
                )}
              </aside>
            </div>
            <footer>
              <button
                type="button"
                className="ghost-button"
                onClick={() =>
                  setOverrides((current) => {
                    const next = { ...current };
                    delete next[editingItem.id];
                    return next;
                  })
                }
              >
                이 이미지 설정 초기화
              </button>
              <div>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    setCommonSettings(cloneSettings(editingItem.settings));
                    setOverrides({});
                  }}
                >
                  이 설정을 전체 적용
                </button>
                <button
                  type="button"
                  className="action-btn primary"
                  onClick={() => setEditingId("")}
                >
                  편집 완료
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
