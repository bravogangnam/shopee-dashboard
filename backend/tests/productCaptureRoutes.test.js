const assert = require('assert');
const { isAllowedImageUrl, safeFilename } = require('../src/utils/productCaptureImage');

assert.strictEqual(isAllowedImageUrl('https://down-sg.img.susercontent.com/file/abc'), true);
assert.strictEqual(isAllowedImageUrl('https://cf.shopee.sg/file/abc'), true);
assert.strictEqual(isAllowedImageUrl('https://shop-phinf.pstatic.net/20260101/image.jpg'), true);
assert.strictEqual(isAllowedImageUrl('http://down-sg.img.susercontent.com/file/abc'), false);
assert.strictEqual(isAllowedImageUrl('https://susercontent.com.example.org/file/abc'), false);
assert.strictEqual(isAllowedImageUrl('https://127.0.0.1/file/abc'), false);
assert.strictEqual(safeFilename('옵션/블랙:*?'), '옵션블랙');
assert.ok(safeFilename('a'.repeat(100)).length <= 60);

console.log('productCaptureRoutes tests passed');
