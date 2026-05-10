# Shopee Dashboard DB Schema Snapshot

이 문서는 Codex 개발 참고용 DB 구조 스냅샷입니다.

포함하는 것:
- 테이블 목록
- 주요 테이블 컬럼 구조

포함하지 않는 것:
- 실제 주문 데이터
- 고객 정보
- access_token 실제값
- refresh_token 실제값
- Partner Key 실제값
- .env 실제값
- DB dump

생성일:
2026-05-10 13:41:26 UTC

## Tables

exchange_rates
inventory_allocations
inventory_batches
inventory_movements
jobs
main_account
margin_chart_items
order_items
orders
product_cost_history
products
shipping_labels
shops
sku_compositions
sync_logs
tenant_google_sheet_settings
tenant_users
tenants
users

## orders

Field	Type	Null	Key	Default	Extra
id	int(11)	NO	PRI	NULL	auto_increment
tenant_id	bigint(20)	NO		1	
shop_id	bigint(20)	NO	MUL	NULL	
region	varchar(5)	YES	MUL	NULL	
order_sn	varchar(50)	NO	MUL	NULL	
order_status	varchar(30)	YES		NULL	
display_status	varchar(30)	YES		NULL	
display_status_reason	varchar(255)	YES		NULL	
display_status_checked_at	datetime	YES		NULL	
is_final_status	tinyint(1)	YES	MUL	0	
merchandise_subtotal	decimal(12,2)	YES		NULL	
total_amount	decimal(12,2)	YES		NULL	
currency	varchar(10)	YES		NULL	
original_price	decimal(12,2)	YES		NULL	
seller_discount	decimal(12,2)	YES		NULL	
voucher_from_seller	decimal(12,2)	YES		NULL	
voucher_from_shopee	decimal(12,2)	YES		NULL	
coins_offset	decimal(12,2)	YES		NULL	
buyer_total_amount	decimal(12,2)	YES		NULL	
shipping_carrier	varchar(100)	YES		NULL	
tracking_number	varchar(100)	YES		NULL	
shipping_fee	decimal(12,2)	YES		NULL	
shipping_fee_discount	decimal(12,2)	YES		NULL	
actual_shipping_fee	decimal(12,2)	YES		NULL	
estimated_shipping_fee	decimal(12,2)	YES		NULL	
order_chargeable_weight_gram	int(11)	YES		NULL	
commission_fee	decimal(12,2)	YES		NULL	
service_fee	decimal(12,2)	YES		NULL	
transaction_fee	decimal(12,2)	YES		NULL	
escrow_amount	decimal(12,2)	YES		NULL	
create_time	int(11)	YES		NULL	
order_created_at	datetime	YES	MUL	NULL	
update_time	int(11)	YES		NULL	
synced_at	datetime	YES		current_timestamp()	
total_cost_price	decimal(12,2)	YES		NULL	
total_discounted_price	decimal(12,2)	YES		NULL	
total_vat	decimal(12,2)	YES		NULL	
net_profit	decimal(12,2)	YES		NULL	
product_profit	decimal(12,2)	YES		NULL	
margin_status	enum('pending','confirmed','cancelled')	YES		pending	

## order_items

Field	Type	Null	Key	Default	Extra
id	int(11)	NO	PRI	NULL	auto_increment
tenant_id	bigint(20)	NO		1	
order_sn	varchar(50)	NO	MUL	NULL	
shop_id	bigint(20)	NO		NULL	
item_id	bigint(20)	YES		NULL	
item_name	varchar(500)	YES		NULL	
item_sku	varchar(100)	YES		NULL	
model_id	bigint(20)	YES		NULL	
model_name	varchar(200)	YES		NULL	
model_sku	varchar(100)	YES		NULL	
model_quantity_purchased	int(11)	YES		NULL	
model_original_price	decimal(12,2)	YES		NULL	
model_discounted_price	decimal(12,2)	YES		NULL	
image_info_image_url	varchar(500)	YES		NULL	
item_image_url	varchar(500)	YES		NULL	
cost_price_at_order	decimal(12,2)	YES		NULL	
discounted_price_at_order	decimal(12,2)	YES		NULL	
vat_at_order	decimal(12,2)	YES		NULL	

## products

