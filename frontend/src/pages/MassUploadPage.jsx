export default function MassUploadPage() {
  return (
    <div className="page">
      <header className="page-header">
        <h1>대량등록</h1>
        <p>Shopee 공식 카테고리별 Mass Upload Excel Template을 채우는 도구입니다.</p>
        <p>/api/shopee-meta/status 확인 예정 (인증 사용자 기준).</p>
        <p>현재는 Dashboard read-only bridge 준비 단계입니다.</p>
        <p>상품 등록/수정/삭제 API는 제공하지 않습니다.</p>
        <p>대량등록 로컬 툴은 별도 repo에서 개발되며, 이후 이 페이지와 연결될 예정입니다.</p>
      </header>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>준비 상태 (Placeholder)</h2>
        <ul>
          <li>Dashboard API bridge</li>
          <li>공식 템플릿 업로드</li>
          <li>매핑</li>
          <li>엑셀 생성</li>
        </ul>
        <button type="button" disabled style={{ marginTop: 12 }}>
          Bridge 상태 확인 (준비중)
        </button>
      </section>
    </div>
  );
}
