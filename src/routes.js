import { Router } from 'express';
import multer from 'multer';
import { MAX_UPLOAD_BYTES } from './config.js';
import { HttpError, asyncHandler } from './errors.js';
import { imageToTensor } from './image.js';
import { modelManager } from './models.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_UPLOAD_BYTES },
});

export const api = Router();

api.get('/models', asyncHandler(async (req, res) => {
  res.json(await modelManager.list());
}));

api.post('/models/:id/load', asyncHandler(async (req, res) => {
  const model = await modelManager.startLoad(req.params.id);
  res.status(202).json({ model });
}));

api.post('/detect', upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new HttpError(400, '请上传一张图片');
  }

  // 文件名由前端单独传递，避免 multipart 对中文文件名编码不一致
  const name = typeof req.body.name === 'string' && req.body.name
    ? req.body.name
    : req.file.originalname;

  const tensor = await imageToTensor(req.file.buffer);
  const result = await modelManager.infer(tensor);

  res.json({ file: name, model: modelManager.activeId, ...result });
}));
