const IMAGE_PATTERN = /\.(jpe?g|png|webp|tiff?|bmp)$/i;
const MODEL_STATUS_TEXT = {
  idle: '未加载',
  loading: '加载中',
  ready: '已就绪',
  error: '加载失败',
};

// 1. 全局定义 Toast 生成函数
function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${isError ? 'error' : ''}`;
  toast.textContent = message;

  container.appendChild(toast);

  // 强制浏览器重绘，触发进入动画
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  // 3秒后自动消失并清理 DOM
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300); // 等待动画结束
  }, 3000);
}

// 2. 核心魔法：用代理对象劫持原来的 uploadHint
const uploadHintProxy = {
  set textContent(msg) {
    // 过滤掉空字符串和原有的清空操作
    if (msg && msg.trim() !== '') {
      // 识别错误信息（比如“失败”、“未找到”等关键字）
      const isError = msg.includes('没有') || msg.includes('失败') || msg.includes('缺少');
      showToast(msg, isError);
    }
  },
  get textContent() {
    return ''; // 原代码如果读取它，返回空即可
  }
};

const el = {
  modelSelect: document.getElementById('model-select'),
  modelSelectToggle: document.getElementById('model-select-toggle'),
  modelSelectLabel: document.getElementById('model-select-label'),
  modelDropdown: document.getElementById('model-dropdown'),
  modelList: document.getElementById('model-list'),
  modelExtra: document.getElementById('model-extra'),
  multimodalPrompt: document.getElementById('multimodal-prompt'),
  modelBadge: document.getElementById('model-badge'),
  modelStatus: document.getElementById('model-status'),

  providerForm: document.getElementById('multimodal-config-form'),
  providerBase: document.getElementById('multimodal-base'),
  providerModel: document.getElementById('multimodal-model'),
  providerKey: document.getElementById('multimodal-key'),
  providerStatus: document.getElementById('multimodal-config-status'),
  providerHint: document.getElementById('multimodal-save-hint'),
  progress: document.getElementById('load-progress'),
  progressBar: document.getElementById('load-progress-bar'),

  projectName: document.getElementById('project-name'),
  projectMenuBtn: document.getElementById('project-menu-btn'),
  projectDropdown: document.getElementById('project-dropdown'),
  projectFile: document.getElementById('project-file'),

  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  dirInput: document.getElementById('dir-input'),
  pickFiles: document.getElementById('pick-files'),
  pickDir: document.getElementById('pick-dir'),
  queueSummary: document.getElementById('queue-summary'),
  // uploadHint: document.getElementById('upload-hint'),
  uploadHint: uploadHintProxy,

  statTotal: document.getElementById('stat-total'),
  statDone: document.getElementById('stat-done'),
  statFake: document.getElementById('stat-fake'),
  statReal: document.getElementById('stat-real'),
  statRatio: document.getElementById('stat-ratio'),
  statAvg: document.getElementById('stat-avg'),
  avgTime: document.getElementById('avg-time'),
  histogram: document.getElementById('histogram'),

  exportBtn: document.getElementById('export-json'),
  exportBtnFull: document.getElementById('export-json-full'),
  exportPdfBtn: document.getElementById('export-pdf'),
  exportPdfBtnFull: document.getElementById('export-pdf-full'),
  exportXlsxBtn: document.getElementById('export-xlsx'),
  clearBtn: document.getElementById('clear-results'),
  filterSelect: document.getElementById('result-filter'),
  inferBtn: document.getElementById('infer-results'),
  resultsBody: document.getElementById('results-body'),
  resultsEmpty: document.getElementById('results-empty'),

  resultsBodyFull: document.getElementById('results-body-full'),
  resultsEmptyFull: document.getElementById('results-empty-full'),
  exportXlsxFull: document.getElementById('export-xlsx-full'),
  filterSelectFull: document.getElementById('result-filter-full'),
  inferBtnFull: document.getElementById('infer-results-full'),

  detailOverlay: document.getElementById('detail-overlay'),
  detailDrawer: document.getElementById('detail-drawer'),
  detailClose: document.getElementById('detail-close'),
  detailName: document.getElementById('detail-name'),
  detailSummary: document.getElementById('detail-summary'),
  detailColumns: document.getElementById('detail-columns'),
};

const PROJECT_FORMAT = 'aigc-detect-project';
const PROJECT_VERSION = 1;
const MODEL_SELECTION_KEY = 'aigc-model-selection-v1';
const MULTIMODAL_MODEL_ID = 'multimodal-qwen';
const MULTIMODAL_PROMPT_KEY = 'aigc-multimodal-prompt-v1';
/** 同时推理的图片数；每个图片内部的模型也会并发执行 */
const ITEM_CONCURRENCY = 2;
const DEFAULT_MULTIMODAL_PROMPT =
  '请判断这张图片是否由 AI 生成（伪造），还是真实照片（真实）。重点关注纹理细节、光影一致性、边缘与文字等生成痕迹。';

const state = {
  models: [],
  activeId: null,
  loading: false,
  detecting: false,
  inferringSelected: false,
  files: [],
  pollTimer: null,
  /** 勾选的图片 key，用于切换模型后再次推理 */
  selected: new Set(),
  /** 勾选需要使用的模型 id */
  modelIds: readModelSelection(),
  /** 首次拉取模型列表后是否已经套用默认勾选 */
  modelsInitialized: false,
  /** 列表排序：default | name-asc | name-desc | verdict-fake | verdict-real | fake-desc | fake-asc | time-desc | time-asc */
  sort: 'default',
  /** 列表筛选：all | fake | real | error */
  filter: 'all',
  /** 排序/筛选变化后需要重排 DOM */
  needsReorder: false,
  /** 当前详情抽屉对应的图片 key */
  detailKey: null,
  pdfExporting: false,
  /** 当前鉴别项目 */
  project: {
    name: '未命名鉴别项目',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dirty: false,
  },
};

/** 每个文件对应一行 DOM，避免批量检测时反复重建表格 */
const rows = new Map();


async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `请求失败（${response.status}）`);
  }
  return data;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function modelDisplayName(modelId) {
  const model = state.models.find((entry) => entry.id === modelId);
  return model?.displayName ?? (modelId || '未知模型');
}

function formatClock(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 判定标签 */
function verdictTagHtml(isFake) {
  return `<span class="tag tag-${isFake ? 'fake' : 'real'}">${isFake ? '伪造' : '真实'}</span>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

/** 单条结果的置信度：取判定方向对应的概率 */
function confidenceOf(result) {
  return result.label === 'fake' ? result.fakeProbability : result.realProbability;
}

/** 图片级汇总：按结果条目多数票判定，平票沿用最新一条 */
function aggregateMetrics(item) {
  const results = item.results ?? [];
  if (results.length === 0) return null;

  const fakeCount = results.filter((result) => result.label === 'fake').length;
  const realCount = results.length - fakeCount;
  const label = fakeCount === realCount
    ? results[results.length - 1].label
    : (fakeCount > realCount ? 'fake' : 'real');
  const fakeProbability = results.reduce((sum, result) => sum + (result.fakeProbability || 0), 0) / results.length;
  const elapsedMs = results.reduce((sum, result) => sum + (result.elapsedMs || 0), 0);

  return { label, fakeProbability, elapsedMs, fakeCount, realCount, count: results.length };
}

/* ===== 模型选单（下拉多选） ===== */

function toggleModelDropdown(force) {
  if (!el.modelDropdown || !el.modelSelectToggle) return;
  const open = force ?? el.modelDropdown.hidden;
  el.modelDropdown.hidden = !open;
  el.modelSelectToggle.setAttribute('aria-expanded', String(open));
}

/* ===== 模型多选与自动加载 ===== */

function readModelSelection() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_SELECTION_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch (error) {
    return new Set();
  }
}

function saveModelSelection() {
  try {
    localStorage.setItem(MODEL_SELECTION_KEY, JSON.stringify([...state.modelIds]));
  } catch (error) {
    // 本地存储不可用时忽略
  }
}

function readMultimodalPrompt() {
  try {
    const saved = localStorage.getItem(MULTIMODAL_PROMPT_KEY);
    return saved && saved.trim() ? saved : DEFAULT_MULTIMODAL_PROMPT;
  } catch (error) {
    return DEFAULT_MULTIMODAL_PROMPT;
  }
}

function saveMultimodalPrompt(value) {
  try {
    localStorage.setItem(MULTIMODAL_PROMPT_KEY, value);
  } catch (error) {
    // 本地存储不可用时忽略
  }
}

function modelById(id) {
  return state.models.find((model) => model.id === id) ?? null;
}

/** 当前勾选且可用的模型 */
function activeModelIds() {
  return state.models
    .filter((model) => model.onnxAvailable && state.modelIds.has(model.id))
    .map((model) => model.id);
}

function selectedModels() {
  return state.models.filter((model) => model.onnxAvailable && state.modelIds.has(model.id));
}

let modelListSignature = '';

function renderModelList() {
  if (!el.modelList) return;

  const signature = state.models
    .map((model) => `${model.id}|${model.displayName}|${model.onnxAvailable}`)
    .join('§');
  if (signature !== modelListSignature) {
    modelListSignature = signature;
    el.modelList.innerHTML = '';

    if (state.models.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'model-empty';
      empty.textContent = '未在 weight/ 目录发现 .pth 权重文件。';
      el.modelList.appendChild(empty);
    } else {
      for (const model of state.models) {
        const item = document.createElement('label');
        item.className = 'model-item';
        item.dataset.modelId = model.id;
        item.innerHTML = `
          <input type="checkbox">
          <span class="model-item-main">
            <span class="model-item-name"></span>
            <span class="model-item-meta"></span>
          </span>
          <span class="model-item-status badge"></span>`;
        item.querySelector('.model-item-name').textContent = model.displayName;
        item.querySelector('.model-item-name').title = model.displayName;

        const checkbox = item.querySelector('input');
        checkbox.disabled = !model.onnxAvailable;
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) state.modelIds.add(model.id);
          else state.modelIds.delete(model.id);
          saveModelSelection();
          renderModelList();
          renderModelStatus();
          updateActionButtons();
          updateUploadHint();
          markProjectDirty();
          // 勾选后立即开始加载，推理前即可全部就绪
          if (checkbox.checked && model.onnxAvailable) {
            ensureModelsLoaded(activeModelIds());
          }
        });

        el.modelList.appendChild(item);
      }
    }
  }

  for (const item of el.modelList.querySelectorAll('.model-item')) {
    const model = modelById(item.dataset.modelId);
    if (!model) continue;

    const checkbox = item.querySelector('input');
    const checked = model.onnxAvailable && state.modelIds.has(model.id);
    checkbox.checked = checked;
    checkbox.disabled = !model.onnxAvailable || state.loading || state.detecting;
    item.classList.toggle('is-checked', checked);

    const status = model.status ?? 'idle';
    const statusEl = item.querySelector('.model-item-status');
    const configured = model.kind === 'multimodal' ? Boolean(model.configured) : true;
    statusEl.className = `model-item-status badge ${model.kind === 'multimodal' && !configured ? 'badge-idle' : `badge-${status}`}`;
    statusEl.textContent = model.kind === 'multimodal' && !configured
      ? '未配置'
      : MODEL_STATUS_TEXT[status] ?? status;

    const meta = item.querySelector('.model-item-meta');
    if (model.kind === 'multimodal') {
      meta.textContent = configured
        ? '多模态 API · 已配置，按图片与提示词判定'
        : '尚未配置 API Key，请到“关于”页设置';
    } else if (!model.onnxAvailable) {
      meta.textContent = '尚未转换为 ONNX，请先运行 tools/export_onnx.py';
    } else if (status === 'ready') {
      meta.textContent = `已加载 · ${formatBytes(model.onnxSize)} · ${(model.loadMs / 1000).toFixed(1)} s`;
    } else if (status === 'error') {
      meta.textContent = `加载失败：${model.error ?? '未知错误'}`;
    } else {
      meta.textContent = `ONNX ${formatBytes(model.onnxSize)}`;
    }
  }
}

