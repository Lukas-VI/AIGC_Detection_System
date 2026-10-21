import express from 'express';
import { HOST, PORT, PUBLIC_DIR } from './config.js';
import { modelManager } from './models.js';
import { api } from './routes.js';

const app = express();
app.disable('x-powered-by');

app.use(express.static(PUBLIC_DIR));
app.use('/api', api);

app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 统一错误响应：业务错误直接返回 message，未知错误只给通用提示
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  const isUploadError = error.code === 'LIMIT_FILE_SIZE' || error.name === 'MulterError';
  const status = error.status ?? (isUploadError ? 400 : 500);
  const message = isUploadError
    ? '图片大小超过限制（25MB）'
    : status >= 500
      ? '服务器内部错误'
      : error.message;

  if (status >= 500) console.error(error);
  res.status(status).json({ error: message });
});

function startServer(port, retries = 5) {
  const server = app.listen(port, HOST);

  server.once('listening', async () => {
    const { models } = await modelManager.list();
    console.log(`AIGC 鉴别平台已启动: http://localhost:${port}`);
    console.log(`发现 ${models.length} 个权重文件，其中 ${models.filter((m) => m.onnxAvailable).length} 个已转换为 ONNX`);
  });

  server.once('error', (error) => {
    if (server.listening) return;
    if (error.code === 'EADDRINUSE' && retries > 0) {
      console.warn(`端口 ${port} 已被占用，尝试 ${port + 1}`);
      startServer(port + 1, retries - 1);
      return;
    }
    console.error('启动失败:', error.message);
    process.exitCode = 1;
  });
}

startServer(PORT);