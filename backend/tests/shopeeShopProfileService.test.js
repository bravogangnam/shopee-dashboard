const assert = require('assert');
const { normalizeShopProfile } = require('../src/services/shopeeShopProfileService');

function run() {
  const profile = normalizeShopProfile({
    shopId: 1592998908,
    profileData: { response: { shop_name: 'GANGNAMCOS', shop_logo: 'https://cdn.example/logo.png' } },
    shopInfoData: { response: { region: 'sg' } },
  });
  assert.strictEqual(profile.shop_id, '1592998908');
  assert.strictEqual(profile.shop_name, 'GANGNAMCOS');
  assert.strictEqual(profile.region, 'SG');
  assert.strictEqual(profile.shop_logo_url, 'https://cdn.example/logo.png');

  const countryFallback = normalizeShopProfile({
    shopId: 1,
    profileData: { response: { shop_name: 'Fallback Shop' } },
    shopInfoData: { response: { country: 'my' } },
  });
  assert.strictEqual(countryFallback.region, 'MY');

  const empty = normalizeShopProfile({
    shopId: 2,
    profileData: { response: { shop_name: '   ', shop_logo: '' } },
    shopInfoData: { response: { region: '' } },
  });
  assert.strictEqual(empty.shop_name, null);
  assert.strictEqual(empty.region, null);
  assert.strictEqual(empty.shop_logo_url, null);
  assert.ok(!Object.prototype.hasOwnProperty.call(empty, 'alias'));

  console.log('shopeeShopProfileService normalization tests passed');
}

run();
