import fs from 'node:fs';
import { ENV_PATH, LLM_API_BASE_URL, LLM_API_KEY, LLM_MODEL } from './config.js';
import { HttpError } from './errors.js';

/** 多模态模型在模型列表中的固定 id */
export const MULTIMODAL_MODEL_ID = 'multimodal-qwen';
export const MULTIMODAL_MODEL_NAME = 'Qwen3.8 Flash Next · 多模态';

export const DEFAULT_MULTIMODAL_PROMPT =
  '请判断这张图片是否由 AI 生成（伪造），还是真实照片（真实）。重点关注纹理细节、光影一致性、边缘与文字等生成痕迹。';

const REQUEST_TIMEOUT_MS = 300000;

const config = {
  baseUrl: LLM_API_BASE_URL.replace(/\/+$/, ''),
  apiKey: LLM_API_KEY,
  model: LLM_MODEL,
};

function maskedKey() {
  if (!config.apiKey) return '';
  const key = config.apiKey;
  if (key.length <= 8) return `${key.slice(0, 2)}****`;
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** 返回给前端的配置（不包含完整 API Key） */
export function getProviderSettings() {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    hasKey: Boolean(config.apiKey),
    maskedKey: maskedKey(),
  };
}

/** 把配置写回项目根目录的 .env，保留其他变量 */
function persistEnv() {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  } catch (error) {
    lines = [];
  }

  const values = new Map([
    ['LLM_API_BASE_URL', config.baseUrl],
    ['LLM_API_KEY', config.apiKey],
    ['LLM_MODEL', config.model],
  ]);
  const seen = new Set();

  const next = [];
  for (const line of lines) {
    const match = line.match(/^\s*(LLM_[A-Z_]+)\s*=/);
    if (match && values.has(match[1])) {
      if (!seen.has(match[1])) {
        next.push(`${match[1]}=${values.get(match[1])}`);
        seen.add(match[1]);
      }
      continue;
    }
    next.push(line);
  }

  for (const [key, value] of values) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }

  const text = `${next.join('\n').replace(/\n*$/, '')}\n`;
  try {
    fs.writeFileSync(ENV_PATH, text, 'utf8');
  } catch (error) {
    throw new HttpError(500, `无法写入 .env：${error.message}`);
  }
}

/** 关于页保存提供商设置 */
export function updateProviderSettings({ baseUrl, apiKey, model } = {}) {
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    const trimmed = baseUrl.trim().replace(/\/+$/, '');
    if (!/^http(s)?:\/\//i.test(trimmed)) {
      throw new HttpError(400, 'API Base URL 需要以 http:// 或 https:// 开头');
    }
    config.baseUrl = trimmed;
  }

  if (typeof apiKey === 'string' && apiKey.trim()) {
    config.apiKey = apiKey.trim();
  }

  if (typeof model === 'string' && model.trim()) {
    config.model = model.trim();
  }

  if (!config.baseUrl || !config.model) {
    throw new HttpError(400, 'API Base URL 和模型名称不能为空');
  }

  persistEnv();
  return getProviderSettings();
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function normalizeLabel(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/fake|伪造|生成|aigc|synthetic|ai[-_ ]?generated/.test(text)) return 'fake';
  if (/real|真实|照片|human|authentic|photo/.test(text)) return 'real';
  return null;
}

function normalizeConfidence(value, label) {
  let number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number > 1) number /= 100;
  return Math.min(1, Math.max(0, number));
}

/** 从模型回复中提取 JSON 判定结果 */
function parseVerdict(text) {
  const raw = String(text ?? '').trim();
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const candidates = [cleaned];

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate);
      const label = normalizeLabel(data.label ?? data.verdict ?? data.result);
      if (!label) continue;
      const confidence = normalizeConfidence(data.confidence ?? data.probability ?? data.score, label);
      return {
        label,
        confidence: confidence ?? 0.5,
        reason: typeof data.reason === 'string' ? data.reason.trim() : '',
      };
    } catch (error) {
      // 继续尝试下一个候选串
    }
  }

  // 兼容非 JSON 输出：按关键词判断
  const fallback = normalizeLabel(raw);
  if (fallback) {
    return { label: fallback, confidence: 0.5, reason: raw.slice(0, 200) };
  }
  return null;
}

/** 调用 OpenAI 兼容的多模态接口，返回真假与置信度 */
export async function detectWithProvider({ buffer, mime, prompt } = {}) {
  if (!config.apiKey) {
    throw new HttpError(400, '尚未配置多模态 API Key，请到“关于”页设置。');
  }
  if (!buffer) {
    throw new HttpError(400, '请上传一张图片');
  }

  const userPrompt = typeof prompt === 'string' && prompt.trim()
    ? prompt.trim()
    : DEFAULT_MULTIMODAL_PROMPT;
  const mimeType = mime && mime.startsWith('image/') ? mime : 'image/png';
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 600,
        messages: [
          {
            role: 'system',
            content: '你是 AI 生成图像鉴别专家。请根据图片与用户提示判断真伪，必须只输出 JSON：'
              + '{"label":"fake" 或 "real","confidence":0 到 1 之间的数字,"reason":"简要中文理由"}。'
              + 'label 为 fake 表示 AI 生成/伪造，real 表示真实拍摄。',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      const snippet = bodyText.slice(0, 200).replace(/\s+/g, ' ');
      throw new HttpError(502, `多模态接口请求失败（${response.status}）：${snippet || '无响应内容'}`);
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (error) {
      throw new HttpError(502, '多模态接口返回的不是合法 JSON');
    }

    const message = data?.choices?.[0]?.message;
    // 部分推理模型会把内容放在 reasoning_content，content 可能为空
    const content = contentToText(message?.content) || contentToText(message?.reasoning_content);
    const verdict = parseVerdict(content);
    if (!verdict) {
      throw new HttpError(502, `无法解析多模态模型输出：${content.slice(0, 120) || '空响应'}`);
    }

    const confidence = verdict.confidence;
    const fakeProbability = verdict.label === 'fake' ? confidence : 1 - confidence;
    const realProbability = 1 - fakeProbability;

    return {
      model: MULTIMODAL_MODEL_ID,
      modelDisplayName: MULTIMODAL_MODEL_NAME,
      label: verdict.label,
      confidence,
      reason: verdict.reason,
      prompt: userPrompt,
      fakeProbability: Number(fakeProbability.toFixed(6)),
      realProbability: Number(realProbability.toFixed(6)),
      elapsedMs: Date.now() - started,
      providerModel: config.model,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new HttpError(504, `多模态接口超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒）`);
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, `无法连接多模态接口：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}
