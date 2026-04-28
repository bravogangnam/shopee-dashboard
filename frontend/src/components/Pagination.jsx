export default function Pagination({ pagination, onPageChange }) {
  if (!pagination) return null;

  const { page, total_pages: totalPages, total, page_size: pageSize } = pagination;
  const start = total === 0 ? 0 : ((page - 1) * pageSize) + 1;
  const end = Math.min(total, page * pageSize);

  return (
    <div className="pagination">
      <span>{start}-{end} / 총 {total}건</span>
      <div className="pagination-actions">
        <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          이전
        </button>
        <strong>{page}</strong>
        <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          다음
        </button>
      </div>
    </div>
  );
}
