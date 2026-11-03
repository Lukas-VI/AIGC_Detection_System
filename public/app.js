const IMAGE_PATTERN = /\.(jpe?g|png|webp|tiff?|bmp)$/i;
const MODEL_STATUS_TEXT = {
  idle: '未加载',
  loading: '加载中',
  ready: '已就绪',
  error: '加载失败',
};

const el = {
  modelSelect: document.getElementById('model-select'),
  modelBadge: document.getElementById('model-badge'),
  modelStatus: document.getElementById('model-status'),
  loadBtn: document.getElementById('load-model'),
  unloadBtn: document.getElementById('unload-model'),
  progress: document.getElementById('load-progress'),
  progressBar: document.getElementById('load-progress-bar'),

  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  dirInput: document.getElementById('dir-input'),
  pickFiles: document.getElementById('pick-files'),
  pickDir: document.getElementById('pick-dir'),
  queueSummary: document.getElementById('queue-summary'),
  uploadHint: document.getElementById('upload-hint'),

  statTotal: document.getElementById('stat-total'),
  statDone: document.getElementById('stat-done'),
  statFake: document.getElementById('stat-fake'),
  statReal: document.getElementById('stat-real'),
  statRatio: document.getElementById('stat-ratio'),
  statAvg: document.getElementById('stat-avg'),
  avgTime: document.getElementById('avg-time'),
  histogram: document.getElementById('histogram'),

  exportBtn: document.getElementById('export-json'),
  clearBtn: document.getElementById('clear-results'),
  inferBtn: document.getElementById('infer-results'),
  resultsBody: document.getElementById('results-body'),
  resultsEmpty: document.getElementById('results-empty'),

  resultsBodyFull: document.getElementById('results-body-full'),
  resultsEmptyFull: document.getElementById('results-empty-full'),
  inferBtnFull: document.getElementById('infer-results-full'),

  detailOverlay: document.getElementById('detail-overlay'),
  detailDrawer: document.getElementById('detail-drawer'),
  detailClose: document.getElementById('detail-close'),
  detailName: document.getElementById('detail-name'),
  detailColumns: document.getElementById('detail-columns'),
};

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

function selectedModel() {
  return state.models.find((model) => model.id === el.modelSelect.value) ?? null;
}

/** 本次推理应使用的模型：下拉框选中的模型必须已经加载 */
function inferenceModelId() {
  const model = selectedModel();
  return model && model.status === 'ready' ? model.id : null;
}

function loadedModelCount() {
  return state.models.filter((model) => model.status === 'ready').length;
}

function renderModelSelect() {
  const previous = el.modelSelect.value;
  el.modelSelect.innerHTML = '';

  if (state.models.length === 0) {
    const option = new Option('未找到 weight/*.pth', '');
    option.disabled = true;
    el.modelSelect.add(option);
    return;
  }

  for (const model of state.models) {
    const label = model.onnxAvailable ? model.displayName : `${model.displayName}（未转换）`;
    const option = new Option(label, model.id);
    option.disabled = !model.onnxAvailable;
    el.modelSelect.add(option);
  }

  const preferred = [previous, state.activeId].find(
    (id) => id && state.models.some((model) => model.id === id && model.onnxAvailable),
  );
  el.modelSelect.value = preferred ?? state.models.find((model) => model.onnxAvailable)?.id ?? '';
}

