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
  initTheme();
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

init();