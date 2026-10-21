import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录 */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const WEIGHT_DIR = path.join(ROOT_DIR, 'weight');
export const ONNX_DIR = path.join(WEIGHT_DIR, 'onnx');

export const PORT = Number(process.env.PORT) || 3000;
// 默认只监听本机；需要局域网访问时设置 HOST=0.0.0.0
export const HOST = process.env.HOST || '127.0.0.1';

export const IMAGE_SIZE = 224;
export const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
export const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** CPU 推理线程数：留一点余量给 Node 事件循环 */
export const INFERENCE_THREADS = Math.max(1, Math.min(os.cpus().length - 1, 8));