function renderModelStatus() {
  const model = selectedModel();
  const status = model?.status ?? 'idle';

  el.modelBadge.textContent = MODEL_STATUS_TEXT[status] ?? status;
  el.modelBadge.className = `badge badge-${status}`;

  const isLoading = status === 'loading';
  el.progress.hidden = !isLoading;
  if (isLoading) {
    const initializing = model.phase === 'initializing';
    el.progress.classList.toggle('indeterminate', initializing);
    el.progressBar.style.width = initializing ? '' : `${Math.round((model.progress / 0.8) * 100)}%`;
  } else {
    el.progress.classList.remove('indeterminate');
    el.progressBar.style.width = '0';
  }

  if (!model) {
    el.modelStatus.textContent = state.models.length
      ? '请选择一个模型。'
      : '未在 weight/ 目录发现 .pth 权重文件。';
  } else if (status === 'loading') {
    el.modelStatus.textContent = model.phase === 'reading'
      ? `正在读取权重 ${Math.round((model.progress / 0.8) * 100)}%`
      : '正在初始化推理引擎，请稍候…';
  } else if (status === 'ready') {
    const count = loadedModelCount();
    el.modelStatus.textContent = `模型已就绪 · 加载耗时 ${(model.loadMs / 1000).toFixed(1)} s · ${formatBytes(model.onnxSize)}`
      + (count > 1 ? ` · 已同时加载 ${count} 个模型` : '');
  } else if (status === 'error') {
    el.modelStatus.textContent = `加载失败：${model.error}`;
  } else if (!model.onnxAvailable) {
    el.modelStatus.textContent = '该权重尚未转换为 ONNX，请先运行 tools/export_onnx.py。';
  } else {
    el.modelStatus.textContent = `权重 ${formatBytes(model.pthSize)}，点击“加载模型”开始（可同时加载多个模型）。`;
  }

  const alreadyLoaded = status === 'ready';
  el.loadBtn.textContent = alreadyLoaded ? '已加载' : '加载模型';
  el.loadBtn.disabled = state.loading || state.detecting || !model?.onnxAvailable || status === 'loading' || alreadyLoaded;
  el.unloadBtn.disabled = state.loading || state.detecting || status !== 'ready';
  el.modelSelect.disabled = state.loading || state.detecting;

  updateActionButtons();
}

async function refreshModels() {
  const data = await api('/api/models');
  state.models = data.models;
  state.activeId = data.activeId;
  renderModelSelect();
  renderModelStatus();
  updateUploadHint();
}

function startPolling() {
  if (state.pollTimer) return;

  state.pollTimer = setInterval(async () => {
    try {
      await refreshModels();
      if (!state.models.some((model) => model.status === 'loading')) {
        stopPolling();
        state.loading = false;
        renderModelStatus();
        if (inferenceModelId()) startDetection();
      }
    } catch (error) {
      stopPolling();
      state.loading = false;
      renderModelStatus();
      el.modelStatus.textContent = `状态获取失败：${error.message}`;
    }
  }, 500);
}

function stopPolling() {
  if (!state.pollTimer) return;
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function handleLoad() {
  const id = el.modelSelect.value;
  if (!id || state.loading) return;

  state.loading = true;
  renderModelStatus();

  try {
    await api(`/api/models/${encodeURIComponent(id)}/load`, { method: 'POST' });
    await refreshModels();
    startPolling();
  } catch (error) {
    state.loading = false;
    renderModelStatus();
    el.modelStatus.textContent = `加载失败：${error.message}`;
  }
}

/** 手动卸载当前选中的模型，释放其会话 */
async function handleUnload() {
  const id = el.modelSelect.value;
  const model = selectedModel();
  if (!id || state.loading || state.detecting || !model || model.status !== 'ready') return;

  state.loading = true;
  renderModelStatus();

  try {
    await api(`/api/models/${encodeURIComponent(id)}/unload`, { method: 'POST' });
    await refreshModels();
  } catch (error) {
    el.modelStatus.textContent = `卸载失败：${error.message}`;
  } finally {
    state.loading = false;
    renderModelStatus();
    renderStats();
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
    };
    state.files.push(item);
    renderRow(item);
  }

  renderStats();
  updateQueueSummary();
  el.uploadHint.textContent = '';

  if (inferenceModelId() && !state.detecting) {
    startDetection();
  } else if (!inferenceModelId()) {
    el.uploadHint.textContent = '图片已加入队列，加载所选模型后将自动开始。';
  }
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
    <td class="verdict"><span class="tag tag-${isFake ? 'fake' : 'real'}">${isFake ? '伪造' : '真实'}</span></td>
    <td class="prob mono">${formatPercent(result.fakeProbability)}</td>
    <td class="time mono">${result.elapsedMs} ms</td>
    <td class="state"><span class="result-index">#${index + 1}</span></td>`;

  const modelCell = row.querySelector('.result-model');
  modelCell.textContent = modelDisplayName(result.model);
  modelCell.title = result.model ?? '';

  row.tabIndex = 0;
  row.setAttribute('aria-label', `查看 ${item.key} 第 ${index + 1} 条检测结果`);
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
    row.setAttribute('aria-label', `查看 ${item.key} 的检测详情`);
  } else {
    row.removeAttribute('tabindex');
    row.removeAttribute('aria-label');
  }

  if (item.inferring) {
    meta.hidden = false;
    meta.textContent = '推理中…';
  } else if (latest) {
    const modelName = modelDisplayName(latest.model);
    meta.hidden = false;
    meta.textContent = count > 1 ? `${count} 个结果 · 最新 ${modelName}` : modelName;
  } else {
    meta.hidden = true;
    meta.textContent = '';
  }

  if (latest) {
    const isFake = latest.label === 'fake';
    verdict.innerHTML = `<span class="tag tag-${isFake ? 'fake' : 'real'}">${isFake ? '伪造' : '真实'}</span>`;
    prob.textContent = formatPercent(latest.fakeProbability);
    time.textContent = `${latest.elapsedMs} ms`;
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

  // 更新空状态提示
  if (el.resultsEmpty) el.resultsEmpty.hidden = state.files.length > 0;
  if (el.resultsEmptyFull) el.resultsEmptyFull.hidden = state.files.length > 0;
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
  if (!inferenceModelId() && pending) {
    el.uploadHint.textContent = '图片已加入队列，加载所选模型后将自动开始。';
  } else if (state.detecting) {
    el.uploadHint.textContent = '正在逐张检测，请保持页面打开。';
  } else {
    el.uploadHint.textContent = '';
  }
}