function renderModelStatus() {
  renderModelList();

  const selected = selectedModels();
  const readyCount = selected.filter((model) => model.status === 'ready').length;
  const loadingModel = selected.find((model) => model.status === 'loading');
  const failed = selected.filter((model) => model.status === 'error');

  let aggregate = 'idle';
  if (loadingModel) aggregate = 'loading';
  else if (selected.length > 0 && readyCount === selected.length) aggregate = 'ready';
  else if (failed.length > 0) aggregate = 'error';

  el.modelBadge.textContent = state.models.length === 0
    ? '无模型'
    : selected.length === 0
      ? '未选择'
      : `${readyCount}/${selected.length} 已加载`;
  el.modelBadge.className = `badge badge-${aggregate}`;

  if (el.modelExtra) {
    el.modelExtra.hidden = !state.modelIds.has(MULTIMODAL_MODEL_ID);
  }

  if (el.modelSelectLabel) {
    const summary = state.models.length === 0
      ? '无可用模型'
      : selected.length === 0
        ? '选择模型'
        : selected.length === 1
          ? selected[0].displayName
          : `已选 ${selected.length} 个模型`;
    el.modelSelectLabel.textContent = summary;
    el.modelSelectLabel.title = selected.length > 1
      ? selected.map((model) => model.displayName).join('、')
      : summary;
  }

  el.progress.hidden = !loadingModel;
  if (loadingModel) {
    const initializing = loadingModel.phase === 'initializing';
    el.progress.classList.toggle('indeterminate', initializing);
    el.progressBar.style.width = initializing ? '' : `${Math.round((loadingModel.progress / 0.8) * 100)}%`;
  } else {
    el.progress.classList.remove('indeterminate');
    el.progressBar.style.width = '0';
  }

  if (state.models.length === 0) {
    el.modelStatus.textContent = '未在 weight/ 目录发现 .pth 权重文件。';
  } else if (selected.length === 0) {
    el.modelStatus.textContent = '请勾选需要使用的模型；推理前会自动加载。';
  } else if (loadingModel) {
    el.modelStatus.textContent = loadingModel.phase === 'reading'
      ? `正在加载 ${loadingModel.displayName} 权重 ${Math.round((loadingModel.progress / 0.8) * 100)}%`
      : `正在初始化 ${loadingModel.displayName}，请稍候…`;
  } else if (failed.length > 0) {
    el.modelStatus.textContent = `加载失败：${failed.map((model) => model.displayName).join('、')}`;
  } else if (readyCount === selected.length) {
    el.modelStatus.textContent = `已勾选 ${selected.length} 个模型，全部就绪。`;
  } else {
    el.modelStatus.textContent = `已勾选 ${selected.length} 个模型，推理前将自动加载。`;
  }

  updateActionButtons();
}

async function refreshModels() {
  const data = await api('/api/models');
  state.models = data.models;
  state.activeId = data.activeId;

  const availableIds = new Set(
    state.models.filter((model) => model.onnxAvailable).map((model) => model.id),
  );
  for (const id of [...state.modelIds]) {
    if (!availableIds.has(id)) state.modelIds.delete(id);
  }

  if (!state.modelsInitialized) {
    state.modelsInitialized = true;
    if (state.modelIds.size === 0) {
      const first = state.models.find((model) => model.onnxAvailable && model.kind !== 'multimodal');
      if (first) state.modelIds.add(first.id);
      const multimodal = state.models.find((model) => model.id === MULTIMODAL_MODEL_ID && model.configured);
      if (multimodal) state.modelIds.add(multimodal.id);
      saveModelSelection();
    }
  }

  renderModelStatus();
  updateUploadHint();
}

/** 推理前确保勾选的模型已经加载，返回真正可用的模型 id */
async function loadModelsSequentially(ids) {
  const need = ids.filter((id) => modelById(id)?.status !== 'ready');
  if (need.length === 0) return ids;

  state.loading = true;
  renderModelStatus();
  updateActionButtons();
  updateUploadHint();

  const deadline = Date.now() + 180000;
  for (const id of need) {
    const model = modelById(id);
    if (!model || model.status === 'ready') continue;

    // 服务端同一时间只允许加载一个模型，因此逐个启动并等待就绪
    if (model.status !== 'loading') {
      try {
        await api(`/api/models/${encodeURIComponent(id)}/load`, { method: 'POST' });
      } catch (error) {
        // 具体失败原因由状态轮询展示
      }
    }
    // 先同步服务端状态，再等待加载结束
    await refreshModels();

    while (Date.now() < deadline) {
      const current = modelById(id);
      if (!current || current.status !== 'loading') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await refreshModels();
    }
  }
  await refreshModels();

  state.loading = false;
  renderModelStatus();
  updateActionButtons();
  updateUploadHint();
  return ids.filter((id) => modelById(id)?.status === 'ready');
}

/** 串行化加载请求，避免同时勾选多个模型时触发服务端“正在加载”冲突 */
let modelLoadChain = Promise.resolve();

function ensureModelsLoaded(ids) {
  const run = () => loadModelsSequentially(ids);
  const task = modelLoadChain.then(run, run);
  modelLoadChain = task.catch(() => {});
  return task;
}

/* ===== 多模态提供商设置（关于页） ===== */

function applyProviderSettings(settings) {
  if (!settings) return;
  if (el.providerBase) el.providerBase.value = settings.baseUrl ?? '';
  if (el.providerModel) el.providerModel.value = settings.model ?? '';
  if (el.providerKey) {
    el.providerKey.value = '';
    el.providerKey.placeholder = settings.hasKey
      ? `留空则保留当前 Key（${settings.maskedKey}）`
      : '请输入 API Key';
  }
  if (el.providerStatus) {
    el.providerStatus.textContent = settings.hasKey ? '已配置' : '尚未配置 API Key';
  }
}

async function loadProviderSettings() {
  try {
    const settings = await api('/api/multimodal/config');
    applyProviderSettings(settings);
  } catch (error) {
    if (el.providerStatus) el.providerStatus.textContent = '读取配置失败';
  }
}

async function saveProviderSettings(event) {
  event.preventDefault();
  if (el.providerHint) el.providerHint.textContent = '正在保存…';

  try {
    const settings = await api('/api/multimodal/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: el.providerBase?.value ?? '',
        model: el.providerModel?.value ?? '',
        apiKey: el.providerKey?.value ?? '',
      }),
    });
    applyProviderSettings(settings);
    if (el.providerHint) el.providerHint.textContent = '设置已保存到 .env。';
    await refreshModels();
  } catch (error) {
    if (el.providerHint) el.providerHint.textContent = `保存失败：${error.message}`;
  }
}

function uniqueKey(rawKey) {
  const used = new Set(state.files.map((item) => item.key));
  if (!used.has(rawKey)) return rawKey;

  const dot = rawKey.lastIndexOf('.');
  const base = dot > 0 ? rawKey.slice(0, dot) : rawKey;
  const ext = dot > 0 ? rawKey.slice(dot) : '';

  let index = 2;
  let candidate = `${base} (${index})${ext}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${base} (${index})${ext}`;
  }
  return candidate;
}

function addFiles(fileList, useRelativePath) {
  const files = Array.from(fileList).filter((file) => IMAGE_PATTERN.test(file.name));
  if (files.length === 0) {
    el.uploadHint.textContent = '未找到支持的图片文件。';
    return;
  }

  for (const file of files) {
    const rawKey = useRelativePath && file.webkitRelativePath ? file.webkitRelativePath : file.name;
    const item = {
      key: uniqueKey(rawKey),
      file,
      status: 'queued',
      /** 最近一次结果（兼容统计、导出等单结果逻辑） */
      result: null,
      /** 该图片的全部推理结果，用于同组多行对比 */
      results: [],
      error: null,
      expanded: false,
      inferring: false,
      preview: URL.createObjectURL(file),
      /** 原图的 data URL，随项目文件保存 */
      image: null,
      /** 项目文件中的缩略图 */
      thumb: null,
      review: null,
      restored: false,
    };
    state.files.push(item);
    renderRow(item);
    createThumbnail(item);
  }

  renderStats();
  updateQueueSummary();
  el.uploadHint.textContent = '';
  markProjectDirty();

  if (activeModelIds().length > 0 && !state.detecting) {
    startDetection();
  } else if (activeModelIds().length === 0) {
    el.uploadHint.textContent = '图片已加入队列，勾选模型后将自动开始。';
  }
}

function loadPreviewImage(item) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = item.preview;
  });
}

/** 生成 128×128 缩略图，并缓存原图 data URL（供项目文件使用） */
async function createThumbnail(item) {
  if (item.file) {
    try {
      item.image = await readFileAsDataURL(item.file);
    } catch (error) {
      item.image = null;
    }
  }

  const image = await loadPreviewImage(item);
  if (!image || !image.width || !image.height) return null;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const scale = Math.max(size / image.width, size / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  ctx.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
  item.thumb = canvas.toDataURL('image/jpeg', 0.72);
  return item.thumb;
}

/** 全局 Ctrl+V：把剪贴板里的图片直接加入队列并自动研判 */
function handlePaste(event) {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) {
    return;
  }

  const clipboard = event.clipboardData;
  if (!clipboard) return;

  const pasted = [];
  for (const entry of clipboard.items) {
    if (entry.kind !== 'file' || !entry.type.startsWith('image/')) continue;
    const file = entry.getAsFile();
    if (file) pasted.push(file);
  }
  if (pasted.length === 0) return;

  event.preventDefault();
  const now = new Date();
  const prefix = `粘贴图片-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const files = pasted.map((file, index) => {
    if (file.name && IMAGE_PATTERN.test(file.name)) return file;
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return new File([file], `${prefix}-${index + 1}.${ext}`, { type: file.type });
  });

  addFiles(files, false);
  el.uploadHint.textContent = `已从剪贴板粘贴 ${files.length} 张图片。`;
  updateEmptyState();
}

function createRowElement(item) {
  const row = document.createElement('tr');
  row.dataset.key = item.key;
  row.className = 'group-head';
  row.innerHTML = `
    <td class="cell-select"><input type="checkbox" class="row-select" aria-label="勾选该图片"></td>
    <td class="cell-thumb"><img class="thumb" alt=""></td>
    <td class="cell-name">
      <span class="file-name"></span>
      <span class="group-meta"></span>
    </td>
    <td class="verdict"></td>
    <td class="prob mono"></td>
    <td class="time mono"></td>
    <td class="state"></td>`;
  row.querySelector('.thumb').src = item.preview;
  const nameCell = row.querySelector('.file-name');
  nameCell.textContent = item.key;
  nameCell.title = item.key;
  return row;
}

function createResultRow(item, result, index) {
  const row = document.createElement('tr');
  row.dataset.key = item.key;
  row.dataset.index = String(index);
  row.className = 'result-row row-clickable';

  const isFake = result.label === 'fake';
  row.innerHTML = `
    <td class="cell-select"></td>
    <td class="cell-thumb"></td>
    <td class="cell-name"><span class="result-model"></span></td>
    <td class="verdict">${verdictTagHtml(isFake)}</td>
    <td class="prob mono">${formatPercent(result.fakeProbability)}</td>
    <td class="time mono">${result.elapsedMs} ms</td>
    <td class="state"><span class="result-index">#${index + 1}</span></td>`;

  const modelCell = row.querySelector('.result-model');
  modelCell.textContent = modelDisplayName(result.model);
  modelCell.title = result.model ?? '';

  row.tabIndex = 0;
  row.setAttribute('aria-label', `查看 ${item.key} 第 ${index + 1} 条研判结果`);
  return row;
}

