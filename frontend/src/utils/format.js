export function isBlank(value) {
  return value === null || value === undefined || value === '';
}

export function formatNumber(value, digits = 2) {
  if (isBlank(value)) return '-';
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return number.toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatCurrency(value, currency) {
  if (isBlank(value)) return '-';
  const suffix = currency ? ` ${currency}` : '';
  return `${formatNumber(value, 2)}${suffix}`;
}

export function formatKrw(value) {
  if (isBlank(value)) return '-';
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return `₩${Math.round(number).toLocaleString('ko-KR')}`;
}

export function formatDateTime(value) {
  if (isBlank(value)) return '-';
  return String(value).replace('T', ' ').replace('.000Z', '');
}

export function profitTone(value) {
  if (isBlank(value)) return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  if (number < 0) return 'negative';
  if (number > 0) return 'positive';
  return '';
}
