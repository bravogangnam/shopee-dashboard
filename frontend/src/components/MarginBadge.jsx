const LABELS = {
  confirmed: '확정',
  pending: '대기',
  cancelled: '취소',
};

export default function MarginBadge({ status }) {
  const key = status || 'pending';
  return <span className={`badge badge-${key}`}>{LABELS[key] || key}</span>;
}