function updateRowElement(row, item) {
  const verdict = row.querySelector('.verdict');
  const prob = row.querySelector('.prob');
  const time = row.querySelector('.time');
  const statusCell = row.querySelector('.state');
  const meta = row.querySelector('.group-meta');
  const checkbox = row.querySelector('.row-select');

  const count = item.results.length;
  const latest = count > 0 ? item.results[count - 1] : null;
  const summary = aggregateMetrics(item);

  if (checkbox) checkbox.checked = state.selected.has(item.key);
  row.classList.toggle('row-selected', state.selected.has(item.key));

  statusCell.title = '';
  statusCell.className = 'state';
  statusCell.replaceChildren();

  // 有任意一条结果即可查看详情
  const clickable = count > 0;
  row.classList.toggle('row-clickable', clickable);
  if (clickable) {
    row.tabIndex = 0;
    row.setAttribute('aria-label', `查看 ${item.key} 的研判详情`);
  } else {
    row.removeAttribute('tabindex');
    row.removeAttribute('aria-label');
  }

  if (item.inferring) {
    meta.hidden = false;
    meta.textContent = '推理中…';
  } else if (latest && summary) {
    const parts = [
      summary.count > 1
        ? `${summary.count} 个结果 · 伪造 ${summary.fakeCount} · 真实 ${summary.realCount}`
        : modelDisplayName(latest.model),
    ];
    if (item.review) {
      parts.push(item.review.status === 'misjudged' ? '人工复核：误判' : '人工复核：已确认');
    }
    meta.hidden = false;
    meta.textContent = parts.join(' · ');
  } else {
    meta.hidden = true;
    meta.textContent = '';
  }

  if (summary) {
    verdict.innerHTML = verdictTagHtml(summary.label === 'fake');
    prob.textContent = formatPercent(summary.fakeProbability);
    time.textContent = `${Math.round(summary.elapsedMs)} ms`;
  } else if (item.status === 'processing') {
    // 分析中显示骨架屏，而不是破折号
    verdict.innerHTML = '<span class="skeleton skeleton-tag"></span>';
    prob.innerHTML = '<span class="skeleton skeleton-text"></span>';
    time.innerHTML = '<span class="skeleton skeleton-text short"></span>';
  } else {
    verdict.textContent = '—';
    prob.textContent = '—';
    time.textContent = '—';
  }

  if (count > 1) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'group-toggle';
    toggle.textContent = item.expanded ? '收起' : `展开 ${count}`;
    toggle.title = item.expanded ? '收起该图片的结果' : '展开该图片的全部结果';
    statusCell.appendChild(toggle);
  } else if (item.inferring || item.status === 'processing') {
    statusCell.textContent = '推理中…';
  } else if (item.status === 'error' && count === 0) {
    statusCell.textContent = '失败';
    statusCell.className = 'state state-error';
    statusCell.title = item.error ?? '未知错误';
  } else if (count > 0) {
    statusCell.textContent = '完成';
  } else if (item.status === 'queued') {
    statusCell.textContent = '等待';
  }
}

/** 一条结果一行，仅在多结果且展开时渲染子行 */
function renderChildRows(slot, item) {
  for (const row of slot.children) row.remove();
  slot.children.length = 0;

  if (!item.expanded || item.results.length < 2) return;

  let anchor = slot.header;
  item.results.forEach((result, index) => {
    const row = createResultRow(item, result, index);
    anchor.insertAdjacentElement('afterend', row);
    anchor = row;
    slot.children.push(row);
  });
}

function renderTableSlot(body, slot, item) {
  if (!slot) {
    slot = { header: createRowElement(item), children: [] };
    body.appendChild(slot.header);
  }
  updateRowElement(slot.header, item);
  renderChildRows(slot, item);
  return slot;
}

// 👇 核心：重写渲染函数，同时更新两个表格
function renderRow(item) {
  let rowData = rows.get(item.key);
  if (!rowData) {
    rowData = { main: null, full: null };
    rows.set(item.key, rowData);
  }

  // 1. 渲染主页面（小表格）
  if (el.resultsBody) {
    rowData.main = renderTableSlot(el.resultsBody, rowData.main, item);
  }

  // 2. 渲染结果页（大表格）
  if (el.resultsBodyFull) {
    rowData.full = renderTableSlot(el.resultsBodyFull, rowData.full, item);
  }

  updateEmptyState();
  scheduleLayout();
}

/** 根据筛选条件控制空状态与提示文案 */
function updateEmptyState() {
  const total = state.files.length;
  const visible = state.files.filter(itemVisible).length;
  for (const emptyEl of [el.resultsEmpty, el.resultsEmptyFull]) {
    if (!emptyEl) continue;
    const show = total === 0 || visible === 0;
    emptyEl.hidden = !show;
    const title = emptyEl.querySelector('.empty-title');
    if (title) {
      title.textContent = total === 0 ? '尚未添加图片' : '没有符合筛选条件的图片';
    }
    const sub = emptyEl.querySelector('.empty-sub');
    if (sub) {
      sub.textContent = total === 0
        ? '拖拽、选择文件夹，或直接 Ctrl+V 粘贴图片开始研判'
        : '调整筛选条件以查看更多研判记录';
    }
  }
}

/** 同步两张表里同一图片的勾选状态 */
function applySelectionState(key) {
  const rowData = rows.get(key);
  if (!rowData) return;

  for (const slot of [rowData.main, rowData.full]) {
    if (!slot) continue;
    const checkbox = slot.header.querySelector('.row-select');
    if (checkbox) checkbox.checked = state.selected.has(key);
    slot.header.classList.toggle('row-selected', state.selected.has(key));
  }
}

/* ===== 列表筛选 / 排序 ===== */

function itemVisible(item) {
  const summary = aggregateMetrics(item);
  switch (state.filter) {
    case 'fake': return summary?.label === 'fake';
    case 'real': return summary?.label === 'real';
    case 'error': return item.status === 'error';
    default: return true;
  }
}

function compareItems(a, b) {
  const summaryA = aggregateMetrics(a);
  const summaryB = aggregateMetrics(b);
  const fakeA = summaryA?.fakeProbability ?? -1;
  const fakeB = summaryB?.fakeProbability ?? -1;
  const timeA = summaryA?.elapsedMs ?? -1;
  const timeB = summaryB?.elapsedMs ?? -1;

  switch (state.sort) {
    case 'fake-desc': return fakeB - fakeA;
    case 'fake-asc': return fakeA - fakeB;
    case 'time-desc': return timeB - timeA;
    case 'time-asc': return timeA - timeB;
    case 'name-asc': return a.key.localeCompare(b.key, 'zh-CN');
    case 'name-desc': return b.key.localeCompare(a.key, 'zh-CN');
    case 'verdict-fake': return Number(summaryB?.label === 'fake') - Number(summaryA?.label === 'fake');
    case 'verdict-real': return Number(summaryA?.label === 'fake') - Number(summaryB?.label === 'fake');
    default: return 0;
  }
}

function sortBaseOf(value) {
  if (value === 'default') return null;
  if (value === 'verdict-fake' || value === 'verdict-real') return 'verdict';
  return value.split('-')[0];
}

function sortDirectionOf(value) {
  if (!value || value === 'default') return null;
  if (value === 'verdict-fake') return 'down';
  if (value === 'verdict-real') return 'up';
  return value.endsWith('-desc') ? 'down' : 'up';
}

function renderSortIndicators() {
  const base = sortBaseOf(state.sort);
  const direction = sortDirectionOf(state.sort);
  for (const th of document.querySelectorAll('th[data-sort]')) {
    const indicator = th.querySelector('.sort-indicator');
    if (!indicator) continue;
    const active = th.dataset.sort === base;
    indicator.textContent = active ? (direction === 'down' ? '↓' : '↑') : '';
    th.classList.toggle('is-sorted', active);
  }
}

function handleSort(key) {
  const cycles = {
    name: ['name-asc', 'name-desc'],
    verdict: ['verdict-fake', 'verdict-real'],
    fake: ['fake-desc', 'fake-asc'],
    time: ['time-desc', 'time-asc'],
  };
  const next = cycles[key];
  if (!next) return;

  if (state.sort === next[0]) state.sort = next[1];
  else if (state.sort === next[1]) state.sort = 'default';
  else state.sort = next[0];

  state.needsReorder = true;
  renderSortIndicators();
  layoutTables();
}

function syncFilterControls() {
  if (el.filterSelect) el.filterSelect.value = state.filter;
  if (el.filterSelectFull) el.filterSelectFull.value = state.filter;
}

function handleFilterChange(value) {
  state.filter = value;
  state.needsReorder = true;
  syncFilterControls();
  layoutTables();
  updateQueueSummary();
}

let layoutTimer = null;

/** 合并同一轮内的多次布局请求，避免批量分析时反复重排 */
function scheduleLayout() {
  if (layoutTimer) return;
  layoutTimer = setTimeout(() => {
    layoutTimer = null;
    layoutTables();
  }, 0);
}

/** 按当前排序与筛选重排两张表的行，并同步隐藏状态 */
function layoutTables() {
  if (layoutTimer) {
    clearTimeout(layoutTimer);
    layoutTimer = null;
  }

  const bodies = [
    { body: el.resultsBody, slotKey: 'main' },
    { body: el.resultsBodyFull, slotKey: 'full' },
  ];
  const sorted = [...state.files].sort(compareItems);
  const skipReorder = state.sort === 'default' && state.filter === 'all' && !state.needsReorder;

  for (const { body, slotKey } of bodies) {
    if (!body) continue;

    const ordered = [];
    for (const item of sorted) {
      const slot = rows.get(item.key)?.[slotKey];
      if (!slot) continue;
      const visible = itemVisible(item);
      slot.header.hidden = !visible;
      for (const child of slot.children) child.hidden = !visible;
      ordered.push(slot);
    }

    if (skipReorder) continue;

    for (const slot of ordered) {
      body.appendChild(slot.header);
      for (const child of slot.children) body.appendChild(child);
    }
  }

  state.needsReorder = false;
  updateEmptyState();
}/* ===== 列表筛选 / 排序结束 ===== */

function updateQueueSummary() {
  const total = state.files.length;
  if (total === 0) {
    el.queueSummary.textContent = '';
    return;
  }

  const done = state.files.filter((item) => item.status === 'done').length;
  const failed = state.files.filter((item) => item.status === 'error').length;
  const pending = total - done - failed;
  el.queueSummary.textContent = `共 ${total} 张 · 完成 ${done} · 等待 ${pending} · 失败 ${failed}`;
}

