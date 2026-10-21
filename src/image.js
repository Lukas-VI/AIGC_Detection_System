import sharp from 'sharp';
import { CLIP_MEAN, CLIP_STD, IMAGE_SIZE } from './config.js';
import { HttpError } from './errors.js';

/**
 * 图片 -> CLIP 输入张量 (1, 3, 224, 224)
 * 处理顺序与 Effort demo 一致：等比拉伸到 224、RGB、按 CLIP 均值/方差归一化。
 * 输出为 CHW 排列的 Float32Array。
 */
export async function imageToTensor(buffer) {
  let raw;
  try {
    raw = await sharp(buffer)
      .rotate() // 按 EXIF 自动纠正方向
      .flatten({ background: '#ffffff' }) // 透明背景铺白，同时去掉 alpha
      .toColourspace('srgb')
      .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new HttpError(400, '图片解码失败，请确认文件格式是否受支持');
  }

  const { data, info } = raw;
  if (info.channels !== 3) {
    throw new HttpError(400, '暂不支持该图片的色彩模式');
  }

  const area = IMAGE_SIZE * IMAGE_SIZE;
  const tensor = new Float32Array(area * 3);
  for (let i = 0; i < area; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      const value = data[i * 3 + c] / 255;
      tensor[c * area + i] = (value - CLIP_MEAN[c]) / CLIP_STD[c];
    }
  }
  return tensor;
}
