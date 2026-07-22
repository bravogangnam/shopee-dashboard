const express = require('express');
const multer = require('multer');
const { requireAuth, requireApprovedTenant } = require('../middleware/auth');
const { getCurrentTenantId } = require('../config/tenant');
const { addBackgrounds, deleteBackground, getBackgroundFile, listBackgrounds, updateBackground } = require('../services/brandBackgroundService');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, callback) => callback(null, file.mimetype === 'image/png'),
});

router.use(requireAuth);
router.use(requireApprovedTenant);

router.get('/backgrounds', async (req, res) => {
  res.json({ success: true, backgrounds: await listBackgrounds(getCurrentTenantId(req)) });
});

router.post('/backgrounds', upload.array('backgrounds', 12), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ success: false, error: '등록할 PNG 배경을 선택하세요.' });
  const backgrounds = await addBackgrounds(getCurrentTenantId(req), req.files);
  return res.status(201).json({ success: true, backgrounds });
});

router.patch('/backgrounds/:id', async (req, res) => {
  const background = await updateBackground(getCurrentTenantId(req), String(req.params.id), {
    name: req.body?.name,
    isDefault: req.body?.isDefault,
  });
  if (!background) return res.status(404).json({ success: false, error: '배경을 찾을 수 없습니다.' });
  return res.json({ success: true, background });
});

router.delete('/backgrounds/:id', async (req, res) => {
  const deleted = await deleteBackground(getCurrentTenantId(req), String(req.params.id));
  if (!deleted) return res.status(404).json({ success: false, error: '배경을 찾을 수 없습니다.' });
  return res.json({ success: true });
});

router.get('/backgrounds/:id/file', async (req, res) => {
  const file = await getBackgroundFile(getCurrentTenantId(req), String(req.params.id));
  if (!file) return res.status(404).json({ success: false, error: '배경을 찾을 수 없습니다.' });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.sendFile(file);
});

module.exports = router;
