export interface Bitmap {
  width: number;
  height: number;
  gray: Uint8ClampedArray;
}

export interface Band {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
  ink: number;
}

export function toBitmap(image: ImageData): Bitmap {
  const { width, height, data } = image;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return { width, height, gray };
}

export function otsuThreshold(bmp: Bitmap): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < bmp.gray.length; i++) hist[bmp.gray[i]]++;
  const total = bmp.gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

export interface RowProfile {
  ink: Uint32Array;
  threshold: number;
}

export function rowInk(bmp: Bitmap, threshold: number, x0 = 0, x1 = bmp.width): RowProfile {
  const ink = new Uint32Array(bmp.height);
  const px0 = Math.max(0, Math.floor(x0));
  const px1 = Math.min(bmp.width, Math.ceil(x1));
  for (let y = 0; y < bmp.height; y++) {
    let count = 0;
    const row = y * bmp.width;
    for (let x = px0; x < px1; x++) {
      if (bmp.gray[row + x] < threshold) count++;
    }
    ink[y] = count;
  }
  return { ink, threshold };
}

export function bandsFromProfile(profile: RowProfile, width: number): Band[] {
  const { ink } = profile;
  const bands: Band[] = [];
  const minInk = Math.max(1, Math.floor((width * 0.004)));
  let start = -1;
  for (let y = 0; y < ink.length; y++) {
    const has = ink[y] >= minInk;
    if (has && start === -1) start = y;
    if (!has && start !== -1) {
      bands.push({ y0: start, y1: y, x0: 0, x1: width, ink: 0 });
      start = -1;
    }
  }
  if (start !== -1) bands.push({ y0: start, y1: ink.length, x0: 0, x1: width, ink: 0 });
  return bands;
}

export function bandColumns(bmp: Bitmap, threshold: number, band: Band): Band {
  let x0 = bmp.width;
  let x1 = 0;
  let ink = 0;
  for (let y = band.y0; y < band.y1; y++) {
    const row = y * bmp.width;
    for (let x = 0; x < bmp.width; x++) {
      if (bmp.gray[row + x] < threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        ink++;
      }
    }
  }
  if (x1 < x0) {
    x0 = 0;
    x1 = bmp.width;
  }
  return { y0: band.y0, y1: band.y1, x0, x1: x1 + 1, ink };
}

export function mergeCloseBands(bands: Band[], maxGap: number): Band[] {
  if (bands.length < 2) return bands.slice();
  const out: Band[] = [{ ...bands[0] }];
  for (let i = 1; i < bands.length; i++) {
    const prev = out[out.length - 1];
    const cur = bands[i];
    if (cur.y0 - prev.y1 <= maxGap) {
      prev.y1 = cur.y1;
      prev.x0 = Math.min(prev.x0, cur.x0);
      prev.x1 = Math.max(prev.x1, cur.x1);
      prev.ink += cur.ink;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

export function lineBands(bmp: Bitmap, threshold: number): Band[] {
  const profile = rowInk(bmp, threshold);
  const bands = bandsFromProfile(profile, bmp.width);
  return bands.map((b) => bandColumns(bmp, threshold, b));
}