function updateUploadHint() {
  if (state.files.length === 0) {
    el.uploadHint.textContent = '';
    return;
  }

  const pending = state.files.some((item) => item.status === 'queued' || item.status === 'processing');
  if (state.detecting) {
    el.uploadHint.textContent = state.loading
      ? '正在自动加载勾选的模型，随后开始分析…'
      : '正在并发分析，请保持页面打开。';
  } else if (state.loading) {
    el.uploadHint.textContent = '正在自动加载勾选的模型…';
  } else if (activeModelIds().length === 0 && pending) {
    el.uploadHint.textContent = '图片已加入队列，勾选模型后将自动开始。';
  } else {
    el.uploadHint.textContent = '';
  }
}

/** 并发处理所有排队图片，某个模型较慢时不会阻塞其他图片 */
async function drainQueuedItems(readyIds) {
  do {
    const workers = Array.from({ length: ITEM_CONCURRENCY }, async () => {
      while (true) {
        const item = state.files.find((file) => file.status === 'queued');
        if (!item) return;
        item.status = 'processing';
        renderRow(item);
        renderStats();
        updateQueueSummary();

        await analyzeItem(item, readyIds);
        renderStats();
        updateQueueSummary();
      }
    });
    await Promise.all(workers);
  } while (state.files.some((file) => file.status === 'queued'));
}

async function startDetection() {
  if (state.detecting) return;
  const modelIds = activeModelIds();
  if (modelIds.length === 0) {
    if (state.files.some((item) => item.status === 'queued')) {
      el.uploadHint.textContent = '请先在模型卡片中勾选需要使用的模型。';
    }
    return;
  }

  state.detecting = true;
  state.inferringSelected = false;
  renderModelStatus();
  updateActionButtons();
  updateUploadHint();

  try {
    const readyIds = await ensureModelsLoaded(modelIds);
    if (readyIds.length === 0) {
      el.uploadHint.textContent = '没有可用的模型，请检查模型加载状态。';
      return;
    }

    await drainQueuedItems(readyIds);
  } finally {
    state.detecting = false;
    markProjectDirty();
    renderModelStatus();
    renderStats();
    updateUploadHint();
    updateActionButtons();
  }
}

/** 单张图片并发调用所有勾选的模型，追加多条结果；已推理过的模型自动跳过 */
async function analyzeItem(item, modelIds) {
  const pending = modelIds.filter(
    (modelId) => !item.results.some((result) => result.model === modelId),
  );
  if (pending.length === 0) return 0;

  const errors = [];
  let added = 0;

  await Promise.all(pending.map(async (modelId) => {
    try {
      if (!item.file) throw new Error('缺少原图，无法推理');
      const result = await detectItemWithModel(item, modelId);
      item.results.push(result);
      item.result = result;
      added += 1;
    } catch (error) {
      errors.push(`${modelDisplayName(modelId)}：${error.message}`);
    } finally {
      renderRow(item);
      renderStats();
    }
  }));

  if (added > 0) {
    item.status = 'done';
    item.error = null;
    if (item.results.length > 1) item.expanded = true;
  } else if (item.results.length === 0) {
    item.status = 'error';
    item.error = errors.join('；') || '推理失败';
  } else {
    item.status = 'done';
  }

  renderRow(item);
  return added;
}

async function detectItemWithModel(item, modelId) {
  const form = new FormData();
  form.append('image', item.file, item.key);
  form.append('name', item.key);
  form.append('model', modelId);
  if (modelId === MULTIMODAL_MODEL_ID) {
    form.append('prompt', readMultimodalPrompt());
  }
  const result = await api('/api/detect', { method: 'POST', body: form });
  return { ...result, receivedAt: Date.now() };
}

/** 对勾选的图片用所有勾选的模型再次推理，为每张图追加结果 */
async function runSelectedInference() {
  const modelIds = activeModelIds();
  if (state.detecting || state.loading || modelIds.length === 0) return;

  const targets = state.files.filter((item) => state.selected.has(item.key) && item.file);
  if (targets.length === 0) {
    if (state.selected.size > 0) {
      el.uploadHint.textContent = '所选图片缺少原图，无法重新推理。';
    }
    return;
  }

  state.detecting = true;
  state.inferringSelected = true;
  renderModelStatus();
  updateActionButtons();
  updateUploadHint();

  let addedTotal = 0;
  let completed = false;

  try {
    const readyIds = await ensureModelsLoaded(modelIds);
    if (readyIds.length === 0) {
      el.uploadHint.textContent = '没有可用的模型，请检查模型加载状态。';
      return;
    }

    let index = 0;
    const worker = async () => {
      while (index < targets.length) {
        const item = targets[index];
        index += 1;
        item.inferring = true;
        renderRow(item);
        try {
          addedTotal += await analyzeItem(item, readyIds);
        } finally {
          item.inferring = false;
          renderRow(item);
          renderStats();
          updateQueueSummary();
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(ITEM_CONCURRENCY, targets.length) }, worker),
    );
    completed = true;
  } finally {
    state.detecting = false;
    state.inferringSelected = false;
    markProjectDirty();
    renderModelStatus();
    renderStats();
    updateUploadHint();
    if (completed && addedTotal === 0) {
      el.uploadHint.textContent = '所选模型的推理结果均已存在，已跳过，避免重复。';
    }
    updateActionButtons();
  }
}

/** 根据勾选状态与模型状态刷新「推理」按钮 */
function updateActionButtons() {
  const hasSelection = state.selected.size > 0;
  const busy = state.detecting || state.loading || state.pdfExporting;
  const hasModel = activeModelIds().length > 0;
  for (const button of [el.inferBtn, el.inferBtnFull]) {
    if (!button) continue;
    button.disabled = !hasSelection || !hasModel || busy;
    button.textContent = state.inferringSelected ? '推理中…' : '推理';
  }
}

function renderStats() {
  // 统计以结果条目为单位：同一张图片被多个模型推理时，每条结果单独计数
  const done = state.files.filter((item) => item.results.length > 0);
  const allResults = done.flatMap((item) => item.results);
  const fake = allResults.filter((result) => result.label === 'fake').length;
  const real = allResults.length - fake;

  el.statTotal.textContent = String(state.files.length);
  el.statDone.textContent = String(done.length);
  el.statFake.textContent = String(fake);
  el.statReal.textContent = String(real);
  el.statRatio.textContent = allResults.length ? formatPercent(fake / allResults.length) : '—';
  el.statAvg.textContent = allResults.length
    ? formatPercent(allResults.reduce((sum, result) => sum + result.fakeProbability, 0) / allResults.length)
    : '—';
  el.avgTime.textContent = allResults.length
    ? `平均耗时 ${Math.round(allResults.reduce((sum, result) => sum + result.elapsedMs, 0) / allResults.length)} ms/条`
    : '';

  if (el.exportBtn) el.exportBtn.disabled = done.length === 0;
  if (el.exportBtnFull) el.exportBtnFull.disabled = done.length === 0;
  if (el.exportPdfBtn) el.exportPdfBtn.disabled = done.length === 0 || state.pdfExporting;
  if (el.exportPdfBtnFull) el.exportPdfBtnFull.disabled = done.length === 0 || state.pdfExporting;
  if (el.clearBtn) el.clearBtn.disabled = state.files.length === 0 || state.detecting;
  if (el.exportXlsxBtn) el.exportXlsxBtn.disabled = done.length === 0;
  if (el.exportXlsxFull) el.exportXlsxFull.disabled = done.length === 0;

  updateActionButtons();
  renderHistogram(allResults);
}

/* ===== 伪造概率分布（KDE 平滑曲线 + 交互） ===== */

