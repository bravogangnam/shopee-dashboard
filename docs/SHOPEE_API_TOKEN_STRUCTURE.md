# Shopee API Token Structure

## 핵심 원칙

Shopee OAuth는 main_account 기준으로 시작하지만, 실제 운영 API는 shop_id별 shops token으로 수행합니다.

- main_account token: OAuth / 재인증 / 계정 연결 기준
- shops token: 주문, 송장, 배송, 상품 API 호출 기준

## 운영 API

운영 API는 반드시 아래 조합을 사용합니다.

- shop_id
- shops.access_token

main_account.access_token을 주문/송장/배송/상품 API의 기본 토큰으로 사용하면 안 됩니다.

## Token Refresh

정상 refresh 기준:

- shops.refresh_token
- shop_id

refresh 후 새 access_token과 새 refresh_token을 shops 테이블에 저장해야 합니다.

refresh_token은 refresh 때마다 rotate될 수 있으므로 이전 refresh_token을 재사용하면 실패할 수 있습니다.

## 잘못된 방식

아래 방식은 피해야 합니다.

- main_account.refresh_token으로 여러 shop_id를 refresh
- main_account.access_token으로 shop API 호출
- refresh 후 새 refresh_token 저장 누락
- token 원문 로그 출력

## OAuth Callback

state가 있으면 state 검증을 합니다.

state가 없고 main_account_id가 있을 경우:
- approved tenant와 main_account_id가 정확히 1개 매칭될 때만 fallback 허용
- 0개 또는 2개 이상이면 거절

## 설정 화면

설정 화면 token status는 main_account만 보지 말고 active shop token 기준으로 판단해야 합니다.

main_account가 expired여도 active shop token이 있으면 운영 API는 정상일 수 있습니다.
