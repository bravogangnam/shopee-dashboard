const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
});

const db = require('../src/config/database');
const {
  getOrRefreshShopToken,
} = require('../src/services/shopeeAuth');
const {
  syncReturnWindow,
} = require('../src/services/shopeeReturn');
const {
  sleep,
} = require('../src/utils/apiWrapper');

function unixSeconds(value) {
  return Math.floor(value.getTime() / 1000);
}

function isoDate(unixValue) {
  return new Date(unixValue * 1000)
    .toISOString()
    .slice(0, 10);
}

async function main() {
  const tenantId = Number(
    process.env.RETURN_BACKFILL_TENANT_ID || 1
  );

  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    throw new Error(
      'RETURN_BACKFILL_TENANT_ID must be a positive number'
    );
  }

  const start = unixSeconds(
    new Date('2026-01-01T00:00:00+09:00')
  );

  const requestedEnd = unixSeconds(
    new Date('2026-12-31T23:59:59+09:00')
  );

  const now = Math.floor(Date.now() / 1000);
  const end = Math.min(requestedEnd, now);

  if (end < start) {
    console.log(
      '[ReturnBackfill] 현재 시간이 2026-01-01 이전입니다.'
    );
    return;
  }

  const [shops] = await db.query(
    `SELECT shop_id, alias, region
       FROM shops
      WHERE tenant_id = ?
        AND is_active = 1
      ORDER BY id ASC`,
    [tenantId]
  );

  if (!shops.length) {
    throw new Error(
      `No active shops found for tenant_id=${tenantId}`
    );
  }

  console.log('='.repeat(70));
  console.log(
    `[ReturnBackfill] START tenant=${tenantId}` +
    ` range=${isoDate(start)}~${isoDate(end)}`
  );
  console.log(
    `[ReturnBackfill] shops=${shops.length}`
  );
  console.log('='.repeat(70));

  let grandListed = 0;
  let grandSynced = 0;

  /*
   * API 최대 범위가 15일이므로,
   * 양 끝 포함 기준 15일이 넘지 않도록 -1초 처리한다.
   */
  const windowSeconds = (15 * 86400) - 1;

  for (const shop of shops) {
    const shopAlias =
      shop.alias ||
      shop.region ||
      String(shop.shop_id);

    console.log('');
    console.log(
      `[ReturnBackfill] SHOP START` +
      ` ${shopAlias}` +
      ` (${shop.shop_id})`
    );

    const accessToken = await getOrRefreshShopToken(
      shop.shop_id
    );

    if (!accessToken) {
      console.error(
        `[ReturnBackfill] SKIP shop=${shopAlias}` +
        ` token unavailable`
      );
      continue;
    }

    let cursor = start;
    let shopListed = 0;
    let shopSynced = 0;
    let windowNumber = 0;

    while (cursor <= end) {
      windowNumber += 1;

      const windowEnd = Math.min(
        cursor + windowSeconds,
        end
      );

      console.log(
        `[ReturnBackfill] shop=${shopAlias}` +
        ` window=${windowNumber}` +
        ` ${isoDate(cursor)}~${isoDate(windowEnd)}`
      );

      try {
        const result = await syncReturnWindow({
          tenantId,
          shopId: shop.shop_id,
          accessToken,
          timeFrom: cursor,
          timeTo: windowEnd,
          timeField: 'create_time',
        });

        shopListed += result.listed;
        shopSynced += result.synced;

        console.log(
          `[ReturnBackfill] shop=${shopAlias}` +
          ` window=${windowNumber}` +
          ` listed=${result.listed}` +
          ` synced=${result.synced}`
        );
      } catch (error) {
        console.error(
          `[ReturnBackfill] shop=${shopAlias}` +
          ` window=${windowNumber}` +
          ` ERROR=${error.message}`
        );

        /*
         * 한 구간 실패가 전체 백필을 중단시키지 않도록
         * 다음 15일 구간으로 계속 진행한다.
         */
      }

      cursor = windowEnd + 1;

      if (cursor <= end) {
        await sleep(700);
      }
    }

    grandListed += shopListed;
    grandSynced += shopSynced;

    console.log(
      `[ReturnBackfill] SHOP END` +
      ` ${shopAlias}` +
      ` listed=${shopListed}` +
      ` synced=${shopSynced}`
    );
  }

  console.log('');
  console.log('='.repeat(70));
  console.log(
    `[ReturnBackfill] DONE` +
    ` listed=${grandListed}` +
    ` synced=${grandSynced}`
  );
  console.log('='.repeat(70));
}

main()
  .then(async () => {
    try {
      await db.end();
    } catch (_) {
      // ignore
    }

    process.exit(0);
  })
  .catch(async error => {
    console.error(
      `[ReturnBackfill] FATAL: ${error.stack || error.message}`
    );

    try {
      await db.end();
    } catch (_) {
      // ignore
    }

    process.exit(1);
  });
