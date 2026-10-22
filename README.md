# AIGC_Detection_System

基于 [Effort](https://github.com/YZY-stack/Effort-AIGI-Detection)的 AI 生成图像鉴别平台。

- Node.js 单进程服务，页面为单页应用
- 支持单张 / 整个文件夹上传，逐张检测
- 模型下拉选择、加载进度与状态展示
- 结果表格、伪造概率分布、简易统计
- 导出 JSON（文件名 -> 鉴别结果）

## 快速开始

```bash
npm install
npm start
```

默认访问 `http://localhost:3000`。若端口被占用，服务会自动尝试后续端口；也可在 PowerShell 中用 `$env:PORT=3100; npm start` 指定端口。

## 模型权重

在谷歌网盘上下载权重

training on FaceForensics++:

`https://drive.google.com/file/d/1GlJ1y4xmTdqV0FfIcyBwNNU6cQird9DR/view`

training on GenImage (sdv1.4):

`https://drive.google.com/file/d/1UXf1hC9FC1yV93uKwXSkdtepsgpIAU9d/view`

training on Chameleon (sdv1.4):

`https://drive.google.com/file/d/1m4fyJecABU-Yk3bJ4b1WhUwQa0xCkMLI/view`

`weight/` 目录下放置 Effort 的 `.pth` 权重，平台从该目录自动发现模型：

- `weight/effort_clip_L14_trainOn_chameleon.pth`
- `weight/effort_clip_L14_trainOn_FaceForensic.pth`
- `weight/effort_clip_L14_trainOn_sdv14.pth`

Node.js 通过 ONNX Runtime 推理，因此需要把 `.pth` 转换为 `.onnx`，输出到 `weight/onnx/`。

```bash
# 一次性安装转换依赖（Python 3.10+）
python -m venv tools/.venv
tools\.venv\Scripts\python.exe -m pip install torch transformers onnx

# 逐个转换（文件名与 .pth 保持一致）
tools\.venv\Scripts\python.exe tools\export_onnx.py --weights weight\effort_clip_L14_trainOn_chameleon.pth --output weight\onnx\effort_clip_L14_trainOn_chameleon.onnx
```

脚本会把 Effort 的 SVD 残差分量折叠回普通线性层，导出的模型与原始检测器数值等价（已验证误差 < 1e-6）。

未转换的模型会在页面中标记为“未转换”，无法加载。

## 目录结构

```
src/
  server.js      Express 启动与错误处理
  routes.js      /api 路由
  models.js      权重扫描、ONNX 会话加载（含进度）、串行推理
  image.js       图片预处理（224x224、CLIP 归一化）
  config.js      路径、端口、归一化参数等配置
public/          单页前端（HTML / CSS / 原生 JS）
tools/           pth -> onnx 导出脚本
weight/          权重文件（已加入 .gitignore）
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/models` | 模型列表与加载状态 |
| POST | `/api/models/:id/load` | 后台加载模型，前端轮询状态 |
| POST | `/api/detect` | 单图检测，multipart 字段 `image`，可选 `name` |

检测返回：

```json
{
  "file": "cat.jpg",
  "model": "effort_clip_L14_trainOn_chameleon",
  "label": "fake",
  "fakeProbability": 0.9312,
  "realProbability": 0.0688,
  "elapsedMs": 986
}
```

前端导出的 JSON 为 `文件名 -> { label, fake_probability, real_probability, elapsed_ms }`。

## 说明

- 默认按整图缩放到 224x224 推理；`FaceForensic` 权重在训练时使用对齐后的人脸，检测人脸图时效果更好。
- CPU 推理单张约 1 秒（视机器而定），批量检测为逐张串行。
- `weight/` 已在 `.gitignore` 中，权重与转换产物不会提交到仓库。