const HIST_SAMPLES = 180; 
let histAnimationFrame = null;
let currentDensities = new Array(HIST_SAMPLES + 1).fill(0);
let currentProbs = []; 
let currentMaxDensity = 1; 

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function buildHistogramSkeleton() {
  const W = 600, H = 170;
  const pad = { l: 24, r: 24, t: 20, b: 32 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const baseY = pad.t + innerH;
  const px = (t) => pad.l + t * innerW;

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const grid = ticks.map((t) => 
    `<line class="hist-grid" x1="${px(t)}" y1="${pad.t}" x2="${px(t)}" y2="${baseY}"/>`
  ).join('');
  
  const axis = ticks.map((t) => {
    const anchor = t === 0 ? 'start' : t === 1 ? 'end' : 'middle';
    return `<text class="hist-tick" x="${px(t)}" y="${H - 8}" text-anchor="${anchor}">${t.toFixed(2)}</text>`;
  }).join('');

  el.histogram.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="伪造概率分布">
      <defs>
        <linearGradient id="hist-fill" x1="0" y1="0" x2="0" y2="1">
          <stop class="hist-stop-top" offset="0%"/>
          <stop class="hist-stop-bottom" offset="100%"/>
        </linearGradient>
      </defs>
      ${grid}
      <line class="hist-baseline" x1="${pad.l}" y1="${baseY}" x2="${W - pad.r}" y2="${baseY}"/>
      <path class="hist-area" d="" />
      <path class="hist-line" d="" />
      
      <line class="hist-hover-line" x1="0" y1="${pad.t}" x2="0" y2="${baseY}" style="opacity: 0;" />
      <circle class="hist-hover-dot" r="4" cx="0" cy="0" style="opacity: 0;" />
      
      <text class="hist-empty" x="${W / 2}" y="${pad.t + innerH / 2}" text-anchor="middle" style="opacity: 1; transition: opacity 0.3s;">暂无数据</text>
      ${axis}
      
      <rect class="hist-interact-layer" x="${pad.l}" y="${pad.t}" width="${innerW}" height="${innerH}" fill="transparent" style="cursor: crosshair;" />
    </svg>
    <div class="hist-tooltip"></div>
  `;

  bindHistogramEvents();
}

function updateHistogramPaths(densities, maxDensity) {
  const W = 600, H = 170;
  const pad = { l: 24, r: 24, t: 20, b: 32 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const baseY = pad.t + innerH;
  const px = (t) => pad.l + t * innerW;

  const py = (d) => pad.t + innerH - (d / maxDensity) * innerH;

  const linePath = densities.map((d, i) => {
    const x = px(i / HIST_SAMPLES).toFixed(2);
    const y = py(d).toFixed(2);
    return `${i === 0 ? 'M' : 'L'}${x},${y}`;
  }).join(' ');

  const areaPath = `${linePath} L${px(1).toFixed(2)},${baseY} L${px(0).toFixed(2)},${baseY} Z`;

  const lineEl = el.histogram.querySelector('.hist-line');
  const areaEl = el.histogram.querySelector('.hist-area');
  
  if (lineEl && areaEl) {
    lineEl.setAttribute('d', linePath);
    areaEl.setAttribute('d', areaPath);
  }
}

function gaussianKde(values, bandwidth) {
  const n = values.length;
  const scale = 1 / (n * bandwidth * Math.sqrt(2 * Math.PI));
  return (x) => {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const z = (x - values[i]) / bandwidth;
      sum += Math.exp(-0.5 * z * z);
    }
    return sum * scale;
  };
}

function pickBandwidth(values) {
  const n = values.length;
  if (n <= 1) return 0.12;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance) || 0.15;
  const silverman = 1.06 * sd * n ** -0.2;
  return Math.min(0.25, Math.max(0.06, silverman));
}

function renderHistogram(results) {
  // 直方图同样以结果条目为单位
  currentProbs = results
    .map((result) => result.fakeProbability)
    .filter((value) => typeof value === 'number');

  if (!el.histogram.querySelector('svg')) {
    buildHistogramSkeleton();
  }

  const lineEl = el.histogram.querySelector('.hist-line');
  const areaEl = el.histogram.querySelector('.hist-area');
  const emptyEl = el.histogram.querySelector('.hist-empty');

  if (emptyEl) {
    emptyEl.style.opacity = currentProbs.length === 0 ? '1' : '0';
  }

  let targetDensities = new Array(HIST_SAMPLES + 1).fill(0);
  let targetPeak = 0;
  
  if (currentProbs.length > 0) {
    const bandwidth = pickBandwidth(currentProbs);
    const raw = gaussianKde(currentProbs, bandwidth);
    const density = (x) => raw(x) + raw(-x) + raw(2 - x);
    
    for (let i = 0; i <= HIST_SAMPLES; i += 1) {
      targetDensities[i] = density(i / HIST_SAMPLES);
      if (targetDensities[i] > targetPeak) {
        targetPeak = targetDensities[i];
      }
    }
  }

  let startPeak = 0;
  for (let i = 0; i <= HIST_SAMPLES; i++) {
    if (currentDensities[i] > startPeak) startPeak = currentDensities[i];
  }

  if (currentProbs.length === 0 && startPeak === 0) {
    if (lineEl) lineEl.style.opacity = '0';
    if (areaEl) areaEl.style.opacity = '0';
    return;
  }

  if (lineEl) lineEl.style.opacity = '1';
  if (areaEl) areaEl.style.opacity = '1';

  if (histAnimationFrame) cancelAnimationFrame(histAnimationFrame);
  
  const startDensities = [...currentDensities];
  const startTime = performance.now();
  const duration = 450; 

  currentMaxDensity = Math.max(startPeak, targetPeak, 1e-6);

  function step(time) {
    const t = Math.min(1, (time - startTime) / duration);
    const ease = easeOutCubic(t);
    
    currentDensities = targetDensities.map((target, i) => 
      startDensities[i] + (target - startDensities[i]) * ease
    );
    
    updateHistogramPaths(currentDensities, currentMaxDensity);

    if (t < 1) {
      histAnimationFrame = requestAnimationFrame(step);
    } else {
      histAnimationFrame = null;
      if (currentProbs.length === 0) {
        if (lineEl) lineEl.style.opacity = '0';
        if (areaEl) areaEl.style.opacity = '0';
        currentDensities = new Array(HIST_SAMPLES + 1).fill(0);
      }
    }
  }
  histAnimationFrame = requestAnimationFrame(step);
}

function bindHistogramEvents() {
  const interactLayer = el.histogram.querySelector('.hist-interact-layer');
  const hoverLine = el.histogram.querySelector('.hist-hover-line');
  const hoverDot = el.histogram.querySelector('.hist-hover-dot');
  const tooltip = el.histogram.querySelector('.hist-tooltip');

  if (!interactLayer || !hoverLine || !hoverDot || !tooltip) return;

  const W = 600, H = 170;
  const pad = { l: 24, r: 24, t: 20, b: 32 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  interactLayer.addEventListener('mousemove', (e) => {
    if (currentProbs.length === 0) return;

    const rect = el.histogram.querySelector('svg').getBoundingClientRect();
    const scaleX = W / rect.width;
    const mouseX = (e.clientX - rect.left) * scaleX;

    let p = (mouseX - pad.l) / innerW;
    p = Math.max(0, Math.min(1, p));

    const indexFloat = p * HIST_SAMPLES;
    const i0 = Math.floor(indexFloat);
    const i1 = Math.min(HIST_SAMPLES, i0 + 1);
    const frac = indexFloat - i0;
    const densityValue = currentDensities[i0] * (1 - frac) + currentDensities[i1] * frac;
    const py = pad.t + innerH - (densityValue / currentMaxDensity) * innerH;

    const px = pad.l + p * innerW;
    hoverLine.setAttribute('x1', px);
    hoverLine.setAttribute('x2', px);
    hoverLine.style.opacity = '1';

    hoverDot.setAttribute('cx', px);
    hoverDot.setAttribute('cy', py);
    hoverDot.style.opacity = '1';

    const win = 0.1;
    const count = currentProbs.filter(v => v >= p - win && v <= p + win).length;

    const pStart = Math.max(0, p - win).toFixed(2);
    const pEnd = Math.min(1, p + win).toFixed(2);
    tooltip.innerHTML = `<strong>${count}</strong> 张 <span style="opacity:0.6; margin-left:4px;">[${pStart} - ${pEnd}]</span>`;

    const leftPercent = (px / W) * 100;
    let tooltipX = leftPercent;
    // if (leftPercent < 12) tooltipX = 12;
    // if (leftPercent > 90) tooltipX = 90;

    tooltip.style.left = `${tooltipX}%`;
    tooltip.style.opacity = '1';
  });

  interactLayer.addEventListener('mouseleave', () => {
    hoverLine.style.opacity = '0';
    hoverDot.style.opacity = '0';
    tooltip.style.opacity = '0';
  });
}

/* ===== 鉴别项目 ===== */

function markProjectDirty() {
  state.project.dirty = true;
  state.project.updatedAt = Date.now();
}

function projectDisplayName() {
  return (el.projectName?.value || '').trim() || '未命名鉴别项目';
}

function syncProjectName() {
  if (el.projectName) el.projectName.value = state.project.name;
}

function sanitizeFilename(name) {
  return String(name || '鉴别项目').replace(/[\\/:*?"<>|]/g, '_').trim() || '鉴别项目';
}

function resetProject({ name = '未命名鉴别项目', createdAt = Date.now(), modelIds = null } = {}) {
  state.project = { name, createdAt, updatedAt: createdAt, dirty: false };
  syncProjectName();

  if (modelIds) {
    const restored = modelIds.filter((id) => modelById(id)?.onnxAvailable);
    state.modelIds = new Set(
      restored.length > 0
        ? restored
        : state.models.filter((model) => model.onnxAvailable).map((model) => model.id),
    );
    saveModelSelection();
    renderModelStatus();
  }
}

function newProject() {
  if (state.detecting) return;
  if (state.files.length > 0 && !window.confirm('新建项目会清空当前研判内容，是否继续？')) return;

  clearResults();
  resetProject();
  el.uploadHint.textContent = '已新建鉴别项目，添加图片后将自动分析。';
  updateActionButtons();
}

/** 保存为本地 .aigcproj 项目文件（内含原图、热力图与复核状态） */
async function saveProject() {
  if (state.pdfExporting) return;
  const name = projectDisplayName();
  state.project.name = name;

  await Promise.all(state.files.map(async (item) => {
    if (!item.image && item.file) {
      try {
        item.image = await readFileAsDataURL(item.file);
      } catch (error) {
        item.image = null;
      }
    }
    if (!item.thumb && item.preview) await createThumbnail(item);
  }));

  const payload = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name,
    createdAt: state.project.createdAt,
    updatedAt: Date.now(),
    modelIds: activeModelIds(),
    items: state.files.map((item) => ({
      key: item.key,
      image: item.image ?? null,
      thumb: item.thumb ?? null,
      review: item.review ?? null,
      results: item.results.map((result) => ({
        model: result.model,
        label: result.label,
        confidence: result.confidence ?? null,
        reason: result.reason ?? null,
        prompt: result.prompt ?? null,
        providerModel: result.providerModel ?? null,
        fakeProbability: result.fakeProbability,
        realProbability: result.realProbability,
        elapsedMs: result.elapsedMs,
        receivedAt: result.receivedAt,
        heatmap: result.heatmap ?? null,
        heatmapSize: result.heatmapSize ?? null,
      })),
    })),
  };

  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  downloadBlob(blob, `${sanitizeFilename(name)}.aigcproj`);
  state.project.updatedAt = Date.now();
  state.project.dirty = false;
  el.uploadHint.textContent = `项目已保存到本地（${state.files.length} 张图片）。`;
}

/** 读取 .aigcproj 项目文件并恢复图片、热力图、复核状态与模型选择 */
async function loadProjectFile(file) {
  if (state.detecting) {
    el.uploadHint.textContent = '正在分析图片，请稍后再加载项目。';
    return;
  }

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || data.format !== PROJECT_FORMAT) {
      throw new Error('不是有效的鉴别项目文件');
    }

    const name = data.name || file.name.replace(/\.aigcproj$/i, '') || '未命名鉴别项目';
    const items = Array.isArray(data.items) ? data.items : [];
    const modelIds = Array.isArray(data.modelIds) ? data.modelIds : [];

    clearResults();
    resetProject({ name, createdAt: data.createdAt || Date.now(), modelIds });

    for (const entry of items) {
      const results = Array.isArray(entry.results)
        ? entry.results.map((result) => ({ ...result }))
        : [];
      const item = {
        key: uniqueKey(entry.key || '图片'),
        file: null,
        status: results.length > 0 ? 'done' : 'queued',
        result: results[results.length - 1] ?? null,
        results,
        error: null,
        expanded: results.length > 1,
        inferring: false,
        preview: entry.image || entry.thumb || '',
        image: entry.image ?? null,
        thumb: entry.thumb ?? null,
        review: entry.review ?? null,
        restored: !entry.image,
      };

      if (entry.image) {
        try {
          const blob = await (await fetch(entry.image)).blob();
          item.file = new File([blob], item.key, { type: blob.type || 'image/png' });
        } catch (error) {
          item.file = null;
        }
      }

      state.files.push(item);
      renderRow(item);
    }

    state.project.dirty = false;
    renderStats();
    updateQueueSummary();
    updateEmptyState();
    updateActionButtons();
    el.uploadHint.textContent = `已加载项目「${name}」（${state.files.length} 张图片）。`;
  } catch (error) {
    el.uploadHint.textContent = `加载项目失败：${error.message}`;
  }
}

function toggleProjectMenu(force) {
  if (!el.projectDropdown || !el.projectMenuBtn) return;
  const open = force ?? el.projectDropdown.hidden;
  el.projectDropdown.hidden = !open;
  el.projectMenuBtn.setAttribute('aria-expanded', String(open));
}

function handleProjectAction(action) {
  toggleProjectMenu(false);
  if (action === 'new') newProject();
  else if (action === 'load') el.projectFile.click();
  else if (action === 'save') saveProject();
}

function timestampForFilename() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/* ===== 导出 Excel ===== */

function exportExcel() {
  const done = state.files.filter((item) => item.status === 'done' && item.results.length > 0);
  if (done.length === 0) return;

  const maxResults = Math.max(...done.map((item) => item.results.length));
  const headers = ['文件名', '人工复核', '模型数', '最高伪造概率', '最高置信度', '总耗时(ms)'];
  for (let i = 0; i < maxResults; i += 1) headers.push(`研判 ${i + 1}`);

  const rows = done.map((item) => {
    const maxFake = Math.max(...item.results.map((result) => result.fakeProbability));
    const maxConfidence = Math.max(
      ...item.results.map((result) => Math.max(result.fakeProbability, result.realProbability)),
    );
    const row = [
      item.key,
      reviewText(item.review),
      String(item.results.length),
      formatPercent(maxFake),
      formatPercent(maxConfidence),
      item.results.reduce((sum, result) => sum + result.elapsedMs, 0),
    ];
    for (const result of item.results) {
      row.push(
        `${modelDisplayName(result.model)} · ${result.label === 'fake' ? '伪造' : '真实'}`
        + ` · 伪造 ${formatPercent(result.fakeProbability)} · ${result.elapsedMs} ms`,
      );
    }
    while (row.length < headers.length) row.push('');
    return row;
  });

  const table = '<table border="1">'
    + `<thead><tr>${headers.map((head) => `<th>${escapeHtml(head)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
    + '</table>';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${table}</body></html>`;
  const blob = new Blob(['\ufeff', html], { type: 'application/vnd.ms-excel;charset=utf-8' });
  downloadBlob(blob, `AIGC研判报告-${sanitizeFilename(state.project.name)}-${timestampForFilename()}.xls`);
}

function exportJson() {
  const payload = {
    project: state.project.name,
    exported_at: new Date().toISOString(),
    models: activeModelIds(),
    images: {},
  };

  for (const item of state.files) {
    if (item.results.length === 0) continue;
    payload.images[item.key] = {
      review: item.review ?? null,
      results: item.results.map((result) => ({
        model: result.model,
        label: result.label,
        confidence: result.confidence ?? null,
        reason: result.reason ?? null,
        prompt: result.prompt ?? null,
        provider_model: result.providerModel ?? null,
        fake_probability: Number(result.fakeProbability.toFixed(6)),
        real_probability: Number(result.realProbability.toFixed(6)),
        elapsed_ms: result.elapsedMs,
        received_at: result.receivedAt ?? null,
      })),
    };
  }

  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    `AIGC研判结果-${sanitizeFilename(state.project.name)}-${timestampForFilename()}.json`,
  );
}

function clearResults() {
  if (el.detailDrawer.classList.contains('open')) closeDetail();

  for (const item of state.files) {
    if (typeof item.preview === 'string' && item.preview.startsWith('blob:')) {
      URL.revokeObjectURL(item.preview);
    }
  }
  state.files = [];
  state.selected.clear();
  state.detailKey = null;
  rows.clear();

  // 清空主表格
  if (el.resultsBody) el.resultsBody.innerHTML = '';
  // 清空全量表格
  if (el.resultsBodyFull) el.resultsBodyFull.innerHTML = '';

  el.uploadHint.textContent = '';
  markProjectDirty();
  renderStats();
  updateQueueSummary();
  updateEmptyState();
  updateActionButtons();
}

/* ===== 详情侧边栏 ===== */

// 蓝 → 青 → 绿 → 黄 → 红，数值越高越支持「伪造」方向
const HEAT_STOPS = [
  [0.0, 37, 52, 148],
  [0.25, 65, 182, 196],
  [0.5, 127, 205, 120],
  [0.75, 253, 219, 109],
  [1.0, 215, 48, 39],
];

function heatColor(value) {
  const t = Math.max(0, Math.min(1, value));
  for (let i = 1; i < HEAT_STOPS.length; i += 1) {
    const [p1, r1, g1, b1] = HEAT_STOPS[i];
    if (t <= p1) {
      const [p0, r0, g0, b0] = HEAT_STOPS[i - 1];
      const k = (t - p0) / (p1 - p0 || 1);
      return [
        Math.round(r0 + (r1 - r0) * k),
        Math.round(g0 + (g1 - g0) * k),
        Math.round(b0 + (b1 - b0) * k),
      ];
    }
  }
  const [, r, g, b] = HEAT_STOPS[HEAT_STOPS.length - 1];
  return [r, g, b];
}

/** 把原图与热力图叠加绘制到 canvas，返回是否成功绘制热力图 */
function paintHeatmap(ctx, size, image, result) {
  ctx.clearRect(0, 0, size, size);
  // 与后端预处理保持一致：原图直接拉伸，热力图网格才能和画面精确对齐
  ctx.drawImage(image, 0, 0, size, size);

  const heatmap = result.heatmap;
  const grid = result.heatmapSize;
  if (!Array.isArray(heatmap) || !grid || heatmap.length !== grid * grid) return false;

  // 用 5%~95% 分位数做归一化，避免个别极值把整张图压成单色
  const sorted = [...heatmap].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.05)];
  const hi = sorted[Math.floor(sorted.length * 0.95)];
  let span = hi - lo;
  if (span <= 0) {
    span = Math.max(...heatmap) - Math.min(...heatmap) || 1;
    if (span <= 0) span = 1;
  }

  // 先把 16×16 的响应写成小图，再放大绘制，得到平滑过渡的热力图
  const cellCanvas = document.createElement('canvas');
  cellCanvas.width = grid;
  cellCanvas.height = grid;
  const cellCtx = cellCanvas.getContext('2d');
  const pixels = cellCtx.createImageData(grid, grid);

  for (let i = 0; i < heatmap.length; i += 1) {
    const t = Math.max(0, Math.min(1, (heatmap[i] - lo) / span));
    const [r, g, b] = heatColor(t);
    const offset = i * 4;
    pixels.data[offset] = r;
    pixels.data[offset + 1] = g;
    pixels.data[offset + 2] = b;
    pixels.data[offset + 3] = Math.round(t * 220);
  }
  cellCtx.putImageData(pixels, 0, 0);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cellCanvas, 0, 0, size, size);
  ctx.restore();
  return true;
}

