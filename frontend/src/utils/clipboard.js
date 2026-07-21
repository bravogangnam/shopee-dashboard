export function normalizeClipboardText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((row) => row
      .split('\t')
      .map((cell) => cell.replace(/[\f\v \u00a0]+/g, ' ').trim())
      .join('\t'))
    .join('\n')
    .trim();
}
