const assert = require('assert');
const sharp = require('sharp');
const {
  addBackgrounds,
  deleteBackground,
  deleteTenantBackgrounds,
  getBackgroundFile,
  listBackgrounds,
  updateBackground,
} = require('../src/services/brandBackgroundService');

(async () => {
  const tenantId = 900000000 + Math.floor(Math.random() * 99999999);
  try {
    const firstPng = await sharp({ create: { width: 420, height: 700, channels: 4, background: '#ff3366' } }).png().toBuffer();
    const secondPng = await sharp({ create: { width: 1200, height: 600, channels: 4, background: '#3366ff' } }).png().toBuffer();
    const added = await addBackgrounds(tenantId, [
      { originalname: '분홍 배경.png', buffer: firstPng },
      { originalname: '파랑 배경.png', buffer: secondPng },
    ]);
    assert.strictEqual(added.length, 2);
    assert.strictEqual(added[0].isDefault, true);
    assert.strictEqual(added[1].isDefault, false);

    const savedMetadata = await sharp(await getBackgroundFile(tenantId, added[0].id)).metadata();
    assert.deepStrictEqual([savedMetadata.width, savedMetadata.height, savedMetadata.format], [1000, 1000, 'png']);

    await updateBackground(tenantId, added[0].id, { name: '대표 배경' });
    await updateBackground(tenantId, added[1].id, { isDefault: true });
    const rows = await listBackgrounds(tenantId);
    assert.strictEqual(rows[0].name, '대표 배경');
    assert.strictEqual(rows[0].isDefault, false);
    assert.strictEqual(rows[1].isDefault, true);

    assert.strictEqual(await deleteBackground(tenantId, added[1].id), true);
    const remaining = await listBackgrounds(tenantId);
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].isDefault, true);
    console.log('brand background storage tests passed');
  } finally {
    await deleteTenantBackgrounds(tenantId);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
