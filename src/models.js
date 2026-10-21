import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { INFERENCE_THREADS, ONNX_DIR, WEIGHT_DIR } from './config.js';
import { HttpError } from './errors.js';

const IDLE_STATE = Object.freeze({ status: 'idle', phase: 'idle', progress: 0, error: null, loadMs: null });

const TRAINING_SET_LABELS = {
  chameleon: 'Chameleon',
  faceforensic: 'FaceForensics++',
  sdv14: 'SD 1.4 (GenImage)',
};

function displayName(id) {
  const suffix = id.split(/trainOn_/i).pop() ?? id;
  const label = TRAINING_SET_LABELS[suffix.toLowerCase()] ?? suffix;
  return `Effort CLIP-L/14 · ${label}`;
}

/**
 * 负责扫描权重、按需加载 ONNX 会话、串行执行推理。
 * 同一时间只保留一个已加载模型，避免多个 1.1GB 会话占满内存。
 */
class ModelManager {
  #states = new Map();
  #session = null;
  #activeId = null;
  #loadingId = null;
  #queue = Promise.resolve();

  get activeId() {
    return this.#activeId;
  }

  /** 扫描 weight 目录，返回模型列表及当前加载状态 */
  async list() {
    const entries = await fsp.readdir(WEIGHT_DIR, { withFileTypes: true }).catch(() => []);
    const models = [];

    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.pth') continue;

      const id = path.basename(entry.name, path.extname(entry.name));
      const [pthStat, onnxStat] = await Promise.all([
        fsp.stat(path.join(WEIGHT_DIR, entry.name)).catch(() => null),
        fsp.stat(path.join(ONNX_DIR, `${id}.onnx`)).catch(() => null),
      ]);

      const state = this.#snapshot(id);
      models.push({
        id,
        displayName: displayName(id),
        pthSize: pthStat?.size ?? null,
        onnxAvailable: Boolean(onnxStat),
        onnxSize: onnxStat?.size ?? null,
        ...state,
      });
    }

    return {
      activeId: this.#activeId,
      models: models.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
  }

  /** 开始后台加载模型；返回当前快照，前端通过轮询获取进度 */
  async startLoad(id) {
    if (this.#loadingId) {
      throw new HttpError(409, `模型 ${this.#loadingId} 正在加载，请稍候`);
    }
    if (id !== path.basename(id) || !id) {
      throw new HttpError(400, '非法的模型标识');
    }
    if (this.#activeId === id && this.#session) {
      return this.#snapshot(id);
    }

    const onnxPath = path.join(ONNX_DIR, `${id}.onnx`);

    // 先占位，防止并发请求同时通过上面的检查
    this.#loadingId = id;
    try {
      await fsp.access(onnxPath);
    } catch {
      this.#loadingId = null;
      throw new HttpError(404, '该模型尚未转换为 ONNX，请先运行 tools/export_onnx.py');
    }

    this.#disposeSession();
    this.#states.set(id, { status: 'loading', phase: 'reading', progress: 0, error: null, loadMs: null });

    // 后台执行，错误写入状态，避免请求一直挂起
    this.#loadSession(id, onnxPath)
      .catch((error) => {
        this.#states.set(id, { status: 'error', phase: 'error', progress: 0, error: error.message, loadMs: null });
      })
      .finally(() => {
        this.#loadingId = null;
      });

    return this.#snapshot(id);
  }

  /** 串行推理，避免多个请求同时抢占 CPU */
  infer(tensor) {
    const session = this.#session;
    if (!session) {
      return Promise.reject(new HttpError(409, '模型尚未加载'));
    }

    const job = this.#queue.then(async () => {
      if (this.#session !== session) {
        throw new HttpError(409, '模型已切换，请重新检测');
      }
      return this.#run(session, tensor);
    });
    this.#queue = job.catch(() => {});
    return job;
  }

  async #run(session, tensor) {
    const started = performance.now();
    const outputs = await session.run({
      pixel_values: new ort.Tensor('float32', tensor, [1, 3, 224, 224]),
    });
    const logits = outputs.logits.data;

    // softmax 只取两类，数值稳定写法
    const max = Math.max(logits[0], logits[1]);
    const expReal = Math.exp(logits[0] - max);
    const expFake = Math.exp(logits[1] - max);
    const fakeProbability = expFake / (expReal + expFake);

    return {
      label: fakeProbability >= 0.5 ? 'fake' : 'real',
      fakeProbability,
      realProbability: 1 - fakeProbability,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  async #loadSession(id, onnxPath) {
    const started = performance.now();
    const { size } = await fsp.stat(onnxPath);

    // 流式读入并汇报真实读取进度；一次性分配避免 Buffer.concat 带来双倍内存
    let buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    for await (const chunk of fs.createReadStream(onnxPath, { highWaterMark: 4 * 1024 * 1024 })) {
      chunk.copy(buffer, offset);
      offset += chunk.length;
      this.#update(id, { phase: 'reading', progress: Math.min(offset / size, 1) * 0.8 });
    }

    this.#update(id, { phase: 'initializing', progress: 0.85 });
    const session = await ort.InferenceSession.create(buffer, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: INFERENCE_THREADS,
      interOpNumThreads: 1,
    });
    buffer = null; // 交给 GC，避免常驻两份 1.1GB 数据

    this.#session = session;
    this.#activeId = id;
    this.#states.set(id, {
      status: 'ready',
      phase: 'ready',
      progress: 1,
      error: null,
      loadMs: Math.round(performance.now() - started),
    });
  }

  #disposeSession() {
    if (!this.#session) return;
    try {
      this.#session.release?.();
    } catch {
      // release 失败不影响后续加载
    }
    this.#session = null;
    this.#activeId = null;
  }

  #update(id, patch) {
    const current = this.#states.get(id) ?? { ...IDLE_STATE };
    this.#states.set(id, { ...current, ...patch });
  }

  /** 只有当前加载中的模型才展示 loading/progress，其余展示 idle */
  #snapshot(id) {
    const state = this.#states.get(id);
    if (!state) return { ...IDLE_STATE };
    if (this.#activeId === id || this.#loadingId === id || state.status === 'error') {
      return { ...state };
    }
    return { ...IDLE_STATE };
  }
}

export const modelManager = new ModelManager();
