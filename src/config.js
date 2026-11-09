import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录 */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const WEIGHT_DIR = path.join(ROOT_DIR, 'weight');
export const ONNX_DIR = path.join(WEIGHT_DIR, 'onnx');
export const ENV_PATH = path.join(ROOT_DIR, '.env');

/** 读取项目根目录的 .env（存在时覆盖进程环境变量） */
function loadEnv() {
  let text = '';
  try {
    text = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (error) {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (!key) continue;
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnv();

export const PORT = Number(process.env.PORT) || 3100;
// 默认只监听本机；需要局域网访问时设置 HOST=0.0.0.0
export const HOST = process.env.HOST || '127.0.0.1';

/** 多模态检测提供商（OpenAI 兼容接口）默认配置 */
export const LLM_API_BASE_URL = process.env.LLM_API_BASE_URL || 'http://havensky.cn:6466/v1';
export const LLM_API_KEY = process.env.LLM_API_KEY || '';
export const LLM_MODEL = process.env.LLM_MODEL || 'qwen3.8-flash-next-iq3_s';

export const IMAGE_SIZE = 224;
export const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
export const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** CPU 推理线程数：留一点余量给 Node 事件循环 */
export const INFERENCE_THREADS = Math.max(1, Math.min(os.cpus().length - 1, 8));
