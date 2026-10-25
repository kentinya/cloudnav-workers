// 颜色提取工具
export interface ExtractedColor {
  hex: string;
  rgb: string;
  hsl?: string;
}

// 缓存已提取的颜色
const colorCache = new Map<string, ExtractedColor>();

// 从图片提取主要颜色
export async function extractColorFromImage(imgUrl: string): Promise<ExtractedColor | null> {
  // 检查缓存
  if (colorCache.has(imgUrl)) {
    return colorCache.get(imgUrl)!;
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // 允许跨域图片

    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        resolve(null);
        return;
      }

      // 缩小图片以提高性能
      const scaleFactor = 50 / Math.max(img.width, img.height);
      canvas.width = img.width * scaleFactor;
      canvas.height = img.height * scaleFactor;

      // 绘制图片
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // 获取图片数据
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      // 分析颜色分布
      const colorMap = new Map<string, number>();
      let totalBrightness = 0;
      let sampleCount = 0;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        // 跳过透明或接近透明的像素
        if (a < 128) continue;

        // 跳过白色和灰色（背景通常是白色）
        const brightness = (r + g + b) / 3;
        const isGrayish = Math.abs(r - g) < 30 && Math.abs(g - b) < 30 && Math.abs(r - b) < 30;

        if (brightness > 240 || isGrayish) continue;

        // 颜色量化（减少颜色数量）
        const qR = Math.round(r / 20) * 20;
        const qG = Math.round(g / 20) * 20;
        const qB = Math.round(b / 20) * 20;

        const colorKey = `${qR},${qG},${qB}`;
        colorMap.set(colorKey, (colorMap.get(colorKey) || 0) + 1);

        totalBrightness += brightness;
        sampleCount++;
      }

      // 找到最常见的颜色
      let dominantColor = '';
      let maxCount = 0;

      for (const [color, count] of colorMap) {
        if (count > maxCount) {
          maxCount = count;
          dominantColor = color;
        }
      }

      if (dominantColor) {
        const [r, g, b] = dominantColor.split(',').map(Number);

        // 转换为不同格式
        const hex = rgbToHex(r, g, b);
        const rgb = `${r}, ${g}, ${b}`;
        const hsl = rgbToHsl(r, g, b);

        const result: ExtractedColor = {
          hex,
          rgb,
          hsl
        };

        // 缓存结果
        colorCache.set(imgUrl, result);
        resolve(result);
      } else {
        // 如果没有找到明显的颜色，使用默认蓝色
        const defaultColor: ExtractedColor = {
          hex: '#3b82f6',
          rgb: '59, 130, 246',
          hsl: '217, 91%, 60%'
        };
        colorCache.set(imgUrl, defaultColor);
        resolve(defaultColor);
      }
    };

    img.onerror = () => {
      // 加载失败，使用默认颜色
      const defaultColor: ExtractedColor = {
        hex: '#3b82f6',
        rgb: '59, 130, 246',
        hsl: '217, 91%, 60%'
      };
      colorCache.set(imgUrl, defaultColor);
      resolve(defaultColor);
    };

    img.src = imgUrl;
  });
}

// RGB 转 HEX
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

// RGB 转 HSL
function rgbToHsl(r: number, g: number, b: number): string {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return `${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%`;
}

// 从文本生成颜色（用于没有图标的情况）
export function generateColorFromText(text: string): ExtractedColor {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = text.charCodeAt(i) + ((hash << 5) - hash);
  }

  const hue = hash % 360;
  const saturation = 65 + (hash % 15); // 65-80%
  const lightness = 45 + (hash % 10);  // 45-55%

  const hsl = `${hue}, ${saturation}%, ${lightness}%`;

  // 简单的 HSL 到 RGB 转换
  const s = saturation / 100;
  const l = lightness / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = l - c / 2;

  let r = 0, g = 0, b = 0;

  if (0 <= hue && hue < 60) {
    r = c; g = x; b = 0;
  } else if (60 <= hue && hue < 120) {
    r = x; g = c; b = 0;
  } else if (120 <= hue && hue < 180) {
    r = 0; g = c; b = x;
  } else if (180 <= hue && hue < 240) {
    r = 0; g = x; b = c;
  } else if (240 <= hue && hue < 300) {
    r = x; g = 0; b = c;
  } else if (300 <= hue && hue < 360) {
    r = c; g = 0; b = x;
  }

  r = Math.round((r + m) * 255);
  g = Math.round((g + m) * 255);
  b = Math.round((b + m) * 255);

  const hex = rgbToHex(r, g, b);
  const rgb = `${r}, ${g}, ${b}`;

  return { hex, rgb, hsl };
}