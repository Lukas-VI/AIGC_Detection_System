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
  resultsBody: document.getElementById('results-body'),
  resultsEmpty: document.getElementById('results-empty'),
};

const state = {
  models: [],
  activeId: null,
  loading: false,
  detecting: false,
  files: [],
  pollTimer: null,
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

function selectedModel() {
  return state.models.find((model) => model.id === el.modelSelect.value) ?? null;
}

function currentModel() {
  const loading = state.models.find((model) => model.status === 'loading');
  if (loading) return loading;

  // 用户在下拉框里选择了另一个模型时，展示该模型的状态
  const selected = selectedModel();
  if (selected && selected.id !== state.activeId) return selected;

  return state.models.find((model) => model.id === state.activeId) ?? selected;
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
  const model = currentModel();
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
    el.modelStatus.textContent = `模型已就绪 · 加载耗时 ${(model.loadMs / 1000).toFixed(1)} s · ${formatBytes(model.onnxSize)}`;
  } else if (status === 'error') {
    el.modelStatus.textContent = `加载失败：${model.error}`;
  } else if (!model.onnxAvailable) {
    el.modelStatus.textContent = '该权重尚未转换为 ONNX，请先运行 tools/export_onnx.py。';
  } else {
    el.modelStatus.textContent = `权重 ${formatBytes(model.pthSize)}，点击“加载模型”开始。`;
  }

  const alreadyLoaded = status === 'ready' && model.id === state.activeId;
  el.loadBtn.textContent = alreadyLoaded ? '已加载' : '加载模型';
  el.loadBtn.disabled = state.loading || state.detecting || !model?.onnxAvailable || status === 'loading' || alreadyLoaded;
  el.modelSelect.disabled = state.loading || state.detecting;
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
        if (state.activeId) startDetection();
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
      result: null,
      error: null,
      preview: URL.createObjectURL(file),
    };
    state.files.push(item);
    renderRow(item);
  }

  renderStats();
  updateQueueSummary();
  el.uploadHint.textContent = '';

  if (state.activeId && !state.detecting) {
    startDetection();
  } else if (!state.activeId) {
    el.uploadHint.textContent = '图片已加入队列，加载检测模型后将自动开始。';
  }
}

function renderRow(item) {
  let row = rows.get(item.key);

  if (!row) {
    row = document.createElement('tr');
    row.innerHTML = `
      <td><img class="thumb" alt=""></td>
      <td class="filename"></td>
      <td class="verdict"></td>
      <td class="prob mono"></td>
      <td class="time mono"></td>
      <td class="state"></td>`;
    row.querySelector('.thumb').src = item.preview;
    const nameCell = row.querySelector('.filename');
    nameCell.textContent = item.key;
    nameCell.title = item.key;
    rows.set(item.key, row);
    el.resultsBody.appendChild(row);
  }

  const verdict = row.querySelector('.verdict');
  const prob = row.querySelector('.prob');
  const time = row.querySelector('.time');
  const statusCell = row.querySelector('.state');

  statusCell.title = '';
  statusCell.className = 'state';

  if (item.status === 'done') {
    const isFake = item.result.label === 'fake';
    verdict.innerHTML = `<span class="tag tag-${isFake ? 'fake' : 'real'}">${isFake ? '伪造' : '真实'}</span>`;
    prob.textContent = formatPercent(item.result.fakeProbability);
    time.textContent = `${item.result.elapsedMs} ms`;
    statusCell.textContent = '完成';
  } else if (item.status === 'processing') {
    verdict.textContent = '—';
    prob.textContent = '—';
    time.textContent = '—';
    statusCell.textContent = '检测中…';
  } else if (item.status === 'error') {
    verdict.textContent = '—';
    prob.textContent = '—';
    time.textContent = '—';
    statusCell.textContent = '失败';
    statusCell.className = 'state state-error';
    statusCell.title = item.error ?? '未知错误';
  } else {
    verdict.textContent = '—';
    prob.textContent = '—';
    time.textContent = '—';
    statusCell.textContent = '等待';
  }

  el.resultsEmpty.hidden = state.files.length > 0;
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
  if (!state.activeId && pending) {
    el.uploadHint.textContent = '图片已加入队列，加载检测模型后将自动开始。';
  } else if (state.detecting) {
    el.uploadHint.textContent = '正在逐张检测，请保持页面打开。';
  } else {
    el.uploadHint.textContent = '';
  }
}

async function startDetection() {
  if (state.detecting || !state.activeId) return;

  state.detecting = true;
  renderModelStatus();
  updateUploadHint();

  try {
    let item;
    while ((item = state.files.find((file) => file.status === 'queued'))) {
      if (!state.activeId) break;

      item.status = 'processing';
      renderRow(item);
      renderStats();
      updateQueueSummary();

      try {
        const form = new FormData();
        form.append('image', item.file, item.key);
        form.append('name', item.key);

        item.result = await api('/api/detect', { method: 'POST', body: form });
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

function renderStats() {
  const done = state.files.filter((item) => item.status === 'done');
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

  renderHistogram(done);
}

function renderHistogram(done) {
  const buckets = new Array(10).fill(0);
  for (const item of done) {
    const index = Math.min(9, Math.floor(item.result.fakeProbability * 10));
    buckets[index] += 1;
  }

  const max = Math.max(1, ...buckets);
  el.histogram.innerHTML = '';

  buckets.forEach((count, index) => {
    const column = document.createElement('div');
    column.className = 'histogram-col';

    const bar = document.createElement('div');
    bar.className = count > 0 ? 'histogram-bar has-value' : 'histogram-bar';
    bar.style.height = count > 0 ? `${Math.max(4, (count / max) * 100)}%` : '0';
    bar.title = `${(index / 10).toFixed(1)}–${((index + 1) / 10).toFixed(1)}：${count} 张`;

    const label = document.createElement('span');
    label.className = 'histogram-label';
    label.textContent = index === 0 ? '0' : (index / 10).toFixed(1);

    column.append(bar, label);
    el.histogram.appendChild(column);
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
  for (const item of state.files) {
    URL.revokeObjectURL(item.preview);
  }
  state.files = [];
  rows.clear();
  el.resultsBody.innerHTML = '';
  el.resultsEmpty.hidden = false;
  el.uploadHint.textContent = '';
  renderStats();
  updateQueueSummary();
}

function bindEvents() {
  el.loadBtn.addEventListener('click', handleLoad);
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
}

async function init() {
  bindEvents();
  renderStats();
  renderHistogram([]);

  try {
    await refreshModels();
  } catch (error) {
    el.modelStatus.textContent = `无法获取模型列表：${error.message}`;
  }
}

init();
