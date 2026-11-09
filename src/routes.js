import { Router } from 'express';
import multer from 'multer';
import { MAX_UPLOAD_BYTES } from './config.js';
import { HttpError, asyncHandler } from './errors.js';
import { imageToTensor } from './image.js';
import { modelManager } from './models.js';
import {
  MULTIMODAL_MODEL_ID,
  detectWithProvider,
  getProviderSettings,
  updateProviderSettings,
} from './multimodal.js';

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

api.post('/models/:id/unload', asyncHandler(async (req, res) => {
  const model = await modelManager.unload(req.params.id);
  res.json({ model });
}));

/** 多模态提供商设置（Base URL / 模型 / 是否已配置 Key） */
api.get('/multimodal/config', asyncHandler(async (req, res) => {
  res.json(getProviderSettings());
}));

api.post('/multimodal/config', asyncHandler(async (req, res) => {
  res.json(updateProviderSettings(req.body ?? {}));
}));

api.post('/detect', upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new HttpError(400, '请上传一张图片');
  }

  // 文件名由前端单独传递，避免 multipart 对中文文件名编码不一致
  const name = typeof req.body.name === 'string' && req.body.name
    ? req.body.name
    : req.file.originalname;

  // 指定本次推理使用的模型；未指定时使用最后加载的模型
  const modelId = typeof req.body.model === 'string' && req.body.model ? req.body.model : undefined;

  // 多模态模型通过外部 API 判定，不经过 ONNX 预处理
  if (modelId === MULTIMODAL_MODEL_ID) {
    const result = await detectWithProvider({
      buffer: req.file.buffer,
      mime: req.file.mimetype,
      prompt: typeof req.body.prompt === 'string' ? req.body.prompt : '',
    });
    res.json({ file: name, ...result });
    return;
  }

  const tensor = await imageToTensor(req.file.buffer);
  const result = await modelManager.infer(tensor, modelId);

  res.json({ file: name, ...result });
}));