async function drawHeatmap(canvas, emptyEl, item, result) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  if (emptyEl) emptyEl.hidden = true;

  const image = await loadPreviewImage(item);
  if (!image) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }

  const painted = paintHeatmap(ctx, size, image, result);
  if (!painted && emptyEl) emptyEl.hidden = false;
}

/** 导出单条结果的热力图（用于 PDF 报告） */
async function heatmapDataUrl(item, result, size = 420) {
  const image = await loadPreviewImage(item);
  if (!image) return null;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  paintHeatmap(ctx, size, image, result);
  return canvas.toDataURL('image/png');
}

/* ===== 人工复核 ===== */

function reviewText(review) {
  if (!review) return '尚未人工复核';
  if (review.status === 'confirmed') return '人工复核：已确认机器判定';
  if (review.status === 'misjudged') {
    if (!review.label) return '人工复核：已标记误判，请选择实际标签';
    return `人工复核：误判 · 实际为${review.label === 'fake' ? '伪造' : '真实'}`;
  }
  return '尚未人工复核';
}

function renderReviewBlock(container, item) {
  const review = item.review;
  const statusClass = review ? `is-${review.status}` : '';

  container.innerHTML = `
    <div class="review-status ${statusClass}">
      <span class="review-dot"></span>
      <span class="review-text">${reviewText(review)}</span>
    </div>
    <div class="review-actions">
      ${review?.status === 'confirmed'
        ? '<button type="button" class="btn btn-small" data-review="clear">撤销复核</button>'
        : '<button type="button" class="btn btn-small" data-review="confirmed">确认判定</button>'}
      ${review?.status === 'misjudged'
        ? '<button type="button" class="btn btn-small" data-review="clear">撤销复核</button>'
        : '<button type="button" class="btn btn-small" data-review="misjudged">标记为误判</button>'}
    </div>
    ${review?.status === 'misjudged'
      ? `<div class="review-labels">
           <span>实际标签：</span>
           <button type="button" class="btn btn-small ${review.label === 'fake' ? 'is-selected' : ''}" data-review-label="fake">伪造</button>
           <button type="button" class="btn btn-small ${review.label === 'real' ? 'is-selected' : ''}" data-review-label="real">真实</button>
         </div>`
      : ''}`;
}

function renderDetailSummary(item) {
  if (!el.detailSummary) return;
  el.detailSummary.innerHTML = '';

  if (item.results.length === 0) {
    el.detailSummary.hidden = true;
    return;
  }
  el.detailSummary.hidden = false;

  const card = document.createElement('section');
  card.className = 'review-card';
  card.innerHTML = `
    <div class="review-card-head">
      <span class="review-card-title">人工复核</span>
      <span class="review-card-count">${item.results.length} 个模型结果</span>
    </div>
    <div class="review-card-body"></div>`;

  renderReviewBlock(card.querySelector('.review-card-body'), item);
  el.detailSummary.appendChild(card);
}

/** 详情里点击「确认判定 / 标记为误判 / 撤销复核」 */
function handleReviewClick(event) {
  const item = state.files.find((file) => file.key === state.detailKey);
  if (!item) return;

  const labelButton = event.target.closest('[data-review-label]');
  if (labelButton) {
    item.review = { status: 'misjudged', label: labelButton.dataset.reviewLabel, at: Date.now() };
  } else {
    const actionButton = event.target.closest('[data-review]');
    if (!actionButton) return;
    const action = actionButton.dataset.review;
    if (action === 'clear') item.review = null;
    else item.review = { status: action, label: null, at: Date.now() };
  }

  renderDetailSummary(item);
  renderRow(item);
  markProjectDirty();
}

/** 单条结果详情列，内部布局与原来的单列详情一致 */
function buildDetailColumn(item, result, index, total) {
  const column = document.createElement('div');
  column.className = 'detail-column';

  const isFake = result.label === 'fake';
  const confidence = isFake ? result.fakeProbability : result.realProbability;
  const modelId = result.model ?? '';

  const head = total > 1
    ? `<div class="detail-column-head">
         <span class="detail-column-index">结果 ${index + 1}</span>
         <span class="detail-column-time mono">${formatClock(result.receivedAt)}</span>
       </div>`
    : '';

  column.innerHTML = `
    ${head}
    <div class="detail-verdict-row">
      ${verdictTagHtml(isFake)}
      <span class="detail-confidence mono">${formatPercent(confidence)}</span>
    </div>

    <div class="prob-split" title="伪造 / 真实 概率">
      <span class="prob-split-fake" style="width: ${(result.fakeProbability * 100).toFixed(2)}%"></span>
      <span class="prob-split-real" style="width: ${(result.realProbability * 100).toFixed(2)}%"></span>
    </div>
    <div class="prob-split-labels">
      <span>伪造 <b class="mono">${formatPercent(result.fakeProbability)}</b></span>
      <span>真实 <b class="mono">${formatPercent(result.realProbability)}</b></span>
    </div>

    <div class="detail-metrics">
      <div class="detail-metric">
        <span class="detail-metric-label">推理耗时</span>
        <strong class="mono">${result.elapsedMs} ms</strong>
      </div>
      <div class="detail-metric">
        <span class="detail-metric-label">伪造概率</span>
        <strong class="mono">${formatPercent(result.fakeProbability)}</strong>
      </div>
    </div>

    ${result.reason
      ? `<section class="detail-section">
           <div class="detail-section-head"><h3>多模态判定理由</h3></div>
           <p class="detail-value">${escapeHtml(result.reason)}</p>
         </section>`
      : ''}

    <section class="detail-section">
      <div class="detail-section-head">
        <h3>模型热力图</h3>
      </div>
      <div class="heatmap-frame">
        <canvas width="448" height="448"></canvas>
        <span class="heatmap-empty" hidden>暂无热力图数据</span>
      </div>
      <div class="heatmap-legend">
        <span>低</span>
        <div class="heatmap-gradient"></div>
        <span>高</span>
      </div>
      <p class="hint">
        *颜色越暖表示该区域越支持当前判定。
      </p>
    </section>

    <section class="detail-section">
      <div class="detail-section-head">
        <h3>使用模型</h3>
      </div>
      <p class="detail-value"></p>
      <p class="hint detail-model-id"></p>
    </section>`;

  const modelName = column.querySelector('.detail-value');
  modelName.textContent = modelDisplayName(modelId);
  const modelHint = column.querySelector('.detail-model-id');
  modelHint.textContent = modelId
    ? `${result.providerModel ? `提供商模型 · ${result.providerModel} · ` : ''}模型标识 · ${modelId}`
    : '';

  drawHeatmap(
    column.querySelector('canvas'),
    column.querySelector('.heatmap-empty'),
    item,
    result,
  );

  return column;
}

