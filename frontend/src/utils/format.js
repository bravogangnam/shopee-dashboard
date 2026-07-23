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

function formatDateInSeoul(date) {
  if (Number.isNaN(date.getTime())) return '-';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date).map((part) => [part.type, part.value])
  );

  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

export function formatUnixDateTimeKst(value) {
  if (isBlank(value)) return '-';
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return '-';
  return formatDateInSeoul(new Date(seconds * 1000));
}

export function formatDateTime(value) {
  if (isBlank(value)) return '-';
  const rawValue = String(value);
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/.test(rawValue);

  if (!hasTimezone) {
    return rawValue.replace('T', ' ').replace('.000', '');
  }

  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    return rawValue.replace('T', ' ').replace('.000Z', '');
  }

  return formatDateInSeoul(date);
}

export function profitTone(value) {
  if (isBlank(value)) return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  if (number < 0) return 'negative';
  if (number > 0) return 'positive';
  return '';
}
