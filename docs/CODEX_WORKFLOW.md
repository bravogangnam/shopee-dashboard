# Codex Workflow for Shopee Dashboard

## 목적

이 저장소는 Shopee Dashboard 개발을 GitHub + Codex 중심으로 진행하기 위한 저장소입니다.

Codex는 운영 VPS나 운영 MySQL DB에 직접 접근할 수 없다고 가정합니다.
Codex는 GitHub repo 안의 소스코드, docs 문서, schema snapshot을 기준으로 작업해야 합니다.

## 작업 전 반드시 읽을 문서

Codex는 작업 전 아래 파일을 먼저 확인해야 합니다.

- docs/DB_SCHEMA_SNAPSHOT.md
- docs/SHOPEE_API_TOKEN_STRUCTURE.md
- backend/src/routes/ordersRoutes.js
- backend/src/routes/authRoutes.js
- backend/src/services/shopeeAuth.js
- frontend/src/pages/OrderManagementPage.jsx
- frontend/src/pages/LedgerPage.jsx
- frontend/src/pages/SettingsPage.jsx

## 절대 금지

Codex는 아래 작업을 하면 안 됩니다.

- .env 수정 또는 출력
- backend/.env 수정 또는 출력
- Partner Key 출력
- access_token 출력
- refresh_token 출력
- 실제 Shopee API 호출
- DB UPDATE / INSERT / DELETE
- PM2 restart
- npm build
- frontend/build 수정 또는 커밋
- frontend/build-backup-* 수정 또는 커밋
- git add .
- git reset --hard
- git checkout origin/main -- 파일
- git pull

## 허용 작업

- 소스코드 수정
- docs 수정
- schema snapshot 참고
- backend JS 문법 확인
- git diff 확인
- 필요한 파일만 명시적으로 git add 제안

## 완료 보고 형식

Codex는 작업 후 아래 형식으로 보고해야 합니다.

1. 수정한 파일 목록
2. 변경한 기능 요약
3. backend 변경 내용
4. frontend 변경 내용
5. 사용한 DB 컬럼
6. 기존 기능 호환 여부
7. 문법 확인 결과
8. 테스트하지 못한 부분
9. 금지 작업을 하지 않았는지 여부
10. git diff 요약

## 배포

Codex는 직접 운영 서버 배포를 하지 않습니다.
운영 반영은 별도 배포 절차 또는 GitHub Actions를 통해 진행합니다.