/* ===== 项目报告导出 ===== */

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function buildProjectPdfHtml(pages, stats) {
  const reportDate = new Date().toLocaleString('zh-CN');
  const createdAt = new Date(state.project.createdAt).toLocaleString('zh-CN');
  const projectName = escapeHtml(state.project.name);
  const modelNames = [...new Set(
    pages.flatMap(({ item }) => item.results.map((result) => modelDisplayName(result.model))),
  )];
  const reviewed = pages.filter(({ item }) => item.review).length;

  const cover = `
    <section class="page cover">
      <div class="cover-top">
        <div class="cover-mark">AIGC · 鉴别报告</div>
        <h1>${projectName}</h1>
        <p class="cover-sub">AI 生成图像鉴别项目报告</p>
      </div>
      <div class="cover-stats">
        <div><span>图片总数</span><strong>${pages.length}</strong></div>
        <div><span>模型结果</span><strong>${stats.resultCount}</strong></div>
        <div><span>判定伪造</span><strong class="fake">${stats.fakeCount}</strong></div>
        <div><span>判定真实</span><strong class="real">${stats.realCount}</strong></div>
        <div><span>已复核</span><strong>${reviewed}</strong></div>
      </div>
      <div class="cover-models">
        <h2>本次使用的模型</h2>
        <p>${modelNames.length ? modelNames.map((name) => escapeHtml(name)).join(' 、 ') : '—'}</p>
      </div>
      <div class="cover-foot">
        <span>项目创建：${createdAt}</span>
        <span>报告生成：${reportDate}</span>
      </div>
    </section>`;

  const itemPages = pages.map(({ item, original, heats }, index) => {
    const latest = item.results[item.results.length - 1];
    const totalMs = item.results.reduce((sum, result) => sum + result.elapsedMs, 0);
    const cards = item.results.map((result, resultIndex) => {
      const isFake = result.label === 'fake';
      const heat = heats[resultIndex];
      return `
        <div class="result-card">
          <div class="result-card-head">
            <span class="result-no">研判 ${resultIndex + 1}</span>
            <strong class="result-model">${escapeHtml(modelDisplayName(result.model))}</strong>
            <span class="result-verdict ${isFake ? 'fake' : 'real'}">${isFake ? '伪造' : '真实'} · ${formatPercent(confidenceOf(result))}</span>
          </div>
          <div class="result-body">
            ${heat ? `<img class="heat" src="${heat}" alt="热力图">` : '<div class="heat heat-empty">无热力图数据</div>'}
            <dl class="result-meta">
              <div><dt>伪造概率</dt><dd>${formatPercent(result.fakeProbability)}</dd></div>
              <div><dt>真实概率</dt><dd>${formatPercent(result.realProbability)}</dd></div>
              <div><dt>置信度</dt><dd>${formatPercent(confidenceOf(result))}</dd></div>
              <div><dt>推理耗时</dt><dd>${result.elapsedMs} ms</dd></div>
              <div><dt>研判时间</dt><dd>${result.receivedAt ? new Date(result.receivedAt).toLocaleString('zh-CN') : '—'}</dd></div>
              <div><dt>模型标识</dt><dd class="mono">${escapeHtml(result.model ?? '—')}</dd></div>
            </dl>
          </div>
        </div>`;
    }).join('');

    return `
      <section class="page item-page">
        <div class="page-head">
          <span class="page-index">图片 ${index + 1} / ${pages.length}</span>
          <h2>${escapeHtml(item.key)}</h2>
        </div>
        <div class="item-overview">
          ${original
            ? `<img class="item-image" src="${original}" alt="${escapeHtml(item.key)}">`
            : '<div class="item-image item-image-empty">无原图</div>'}
          <dl class="item-meta">
            <div><dt>参与模型</dt><dd>${item.results.length} 个</dd></div>
            <div><dt>总推理耗时</dt><dd>${totalMs} ms</dd></div>
            <div><dt>最近研判时间</dt><dd>${latest.receivedAt ? new Date(latest.receivedAt).toLocaleString('zh-CN') : '—'}</dd></div>
            <div><dt>人工复核</dt><dd>${escapeHtml(reviewText(item.review))}</dd></div>
          </dl>
        </div>
        <div class="result-grid">${cards}</div>
      </section>`;
  }).join('');

  const backCover = `
    <section class="page back-cover">
      <div class="back-top">
        <div class="cover-mark">AIGC · 鉴别报告</div>
        <h1>报告说明</h1>
      </div>
      <div class="back-body">
        <p>本报告由 AI 生成图像鉴别平台根据当前项目数据自动生成，包含每张图片各模型的判定、置信度、推理耗时与热力图证据。</p>
        <ul>
          <li>各模型判定基于对应权重文件的输出概率，不同模型结论可能存在差异。</li>
          <li>人工复核记录仅代表操作者的标注，不改变模型原始输出。</li>
          <li>报告结论仅供辅助研判，不构成最终法律或事实认定。</li>
        </ul>
      </div>
      <div class="back-foot">
        <span>${projectName}</span>
        <span>生成时间：${reportDate}</span>
      </div>
    </section>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${projectName} - AIGC 鉴别报告</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #111827; font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; font-size: 11px; line-height: 1.55; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1, h2, h3 { margin: 0; }
  .page { page-break-after: always; min-height: 272mm; display: flex; flex-direction: column; }
  .page:last-child { page-break-after: auto; }
  .cover { justify-content: space-between; padding: 10mm 6mm; }
  .cover-mark { font-size: 10px; letter-spacing: .3em; text-transform: uppercase; color: #2563eb; font-weight: 700; }
  .cover-top h1 { margin-top: 8mm; font-size: 34px; line-height: 1.25; letter-spacing: .01em; color: #0f172a; max-width: 150mm; word-break: break-all; }
  .cover-sub { margin: 4mm 0 0; font-size: 13px; color: #64748b; }
/* 垂直列表容器 */
.cover-stats {
  display: flex;
  flex-direction: column;
  border: 1px solid #cbd5e1; /* 统一的冷灰边框 */
  border-radius: 2px; /* 极小圆角，保持硬朗 */
  background: #ffffff;
  margin-bottom: 6mm; /* 与下方内容留出间距 */
}

/* 每一行数据 */
.cover-stats div {
  display: flex;
  justify-content: space-between; /* 标签在左，数字在右 */
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid #e2e8f0; /* 行与行之间的细分割线 */
}

/* 去除最后一行的底边框 */
.cover-stats div:last-child {
  border-bottom: none;
}

/* 左侧标签 */
.cover-stats span {
  font-size: 13px;
  color: #475569; /* 沉稳的深灰色 */
  font-weight: 500;
}

/* 右侧数字 */
.cover-stats strong {
  font-size: 16px;
  font-weight: 600;
  color: #0f172a; /* 近乎纯黑的深色，凸显数据 */
  font-variant-numeric: tabular-nums; /* 保证数字等宽，绝对对齐 */
}

/* 颜色标识保持沉稳 */
.cover-stats .fake { color: #b91c1c; }
.cover-stats .real { color: #047857; }
  .cover-models { border-left: 3px solid #2563eb; padding: 1mm 0 1mm 4mm; }
  .cover-models h2 { font-size: 12px; color: #0f172a; }
  .cover-models p { margin: 2mm 0 0; color: #475569; }
  .cover-foot { display: flex; justify-content: space-between; padding-top: 4mm; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 9px; }
  .page-head { display: flex; align-items: baseline; gap: 10px; padding-bottom: 3mm; margin-bottom: 4mm; border-bottom: 2px solid #111827; }
  .page-index { font-size: 9px; color: #64748b; letter-spacing: .08em; white-space: nowrap; }
  .page-head h2 { font-size: 16px; word-break: break-all; }
  .item-overview { display: flex; gap: 6mm; align-items: flex-start; margin-bottom: 4mm; }
  .item-image { width: 52mm; height: 52mm; object-fit: contain; border: 1px solid #e2e8f0; border-radius: 3mm; background: #fff; flex: none; }
  .item-image-empty { display: flex; align-items: center; justify-content: center; background: #f1f5f9; color: #94a3b8; font-size: 10px; }
  .item-meta { flex: 1; margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 1mm 6mm; align-content: start; }
  .item-meta div { display: flex; justify-content: space-between; gap: 8px; padding: 1mm 0; border-bottom: 1px dotted #e2e8f0; }
  .item-meta dt { color: #64748b; }
  .item-meta dd { margin: 0; font-weight: 600; text-align: right; }
  .result-grid { display: grid; grid-template-columns: 1fr; gap: 3mm; }
  .result-card { border: 1px solid #e2e8f0; border-radius: 3mm; padding: 3mm; page-break-inside: avoid; background: #fff; width: 100%; box-sizing: border-box; }
  .result-card-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2mm 3mm; }
  .result-no { font-size: 8px; letter-spacing: .08em; color: #94a3b8; }
  .result-model { flex: 1; font-size: 11px; }
  .result-verdict { font-weight: 700; font-size: 10px; }
  .result-verdict.fake { color: #dc2626; }
  .result-verdict.real { color: #059669; }
  .result-body { display: flex; gap: 3mm; margin-top: 2mm; }
  .heat { width: 30mm; height: 30mm; object-fit: cover; border-radius: 2mm; border: 1px solid #e2e8f0; flex: none; }
  .heat-empty { display: flex; align-items: center; justify-content: center; background: #f1f5f9; color: #94a3b8; font-size: 9px; }
  .result-meta { flex: 1; margin: 0; display: grid; grid-template-columns: 1fr; gap: 0; align-content: start; }
  .result-meta div { display: flex; justify-content: space-between; gap: 6px; padding: 1mm 0; border-bottom: 1px dotted #f1f5f9; }
  .result-meta dt { color: #64748b; font-size: 9px; }
  .result-meta dd { margin: 0; font-weight: 600; font-size: 9px; text-align: right; word-break: break-all; }
  .mono { font-family: Consolas, monospace; }
  .back-cover { justify-content: space-between; padding: 14mm 6mm; }
  .back-top h1 { margin-top: 6mm; font-size: 26px; }
  .back-body { margin-top: 8mm; color: #334155; }
  .back-body p { margin: 0 0 4mm; font-size: 12px; line-height: 1.8; }
  .back-body ul { margin: 0; padding-left: 5mm; font-size: 11px; line-height: 2; color: #475569; }
  .back-foot { display: flex; justify-content: space-between; padding-top: 4mm; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 9px; }
  .hint-print { position: fixed; left: 0; right: 0; bottom: 10mm; text-align: center; color: #64748b; font-size: 10px; }
  @media print { .hint-print { display: none; } }
</style>
</head>
<body>
${cover}
${itemPages}
${backCover}
<p class="hint-print">若需保存为 PDF，请在打印对话框中选择“另存为 PDF”。</p>
<script>window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 400); });<\/script>
</body>
</html>`;
}