Field	Type	Null	Key	Default	Extra
id	int(11)	NO	PRI	NULL	auto_increment
tenant_id	bigint(20)	NO		1	
sku	varchar(30)	NO	UNI	NULL	
brand	varchar(200)	YES		NULL	
product_name_en	text	YES		NULL	
option_name	varchar(200)	YES		NULL	
product_name_kr	varchar(200)	YES		NULL	
weight	decimal(8,2)	YES		NULL	
cost_price_with_vat	decimal(12,2)	YES		NULL	
supply_rate	decimal(5,2)	YES		NULL	
discounted_price_with_vat	decimal(12,2)	YES		NULL	
cost_price	decimal(12,2)	YES		NULL	
vat	decimal(12,2)	YES		NULL	
created_at	timestamp	NO		current_timestamp()	
updated_at	timestamp	NO		current_timestamp()	on update current_timestamp()
stock_quantity	int(11)	NO		0	
low_stock_threshold	int(11)	NO		3	
stock_tracking_started_at	datetime	YES		NULL	

## margin_chart_items

Field	Type	Null	Key	Default	Extra
tenant_id	bigint(20)	NO	PRI	NULL	
sku	varchar(50)	NO	PRI	NULL	
brand	varchar(200)	YES		NULL	
product_name_en	text	YES		NULL	
option_name	varchar(200)	YES		NULL	
product_name_kr	varchar(200)	YES		NULL	
weight	decimal(10,2)	YES		NULL	
cost_price_with_vat	decimal(12,2)	YES		NULL	
supply_rate	decimal(8,4)	YES		NULL	
discounted_price_with_vat	decimal(12,2)	YES		NULL	
cost_price	decimal(12,2)	YES		NULL	
vat	decimal(12,2)	YES		NULL	
price_sg	decimal(12,2)	YES		NULL	
price_tw	decimal(12,2)	YES		NULL	
price_my	decimal(12,2)	YES		NULL	
price_ph	decimal(12,2)	YES		NULL	
price_th	decimal(12,2)	YES		NULL	
price_vn	decimal(12,2)	YES		NULL	
source_row	int(11)	YES		NULL	
is_active	tinyint(1)	NO		1	
synced_at	datetime	YES	MUL	NULL	
created_at	timestamp	NO		current_timestamp()	
updated_at	timestamp	NO		current_timestamp()	on update current_timestamp()

## shops

Field	Type	Null	Key	Default	Extra
id	int(11)	NO	PRI	NULL	auto_increment
tenant_id	bigint(20)	NO		1	
main_account_id	int(11)	NO		NULL	
shop_id	bigint(20)	NO	UNI	NULL	
shop_name	varchar(200)	YES		NULL	
region	varchar(5)	YES		NULL	
alias	varchar(50)	YES		NULL	
is_active	tinyint(1)	YES		0	
access_token	text	YES		NULL	
refresh_token	text	YES		NULL	
token_expires_at	datetime	YES		NULL	
token_status	enum('active','expired','none')	NO		none	
created_at	datetime	YES		current_timestamp()	
updated_at	datetime	YES		current_timestamp()	on update current_timestamp()

## main_account

Field	Type	Null	Key	Default	Extra
id	int(11)	NO	PRI	NULL	auto_increment
tenant_id	bigint(20)	NO		1	
partner_id	bigint(20)	NO		NULL	
partner_key	varchar(200)	NO		NULL	
main_account_id	bigint(20)	YES		NULL	
merchant_id	bigint(20)	YES		NULL	
access_token	text	YES		NULL	
refresh_token	text	YES		NULL	
token_expires_at	datetime	YES		NULL	
refresh_expires_at	datetime	YES		NULL	
token_status	enum('active','expired')	YES		active	
created_at	datetime	YES		current_timestamp()	
updated_at	datetime	YES		current_timestamp()	on update current_timestamp()
auth_shop_id	bigint(20)	YES		NULL	

## tenants

Field	Type	Null	Key	Default	Extra
id	bigint(20)	NO	PRI	NULL	
code	varchar(64)	NO	UNI	NULL	
name	varchar(255)	NO		NULL	
requested_main_account_id	bigint(20)	YES		NULL	
is_active	tinyint(1)	NO		1	
approval_status	enum('pending','approved','rejected','suspended')	NO		pending	
approved_at	datetime	YES		NULL	
approved_by_user_id	bigint(20)	YES		NULL	
rejected_at	datetime	YES		NULL	
rejection_reason	varchar(255)	YES		NULL	
created_at	datetime	NO		current_timestamp()	
updated_at	datetime	NO		current_timestamp()	on update current_timestamp()