async function startDetection() {
  const modelId = inferenceModelId();
  if (state.detecting || !modelId) return;

  state.detecting = true;
  renderModelStatus();
  updateUploadHint();

  try {
    let item;
    while ((item = state.files.find((file) => file.status === 'queued'))) {
      item.status = 'processing';
      renderRow(item);
      renderStats();
      updateQueueSummary();

      try {
        const form = new FormData();
        form.append('image', item.file, item.key);
        form.append('name', item.key);
        form.append('model', modelId);

        const result = await api('/api/detect', { method: 'POST', body: form });
        item.results.push({ ...result, receivedAt: Date.now() });
        item.result = item.results[item.results.length - 1];
        item.status = 'done';
        item.error = null;
      } catch (error) {
        item.status = 'error';
        item.error = error.message;
      }

      renderRow(item);
      renderStats();
      updateQueueSummary();
    }
  } finally {
    state.detecting = false;
    renderModelStatus();
    renderStats();
    updateUploadHint();
  }
}

/** 对勾选的图片用当前选中的模型再次推理，为每张图追加一条结果 */
async function runSelectedInference() {
  const modelId = inferenceModelId();
  if (state.detecting || state.loading || !modelId) return;

  const targets = state.files.filter((item) => state.selected.has(item.key));
  if (targets.length === 0) return;

  state.detecting = true;
  state.inferringSelected = true;
  renderModelStatus();
  updateActionButtons();
  updateUploadHint();

  try {
    for (const item of targets) {
      item.inferring = true;
      renderRow(item);

      try {
        const form = new FormData();
        form.append('image', item.file, item.key);
        form.append('name', item.key);
        form.append('model', modelId);

        const result = await api('/api/detect', { method: 'POST', body: form });
        item.results.push({ ...result, receivedAt: Date.now() });
        item.result = item.results[item.results.length - 1];
        item.status = 'done';
        item.error = null;
        item.expanded = item.results.length > 1;
      } catch (error) {
        // 已有历史结果时保留，避免一次失败清掉之前的对比数据
        if (item.results.length === 0) {
          item.status = 'error';
          item.error = error.message;
        }
      } finally {
        item.inferring = false;
      }

      renderRow(item);
      renderStats();
      updateQueueSummary();
    }
  } finally {
    state.detecting = false;
    state.inferringSelected = false;
    renderModelStatus();
    renderStats();
    updateUploadHint();
    updateActionButtons();
  }
}

/** 根据勾选状态与模型状态刷新「推理」按钮 */
function updateActionButtons() {
  const hasSelection = state.selected.size > 0;
  const busy = state.detecting || state.loading;
  const modelReady = Boolean(inferenceModelId());
  for (const button of [el.inferBtn, el.inferBtnFull]) {
    if (!button) continue;
    button.disabled = !hasSelection || !modelReady || busy;
    button.textContent = state.inferringSelected ? '推理中…' : '推理';
  }
}

