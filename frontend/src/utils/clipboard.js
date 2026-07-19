export function normalizeClipboardText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