/** 生成项目级多页报告：封面 + 每张图片一页 + 封底 */
async function exportPdfReport() {
  if (state.pdfExporting) return;

  const items = state.files.filter((item) => item.results.length > 0);
  if (items.length === 0) {
    el.uploadHint.textContent = '暂无可导出的研判结果。';
    return;
  }

  state.pdfExporting = true;
  const buttons = [el.exportPdfBtn, el.exportPdfBtnFull].filter(Boolean);
  for (const button of buttons) {
    button.disabled = true;
    button.textContent = '生成中…';
  }

  try {
    const pages = await Promise.all(items.map(async (item) => {
      let original = item.image || null;
      if (!original && item.file) {
        try {
          original = await readFileAsDataURL(item.file);
        } catch (error) {
          original = null;
        }
      }
      if (!original && item.preview) original = item.preview;

      const heats = await Promise.all(
        item.results.map((result) => heatmapDataUrl(item, result, 360).catch(() => null)),
      );
      return { item, original, heats };
    }));

    const resultCount = pages.reduce((sum, { item }) => sum + item.results.length, 0);
    const fakeCount = pages.filter(({ item }) => aggregateMetrics(item)?.label === 'fake').length;
    const stats = { resultCount, fakeCount, realCount: pages.length - fakeCount };

    const reportHtml = buildProjectPdfHtml(pages, stats);
    const reportUrl = URL.createObjectURL(new Blob([reportHtml], { type: 'text/html;charset=utf-8' }));
    const win = window.open(reportUrl, '_blank');
    if (!win) {
      URL.revokeObjectURL(reportUrl);
      el.uploadHint.textContent = '浏览器拦截了报告窗口，请允许弹出窗口后重试。';
      return;
    }
    // 报告窗口加载完成后即可释放 ObjectURL
    setTimeout(() => URL.revokeObjectURL(reportUrl), 60000);
  } finally {
    state.pdfExporting = false;
    for (const button of buttons) {
      button.disabled = false;
      button.textContent = '导出 PDF 报告';
    }
    renderStats();
  }
}

function openDetail(key, activeIndex) {
  const item = state.files.find((file) => file.key === key);
  if (!item || item.results.length === 0) return;

  state.detailKey = key;
  el.detailName.textContent = item.key;
  el.detailName.title = item.key;
  renderDetailSummary(item);

  const total = item.results.length;
  const columns = item.results.map((result, index) =>
    buildDetailColumn(item, result, index, total),
  );

  el.detailColumns.innerHTML = '';
  el.detailColumns.classList.toggle('single', total === 1);
  for (const column of columns) el.detailColumns.appendChild(column);

  const active = Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < total
    ? activeIndex
    : total - 1;
  columns[active]?.classList.add('is-active');

  // 多结果时按列数横向铺开，列内布局不变
  const naturalWidth = total * 300 + (total - 1) * 18 + 40;
  const width = total === 1
    ? Math.min(420, window.innerWidth - 24)
    : Math.min(naturalWidth, window.innerWidth - 24);
  el.detailDrawer.style.width = `${width}px`;

  el.detailDrawer.classList.add('open');
  el.detailDrawer.setAttribute('aria-hidden', 'false');
  el.detailOverlay.hidden = false;
  // 先取消 hidden 再加 class，保证滑入动画生效
  requestAnimationFrame(() => {
    el.detailOverlay.classList.add('open');
    columns[active]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // 多列时只保留横向滚动，顶部人工复核卡片始终可见
    const scroller = el.detailDrawer.querySelector('.drawer-body');
    if (scroller) scroller.scrollTop = 0;
  });
  document.body.classList.add('drawer-open');
}

function closeDetail() {
  el.detailDrawer.classList.remove('open');
  el.detailDrawer.setAttribute('aria-hidden', 'true');
  el.detailOverlay.classList.remove('open');
  document.body.classList.remove('drawer-open');

  setTimeout(() => {
    if (!el.detailDrawer.classList.contains('open')) {
      el.detailOverlay.hidden = true;
    }
  }, 260);
}

function bindRowEvents(body) {
  if (!body) return;

  body.addEventListener('click', (event) => {
    // 展开/收起某一组的子结果
    const toggle = event.target.closest('.group-toggle');
    if (toggle) {
      const row = toggle.closest('tr[data-key]');
      const item = row && state.files.find((file) => file.key === row.dataset.key);
      if (item) {
        item.expanded = !item.expanded;
        renderRow(item);
      }
      return;
    }

    // 勾选框交给 change 事件处理，不触发详情
    if (event.target.closest('input')) return;

    const row = event.target.closest('tr[data-key]');
    if (!row) return;
    const index = row.dataset.index === undefined ? undefined : Number(row.dataset.index);
    openDetail(row.dataset.key, index);
  });

  body.addEventListener('change', (event) => {
    const checkbox = event.target.closest('.row-select');
    if (!checkbox) return;

    const row = checkbox.closest('tr[data-key]');
    if (!row) return;

    if (checkbox.checked) state.selected.add(row.dataset.key);
    else state.selected.delete(row.dataset.key);

    applySelectionState(row.dataset.key);
    updateActionButtons();
  });

  // 键盘操作：聚焦到行后回车/空格同样可以打开详情
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('input, button')) return;

    const row = event.target.closest('tr[data-key]');
    if (!row) return;
    event.preventDefault();
    const index = row.dataset.index === undefined ? undefined : Number(row.dataset.index);
    openDetail(row.dataset.key, index);
  });
}

function bindEvents() {
  el.pickFiles.addEventListener('click', () => el.fileInput.click());
  el.pickDir.addEventListener('click', () => el.dirInput.click());

  el.fileInput.addEventListener('change', () => {
    addFiles(el.fileInput.files, false);
    el.fileInput.value = '';
  });
  el.dirInput.addEventListener('change', () => {
    addFiles(el.dirInput.files, true);
    el.dirInput.value = '';
  });

  el.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    el.dropzone.classList.add('dragover');
  });
  el.dropzone.addEventListener('dragleave', () => el.dropzone.classList.remove('dragover'));
  el.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    el.dropzone.classList.remove('dragover');
    addFiles(event.dataTransfer.files, false);
  });

  if (el.exportBtn) el.exportBtn.addEventListener('click', exportJson);
  if (el.clearBtn) el.clearBtn.addEventListener('click', clearResults);

  if (el.inferBtn) el.inferBtn.addEventListener('click', runSelectedInference);
  if (el.inferBtnFull) el.inferBtnFull.addEventListener('click', runSelectedInference);

  if (el.exportPdfBtn) el.exportPdfBtn.addEventListener('click', exportPdfReport);
  if (el.exportPdfBtnFull) el.exportPdfBtnFull.addEventListener('click', exportPdfReport);

  if (el.exportXlsxBtn) el.exportXlsxBtn.addEventListener('click', exportExcel);
  if (el.exportXlsxFull) el.exportXlsxFull.addEventListener('click', exportExcel);
  for (const select of [el.filterSelect, el.filterSelectFull]) {
    if (!select) continue;
    select.addEventListener('change', () => handleFilterChange(select.value));
  }

  // 模型下拉选单：点击展开/收起，点击外部或 Esc 关闭
  if (el.modelSelectToggle) {
    el.modelSelectToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleProjectMenu(false);
      toggleModelDropdown();
    });
  }
  if (el.modelSelect) {
    el.modelSelect.addEventListener('click', (event) => event.stopPropagation());
  }

  if (el.multimodalPrompt) {
    el.multimodalPrompt.value = readMultimodalPrompt();
    el.multimodalPrompt.addEventListener('input', () => saveMultimodalPrompt(el.multimodalPrompt.value));
  }

  if (el.providerForm) {
    el.providerForm.addEventListener('submit', saveProviderSettings);
  }

  // 项目菜单：新建 / 加载本地鉴别项目 / 保存到本地
  if (el.projectMenuBtn) {
    el.projectMenuBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleModelDropdown(false);
      toggleProjectMenu();
    });
  }
  if (el.projectDropdown) {
    el.projectDropdown.addEventListener('click', (event) => {
      const button = event.target.closest('[data-project-action]');
      if (button) handleProjectAction(button.dataset.projectAction);
    });
  }
  document.addEventListener('click', () => {
    toggleProjectMenu(false);
    toggleModelDropdown(false);
  });
  if (el.projectName) {
    el.projectName.addEventListener('input', () => {
      state.project.name = projectDisplayName();
      markProjectDirty();
    });
    el.projectName.addEventListener('blur', syncProjectName);
  }
  if (el.projectFile) {
    el.projectFile.addEventListener('change', () => {
      const file = el.projectFile.files?.[0];
      if (file) loadProjectFile(file);
      el.projectFile.value = '';
    });
  }

  // 点击表头排序
  for (const header of document.querySelectorAll('.table-header')) {
    header.addEventListener('click', (event) => {
      const th = event.target.closest('th[data-sort]');
      if (th) handleSort(th.dataset.sort);
    });
  }

  bindRowEvents(el.resultsBody);
  bindRowEvents(el.resultsBodyFull);

  // 详情内的人工复核
  if (el.detailSummary) el.detailSummary.addEventListener('click', handleReviewClick);

  // 全局粘贴图片
  document.addEventListener('paste', handlePaste);

  el.detailClose.addEventListener('click', closeDetail);
  el.detailOverlay.addEventListener('click', closeDetail);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    toggleModelDropdown(false);
    if (el.detailDrawer.classList.contains('open')) {
      closeDetail();
    }
  });

  const exportBtnFull = document.getElementById('export-json-full');
  const clearBtnFull = document.getElementById('clear-results-full');

  if (exportBtnFull) exportBtnFull.addEventListener('click', exportJson);
  if (clearBtnFull) clearBtnFull.addEventListener('click', clearResults);
}

async function init() {
  initTheme();
  initNavigation();
  bindEvents();
  syncFilterControls();
  renderSortIndicators();
  updateEmptyState();
  syncProjectName();
  renderStats(); // 这里已经包含了图表初始化，不需要额外再写 renderHistogram([])

  try {
    await refreshModels();
  } catch (error) {
    el.modelStatus.textContent = `无法获取模型列表：${error.message}`;
  }

  await loadProviderSettings();
}

/* ===== 主题切换逻辑 ===== */
function initTheme() {
  const switcher = document.getElementById('theme-switcher');
  if (!switcher) return;

  const buttons = switcher.querySelectorAll('button');
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

  // 获取本地存储的主题，默认跟随系统
  let currentTheme = localStorage.getItem('app-theme') || 'system';

  function applyTheme(theme) {
    let finalTheme = theme;
    if (theme === 'system') {
      finalTheme = mediaQuery.matches ? 'dark' : 'light';
    }
    
    // 设置 html 标签的 data-theme 属性
    document.documentElement.setAttribute('data-theme', finalTheme);
    
    // 更新按钮的激活状态
    buttons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeVal === theme);
    });
  }

  // 初始化应用
  applyTheme(currentTheme);

  // 绑定按钮点击事件
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      currentTheme = btn.dataset.themeVal;
      localStorage.setItem('app-theme', currentTheme);
      applyTheme(currentTheme);
    });
  });

  // 监听系统主题变化（当用户选择"跟随系统"时生效）
  mediaQuery.addEventListener('change', () => {
    if (localStorage.getItem('app-theme') === 'system' || !localStorage.getItem('app-theme')) {
      applyTheme('system');
    }
  });
}

/* ===== 页面视图切换 ===== */
function initNavigation() {
  const navButtons = document.querySelectorAll('.nav-btn');
  const views = document.querySelectorAll('.view');

  function switchView(targetId) {
    // 1. 更新按钮状态
    navButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.target === targetId);
    });

    // 2. 更新视图状态
    views.forEach(view => {
      view.classList.toggle('active', view.id === `view-${targetId}`);
    });
  }

  // 绑定点击事件
  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      switchView(target);
      
      // 如果用的是 hash 路由，可以更新 URL
      history.replaceState(null, null, `#${target}`);
    });
  });

  // 页面加载时，检查 URL Hash（支持刷新保持状态）
  const hash = window.location.hash.replace('#', '');
  if (hash && document.getElementById(`view-${hash}`)) {
    switchView(hash);
  }
}


init();