function renderStats() {
  // 👇 核心修复：严格校验 result 数据结构，防止渲染异常导致检测循环崩溃
  const done = state.files.filter((item) => 
    item.status === 'done' && 
    item.result && 
    typeof item.result.fakeProbability === 'number'
  );
  
  const fake = done.filter((item) => item.result.label === 'fake').length;
  const real = done.length - fake;

  el.statTotal.textContent = String(state.files.length);
  el.statDone.textContent = String(done.length);
  el.statFake.textContent = String(fake);
  el.statReal.textContent = String(real);
  el.statRatio.textContent = done.length ? formatPercent(fake / done.length) : '—';
  el.statAvg.textContent = done.length
    ? formatPercent(done.reduce((sum, item) => sum + item.result.fakeProbability, 0) / done.length)
    : '—';
  el.avgTime.textContent = done.length
    ? `平均耗时 ${Math.round(done.reduce((sum, item) => sum + item.result.elapsedMs, 0) / done.length)} ms/张`
    : '';

  el.exportBtn.disabled = done.length === 0;
  el.clearBtn.disabled = state.files.length === 0 || state.detecting;

  updateActionButtons();
  renderHistogram(done);
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

function renderHistogram(done) {
  // 👇 核心修复：过滤掉无效数据，防止污染图表计算
  currentProbs = done.map((item) => item.result.fakeProbability).filter((v) => typeof v === 'number');

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

function exportJson() {
  const payload = {};
  for (const item of state.files) {
    if (item.status !== 'done') continue;
    payload[item.key] = {
      label: item.result.label,
      fake_probability: Number(item.result.fakeProbability.toFixed(6)),
      real_probability: Number(item.result.realProbability.toFixed(6)),
      elapsed_ms: item.result.elapsedMs,
    };
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `aigc-detection-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function clearResults() {
  if (el.detailDrawer.classList.contains('open')) closeDetail();

  for (const item of state.files) {
    URL.revokeObjectURL(item.preview);
  }
  state.files = [];
  state.selected.clear();
  rows.clear();
  
  // 清空主表格
  if (el.resultsBody) el.resultsBody.innerHTML = '';
  if (el.resultsEmpty) el.resultsEmpty.hidden = false;
  
  // 清空全量表格
  if (el.resultsBodyFull) el.resultsBodyFull.innerHTML = '';
  if (el.resultsEmptyFull) el.resultsEmptyFull.hidden = false;

  el.uploadHint.textContent = '';
  renderStats();
  updateQueueSummary();
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

function drawHeatmap(canvas, emptyEl, item, result) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const heatmap = result.heatmap;
  const grid = result.heatmapSize;

  ctx.clearRect(0, 0, size, size);
  if (emptyEl) emptyEl.hidden = true;

  const image = new Image();
  image.onload = () => {
    // 与后端预处理保持一致：原图直接拉伸到 224×224，热力图网格才能和画面精确对齐
    ctx.drawImage(image, 0, 0, size, size);

    if (!Array.isArray(heatmap) || !grid || heatmap.length !== grid * grid) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }

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
  };
  image.src = item.preview;
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
      <span class="tag tag-${isFake ? 'fake' : 'real'}">${isFake ? '伪造' : '真实'}</span>
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
  modelHint.textContent = modelId ? `模型标识 · ${modelId}` : '';

  drawHeatmap(
    column.querySelector('canvas'),
    column.querySelector('.heatmap-empty'),
    item,
    result,
  );

  return column;
}

function openDetail(key, activeIndex) {
  const item = state.files.find((file) => file.key === key);
  if (!item || item.results.length === 0) return;

  el.detailName.textContent = item.key;
  el.detailName.title = item.key;

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
  el.loadBtn.addEventListener('click', handleLoad);
  el.unloadBtn.addEventListener('click', handleUnload);
  el.modelSelect.addEventListener('change', renderModelStatus);

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

  el.exportBtn.addEventListener('click', exportJson);
  el.clearBtn.addEventListener('click', clearResults);

  if (el.inferBtn) el.inferBtn.addEventListener('click', runSelectedInference);
  if (el.inferBtnFull) el.inferBtnFull.addEventListener('click', runSelectedInference);

  bindRowEvents(el.resultsBody);
  bindRowEvents(el.resultsBodyFull);

  el.detailClose.addEventListener('click', closeDetail);
  el.detailOverlay.addEventListener('click', closeDetail);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el.detailDrawer.classList.contains('open')) {
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
  renderStats(); // 这里已经包含了图表初始化，不需要额外再写 renderHistogram([])

  try {
    await refreshModels();
  } catch (error) {
    el.modelStatus.textContent = `无法获取模型列表：${error.message}`;
  }
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