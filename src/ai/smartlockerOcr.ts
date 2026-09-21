import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import RNFS from 'react-native-fs';
import * as jpeg from 'jpeg-js';
import { Buffer } from 'buffer';

if (!(globalThis as any).Buffer) {
  (globalThis as any).Buffer = Buffer;
}

const DET_MAX_SIDE = 736;
const DET_PIXEL_THRESH = 0.20;
const DET_BOX_THRESH = 0.45;
const DET_UNCLIP = 1.40;
const DET_MAX_BOXES = 80;

const REC_H = 48;
const REC_W = 320;

// SPEED PROFILE
// - OCR 4 text boxes per ONNX call instead of 1 call/box.
// - Stop as soon as receiver phone is already confident.
// - 0° is attempted first; 90/270/180 are fallbacks only.
const REC_BATCH_SIZE = 4;
const FAST_ACCEPT_SCORE = 120;
const FAST_ACCEPT_CONF = 0.42;

const RECEIVER_KEYS = [
  'to',
  'receiver',
  'recipient',
  'consignee',
  'nguoi nhan',
  'den',
  'thong tin nguoi nhan',
  'giao den',
];

const SENDER_KEYS = [
  'from',
  'sender',
  'nguoi gui',
  'thong tin nguoi gui',
  'shop',
];

const BAD_KEYS = [
  'hotline',
  'cskh',
  'tong dai',
  'tracking',
  'ma van don',
  'order id',
  'ma don',
];

type RawImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

export type TextBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
};

export type OcrLine = TextBox & {
  text: string;
  confidence: number;
};

export type ReceiverPhoneResult = {
  phone: string | null;
  score: number;
  orientation: 0 | 90 | 180 | 270;
  lines: OcrLine[];
  selectedLine?: OcrLine;
  debug: string;
};

export type SmartLockerOcrEngine = {
  detector: InferenceSession;
  recognizer: InferenceSession;
  dictionary: string[];
  dispose: () => Promise<void>;
  scanJpeg: (path: string) => Promise<ReceiverPhoneResult>;
};

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

const normalizeFilePath = (path: string) =>
  path.startsWith('file://') ? path.slice(7) : path;

const normalizeText = (value: string) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const normalizeVnPhone = (value: string): string | null => {
  let digits = String(value || '').replace(/\D/g, '');

  // (+84)0xxxxxxxxx
  if (digits.length === 12 && digits.startsWith('840')) {
    digits = digits.slice(2);
  }

  // +84xxxxxxxxx / 84xxxxxxxxx
  if (digits.length === 11 && digits.startsWith('84')) {
    digits = `0${digits.slice(2)}`;
  }

  if (/^0[35789]\d{8}$/.test(digits)) {
    return digits;
  }

  return null;
};

const copyAssetFresh = async (
  assetPath: string,
  outputName: string,
) => {
  const output =
    `${RNFS.CachesDirectoryPath}/${outputName}`;

  if (await RNFS.exists(output)) {
    await RNFS.unlink(output);
  }

  await RNFS.copyFileAssets(assetPath, output);

  const stat = await RNFS.stat(output);

  console.log(
    '📦 AI ASSET:',
    assetPath,
    '->',
    output,
    `${stat.size} bytes`,
  );

  return output;
};

const decodeJpeg = async (path: string): Promise<RawImage> => {
  const base64 = await RNFS.readFile(
    normalizeFilePath(path),
    'base64',
  );

  const bytes = Buffer.from(base64, 'base64');

  const decode: any =
    (jpeg as any).decode ||
    (jpeg as any).default?.decode ||
    jpeg;

  const raw = decode(bytes, {
    useTArray: true,
    formatAsRGBA: true,
  });

  if (!raw?.width || !raw?.height || !raw?.data) {
    throw new Error('Không decode được ảnh JPEG.');
  }

  return {
    width: raw.width,
    height: raw.height,
    data: raw.data as Uint8Array,
  };
};

const rotateRaw = (
  src: RawImage,
  degree: 0 | 90 | 180 | 270,
): RawImage => {
  if (degree === 0) {
    return src;
  }

  const sw = src.width;
  const sh = src.height;

  const dw =
    degree === 90 || degree === 270 ? sh : sw;

  const dh =
    degree === 90 || degree === 270 ? sw : sh;

  const out = new Uint8Array(dw * dh * 4);

  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      let dx = 0;
      let dy = 0;

      if (degree === 90) {
        dx = sh - 1 - sy;
        dy = sx;
      } else if (degree === 180) {
        dx = sw - 1 - sx;
        dy = sh - 1 - sy;
      } else {
        dx = sy;
        dy = sw - 1 - sx;
      }

      const si = (sy * sw + sx) * 4;
      const di = (dy * dw + dx) * 4;

      out[di] = src.data[si];
      out[di + 1] = src.data[si + 1];
      out[di + 2] = src.data[si + 2];
      out[di + 3] = 255;
    }
  }

  return {
    width: dw,
    height: dh,
    data: out,
  };
};

const sampleRgbBilinear = (
  raw: RawImage,
  x: number,
  y: number,
) => {
  const xx = clamp(x, 0, raw.width - 1);
  const yy = clamp(y, 0, raw.height - 1);

  const x0 = Math.floor(xx);
  const y0 = Math.floor(yy);
  const x1 = Math.min(raw.width - 1, x0 + 1);
  const y1 = Math.min(raw.height - 1, y0 + 1);

  const tx = xx - x0;
  const ty = yy - y0;

  const read = (px: number, py: number, channel: number) =>
    raw.data[(py * raw.width + px) * 4 + channel];

  const interp = (channel: number) => {
    const v00 = read(x0, y0, channel);
    const v10 = read(x1, y0, channel);
    const v01 = read(x0, y1, channel);
    const v11 = read(x1, y1, channel);

    const top = v00 * (1 - tx) + v10 * tx;
    const bottom = v01 * (1 - tx) + v11 * tx;

    return top * (1 - ty) + bottom * ty;
  };

  return [interp(0), interp(1), interp(2)] as const;
};

const round32 = (n: number) =>
  Math.max(32, Math.round(n / 32) * 32);

const buildDetectorInput = (raw: RawImage) => {
  const scale = Math.min(
    1,
    DET_MAX_SIDE / Math.max(raw.width, raw.height),
  );

  const targetW = round32(raw.width * scale);
  const targetH = round32(raw.height * scale);

  const input =
    new Float32Array(3 * targetH * targetW);

  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];

  const plane = targetH * targetW;

  for (let y = 0; y < targetH; y++) {
    const sy =
      ((y + 0.5) * raw.height) / targetH - 0.5;

    for (let x = 0; x < targetW; x++) {
      const sx =
        ((x + 0.5) * raw.width) / targetW - 0.5;

      const [r, g, b] =
        sampleRgbBilinear(raw, sx, sy);

      // Paddle config decodes BGR, then normalizes HWC.
      const bgr = [b / 255, g / 255, r / 255];
      const pos = y * targetW + x;

      input[pos] =
        (bgr[0] - mean[0]) / std[0];

      input[plane + pos] =
        (bgr[1] - mean[1]) / std[1];

      input[plane * 2 + pos] =
        (bgr[2] - mean[2]) / std[2];
    }
  }

  return {
    input,
    targetW,
    targetH,
  };
};

const connectedBoxesFromDbMap = (
  probs: Float32Array,
  mapH: number,
  mapW: number,
  rawW: number,
  rawH: number,
): TextBox[] => {
  const total = mapH * mapW;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);

  const components: TextBox[] = [];
  const minPixels = Math.max(
    6,
    Math.floor(total * 0.000015),
  );

  const pushNeighbor = (
    nx: number,
    ny: number,
    tailRef: { value: number },
  ) => {
    if (
      nx < 0 ||
      ny < 0 ||
      nx >= mapW ||
      ny >= mapH
    ) {
      return;
    }

    const ni = ny * mapW + nx;

    if (
      visited[ni] ||
      probs[ni] < DET_PIXEL_THRESH
    ) {
      return;
    }

    visited[ni] = 1;
    queue[tailRef.value++] = ni;
  };

  for (let start = 0; start < total; start++) {
    if (
      visited[start] ||
      probs[start] < DET_PIXEL_THRESH
    ) {
      continue;
    }

    visited[start] = 1;

    let head = 0;
    const tail = { value: 1 };
    queue[0] = start;

    let minX = mapW;
    let minY = mapH;
    let maxX = 0;
    let maxY = 0;
    let count = 0;
    let scoreSum = 0;

    while (head < tail.value) {
      const index = queue[head++];
      const y = Math.floor(index / mapW);
      const x = index - y * mapW;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      count++;
      scoreSum += probs[index];

      pushNeighbor(x - 1, y, tail);
      pushNeighbor(x + 1, y, tail);
      pushNeighbor(x, y - 1, tail);
      pushNeighbor(x, y + 1, tail);

      // DB maps often connect diagonally.
      pushNeighbor(x - 1, y - 1, tail);
      pushNeighbor(x + 1, y - 1, tail);
      pushNeighbor(x - 1, y + 1, tail);
      pushNeighbor(x + 1, y + 1, tail);
    }

    if (count < minPixels) {
      continue;
    }

    const score = scoreSum / Math.max(1, count);

    if (score < DET_BOX_THRESH) {
      continue;
    }

    let x1 = (minX / mapW) * rawW;
    let y1 = (minY / mapH) * rawH;
    let x2 = ((maxX + 1) / mapW) * rawW;
    let y2 = ((maxY + 1) / mapH) * rawH;

    const bw = x2 - x1;
    const bh = y2 - y1;

    if (bw < 6 || bh < 5) {
      continue;
    }

    // Approximate DB "unclip" with bbox expansion.
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;

    const ew = bw * DET_UNCLIP;
    const eh = bh * DET_UNCLIP;

    x1 = clamp(cx - ew / 2, 0, rawW - 1);
    y1 = clamp(cy - eh / 2, 0, rawH - 1);
    x2 = clamp(cx + ew / 2, 1, rawW);
    y2 = clamp(cy + eh / 2, 1, rawH);

    components.push({
      x1,
      y1,
      x2,
      y2,
      score,
    });
  }

  return components
    .sort((a, b) => {
      const ay = (a.y1 + a.y2) / 2;
      const by = (b.y1 + b.y2) / 2;

      if (Math.abs(ay - by) > 12) {
        return ay - by;
      }

      return a.x1 - b.x1;
    })
    .slice(0, DET_MAX_BOXES);
};

const detectTextBoxes = async (
  session: InferenceSession,
  raw: RawImage,
): Promise<TextBox[]> => {
  const {
    input,
    targetW,
    targetH,
  } = buildDetectorInput(raw);

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const tensor = new Tensor(
    'float32',
    input,
    [1, 3, targetH, targetW],
  );

  const outputs = await session.run({
    [inputName]: tensor,
  });

  const output = outputs[outputName];

  if (!output) {
    throw new Error(
      'Model 1 ONNX không trả output.',
    );
  }

  const dims = output.dims.map(Number);

  if (dims.length !== 4) {
    throw new Error(
      `Model 1 output dims lạ: ${JSON.stringify(dims)}`,
    );
  }

  const mapH = dims[dims.length - 2];
  const mapW = dims[dims.length - 1];

  const data = output.data as Float32Array;

  if (data.length < mapH * mapW) {
    throw new Error(
      `Model 1 output thiếu dữ liệu: ${data.length}`,
    );
  }

  const probs =
    data.length === mapH * mapW
      ? data
      : data.slice(0, mapH * mapW);

  const boxes = connectedBoxesFromDbMap(
    probs,
    mapH,
    mapW,
    raw.width,
    raw.height,
  );

  console.log(
    'MODEL 1:',
    `${raw.width}x${raw.height}`,
    '->',
    `${targetW}x${targetH}`,
    'map',
    `${mapW}x${mapH}`,
    'boxes',
    boxes.length,
  );

  return boxes;
};

const buildRecognizerInput = (
  raw: RawImage,
  box: TextBox,
) => {
  const bw = Math.max(1, box.x2 - box.x1);
  const bh = Math.max(1, box.y2 - box.y1);

  const padX = bw * 0.08;
  const padY = bh * 0.18;

  const x1 = clamp(
    box.x1 - padX,
    0,
    raw.width - 1,
  );
  const y1 = clamp(
    box.y1 - padY,
    0,
    raw.height - 1,
  );
  const x2 = clamp(
    box.x2 + padX,
    1,
    raw.width,
  );
  const y2 = clamp(
    box.y2 + padY,
    1,
    raw.height,
  );

  const cropW = Math.max(1, x2 - x1);
  const cropH = Math.max(1, y2 - y1);

  const ratio = cropW / cropH;

  const resizedW = Math.min(
    REC_W,
    Math.max(1, Math.ceil(REC_H * ratio)),
  );

  const input =
    new Float32Array(3 * REC_H * REC_W);

  // Paddle RecResizeImg pads with zeros after [-1, 1] normalization.
  input.fill(0);

  const plane = REC_H * REC_W;

  for (let y = 0; y < REC_H; y++) {
    const sy =
      y1 +
      ((y + 0.5) / REC_H) *
        (y2 - y1);

    for (let x = 0; x < resizedW; x++) {
      const sx =
        x1 +
        ((x + 0.5) / resizedW) *
          (x2 - x1);

      const [r, g, b] =
        sampleRgbBilinear(raw, sx, sy);

      const pos = y * REC_W + x;

      // RecResizeImg operates on BGR image.
      input[pos] = b / 127.5 - 1;
      input[plane + pos] =
        g / 127.5 - 1;
      input[plane * 2 + pos] =
        r / 127.5 - 1;
    }
  }

  return input;
};

const decodeCtcAt = (
  outputData: Float32Array,
  dims: readonly number[],
  dictionary: string[],
  batchIndex: number,
) => {
  if (dims.length !== 3) {
    throw new Error(
      `Model 2 output dims lạ: ${JSON.stringify(dims)}`,
    );
  }

  const batch = Number(dims[0]);
  const timeSteps = Number(dims[1]);
  const classes = Number(dims[2]);

  if (batchIndex < 0 || batchIndex >= batch) {
    throw new Error(
      `Batch index ${batchIndex} vượt output batch ${batch}.`,
    );
  }

  const sampleSize = timeSteps * classes;
  const sampleOffset = batchIndex * sampleSize;

  if (sampleOffset + sampleSize > outputData.length) {
    throw new Error(
      'Model 2 output data không khớp dims.',
    );
  }

  const chars =
    classes === dictionary.length + 2
      ? ['blank', ...dictionary, ' ']
      : ['blank', ...dictionary];

  let previous = -1;
  const outChars: string[] = [];
  const margins: number[] = [];

  for (let t = 0; t < timeSteps; t++) {
    const base =
      sampleOffset + t * classes;

    let bestIndex = 0;
    let best = -Infinity;
    let second = -Infinity;

    for (let c = 0; c < classes; c++) {
      const value = Number(outputData[base + c]);

      if (value > best) {
        second = best;
        best = value;
        bestIndex = c;
      } else if (value > second) {
        second = value;
      }
    }

    if (
      bestIndex !== 0 &&
      bestIndex !== previous
    ) {
      const ch = chars[bestIndex];

      if (typeof ch === 'string') {
        outChars.push(ch);

        margins.push(
          1 / (1 + Math.exp(-(best - second))),
        );
      }
    }

    previous = bestIndex;
  }

  const confidence =
    margins.length > 0
      ? margins.reduce((a, b) => a + b, 0) /
        margins.length
      : 0;

  return {
    text: outChars.join(''),
    confidence,
  };
};

const recognizeBatch = async (
  session: InferenceSession,
  raw: RawImage,
  boxes: TextBox[],
  dictionary: string[],
): Promise<OcrLine[]> => {
  if (boxes.length === 0) {
    return [];
  }

  const singleSize = 3 * REC_H * REC_W;
  const batchData =
    new Float32Array(boxes.length * singleSize);

  for (let i = 0; i < boxes.length; i++) {
    const single =
      buildRecognizerInput(raw, boxes[i]);

    batchData.set(
      single,
      i * singleSize,
    );
  }

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const tensor = new Tensor(
    'float32',
    batchData,
    [boxes.length, 3, REC_H, REC_W],
  );

  const outputs = await session.run({
    [inputName]: tensor,
  });

  const output = outputs[outputName];

  if (!output) {
    throw new Error(
      'Model 2 ONNX không trả output.',
    );
  }

  const dims = output.dims.map(Number);
  const data = output.data as Float32Array;

  const lines: OcrLine[] = [];

  for (let i = 0; i < boxes.length; i++) {
    const decoded = decodeCtcAt(
      data,
      dims,
      dictionary,
      i,
    );

    lines.push({
      ...boxes[i],
      text: decoded.text,
      confidence: decoded.confidence,
    });
  }

  return lines;
};

const chooseReceiver = (
  lines: OcrLine[],
) => {
  const receiverAnchors = lines.filter(line => {
    const t = normalizeText(line.text);
    return RECEIVER_KEYS.some(k => t.includes(k));
  });

  const senderAnchors = lines.filter(line => {
    const t = normalizeText(line.text);
    return SENDER_KEYS.some(k => t.includes(k));
  });

  const badAnchors = lines.filter(line => {
    const t = normalizeText(line.text);
    return BAD_KEYS.some(k => t.includes(k));
  });

  const center = (b: TextBox) => ({
    x: (b.x1 + b.x2) / 2,
    y: (b.y1 + b.y2) / 2,
  });

  let best:
    | {
        phone: string;
        score: number;
        line: OcrLine;
      }
    | undefined;

  for (const line of lines) {
    const phone = normalizeVnPhone(line.text);

    if (!phone) {
      continue;
    }

    const c = center(line);
    const own = normalizeText(line.text);

    let score =
      100 +
      line.confidence * 20 +
      line.score * 15;

    if (
      own.includes('sdt') ||
      own.includes('phone') ||
      own.includes('tel') ||
      own.includes('mobile')
    ) {
      score += 20;
    }

    for (const anchor of receiverAnchors) {
      const a = center(anchor);
      const dx = Math.abs(c.x - a.x);
      const dy = Math.abs(c.y - a.y);

      score += Math.max(
        0,
        85 - 0.18 * dy - 0.07 * dx,
      );

      if (c.y >= a.y - 25) {
        score += 15;
      }
    }

    for (const anchor of senderAnchors) {
      const a = center(anchor);
      const dx = Math.abs(c.x - a.x);
      const dy = Math.abs(c.y - a.y);

      score -= Math.max(
        0,
        85 - 0.18 * dy - 0.07 * dx,
      );
    }

    for (const anchor of badAnchors) {
      const a = center(anchor);

      if (
        Math.abs(c.y - a.y) < 100 &&
        Math.abs(c.x - a.x) < 320
      ) {
        score -= 130;
      }
    }

    if (!best || score > best.score) {
      best = {
        phone,
        score,
        line,
      };
    }
  }

  return best;
};

const runOrientation = async (
  detector: InferenceSession,
  recognizer: InferenceSession,
  dictionary: string[],
  original: RawImage,
  orientation: 0 | 90 | 180 | 270,
): Promise<ReceiverPhoneResult> => {
  const orientationStart = Date.now();
  const raw = rotateRaw(original, orientation);

  const detStart = Date.now();
  const boxes =
    await detectTextBoxes(detector, raw);
  const detMs = Date.now() - detStart;

  const lines: OcrLine[] = [];
  let recMs = 0;
  let selected:
    | {
        phone: string;
        score: number;
        line: OcrLine;
      }
    | undefined;

  // OCR in small batches.
  // Output has 18,710 classes, so batching every box at once would waste RAM.
  for (
    let startIndex = 0;
    startIndex < boxes.length;
    startIndex += REC_BATCH_SIZE
  ) {
    const batch =
      boxes.slice(
        startIndex,
        startIndex + REC_BATCH_SIZE,
      );

    try {
      const recStart = Date.now();

      const batchLines =
        await recognizeBatch(
          recognizer,
          raw,
          batch,
          dictionary,
        );

      recMs += Date.now() - recStart;

      for (const line of batchLines) {
        if (
          line.text.trim().length > 0 &&
          line.confidence >= 0.20
        ) {
          lines.push(line);
        }
      }

      // Reading order is already preserved by detector boxes.
      selected = chooseReceiver(lines);

      // If receiver context + valid phone is already strong,
      // do not OCR the remaining unrelated bill text.
      if (
        selected &&
        selected.score >= FAST_ACCEPT_SCORE &&
        selected.line.confidence >= FAST_ACCEPT_CONF
      ) {
        console.log(
          `⚡ EARLY STOP ${orientation}°:`,
          selected.phone,
          `score=${selected.score.toFixed(1)}`,
          `after ${Math.min(
            startIndex + batch.length,
            boxes.length,
          )}/${boxes.length} boxes`,
        );
        break;
      }
    } catch (error) {
      console.warn(
        `OCR batch ${startIndex}-${startIndex + batch.length - 1} fail:`,
        error,
      );
    }
  }

  lines.sort((a, b) => {
    const ay = (a.y1 + a.y2) / 2;
    const by = (b.y1 + b.y2) / 2;

    if (Math.abs(ay - by) > 14) {
      return ay - by;
    }

    return a.x1 - b.x1;
  });

  selected = chooseReceiver(lines);

  console.log(
    `===== OCR ${orientation}° =====`,
  );

  for (const line of lines) {
    console.log(
      `[${line.confidence.toFixed(2)}]`,
      line.text,
    );
  }

  const orientationScore =
    selected?.score ??
    lines.reduce(
      (sum, l) => sum + l.confidence,
      0,
    );

  const totalMs =
    Date.now() - orientationStart;

  console.log(
    `⏱️ OCR ${orientation}° timing:`,
    `det=${detMs}ms`,
    `rec=${recMs}ms`,
    `total=${totalMs}ms`,
  );

  return {
    phone: selected?.phone ?? null,
    score: orientationScore,
    orientation,
    lines,
    selectedLine: selected?.line,
    debug:
      `orientation=${orientation}°, ` +
      `boxes=${boxes.length}, ` +
      `ocrLines=${lines.length}, ` +
      `selected=${selected?.phone ?? 'none'}, ` +
      `score=${orientationScore.toFixed(1)}, ` +
      `det=${detMs}ms, rec=${recMs}ms, total=${totalMs}ms`,
  };
};

const createFastSession = async (
  modelPath: string,
) => {
  try {
    console.log(
      '⚡ Creating ONNX session with XNNPACK...',
    );

    return await InferenceSession.create(
      modelPath,
      {
        executionProviders: [
          'xnnpack',
          'cpu',
        ],
        graphOptimizationLevel: 'all',
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        executionMode: 'sequential',
        enableCpuMemArena: true,
        enableMemPattern: true,
      },
    );
  } catch (error) {
    console.warn(
      '⚠️ XNNPACK init failed, fallback CPU:',
      error,
    );

    return InferenceSession.create(
      modelPath,
      {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        executionMode: 'sequential',
        enableCpuMemArena: true,
        enableMemPattern: true,
      },
    );
  }
};

export const createSmartLockerOcr =
  async (): Promise<SmartLockerOcrEngine> => {
    console.log(
      '====================================',
    );
    console.log(
      '🚀 Loading SmartLocker ONNX OCR...',
    );

    const detectorPath =
      await copyAssetFresh(
        'smartlocker/model1_detector.onnx',
        'smartlocker_model1_detector.onnx',
      );

    const recognizerPath =
      await copyAssetFresh(
        'smartlocker/model2_recognizer.onnx',
        'smartlocker_model2_recognizer.onnx',
      );

    const keyText =
      await RNFS.readFileAssets(
        'smartlocker/ppocr_keys.txt',
        'utf8',
      );

    const dictionary =
      keyText
        .split(/\r?\n/)
        .filter(line => line.length > 0);

    console.log(
      'OCR dictionary:',
      dictionary.length,
      'characters',
    );

    const detector =
      await createFastSession(
        detectorPath,
      );

    const recognizer =
      await createFastSession(
        recognizerPath,
      );

    console.log(
      '✅ MODEL 1 ONNX:',
      detector.inputNames,
      '->',
      detector.outputNames,
    );

    console.log(
      '✅ MODEL 2 ONNX:',
      recognizer.inputNames,
      '->',
      recognizer.outputNames,
    );

    console.log(
      '✅ SmartLocker ONNX OCR READY',
    );
    console.log(
      '====================================',
    );

    const scanJpeg = async (
      path: string,
    ): Promise<ReceiverPhoneResult> => {
      const totalStart = Date.now();

      const decodeStart = Date.now();
      const original =
        await decodeJpeg(path);
      const decodeMs =
        Date.now() - decodeStart;

      console.log(
        '📷 OCR SOURCE:',
        `${original.width}x${original.height}`,
        `decode=${decodeMs}ms`,
      );

      // Most camera photos already arrive upright.
      // Only rotate if the fast 0° pass does not confidently identify receiver phone.
      const orientations:
        Array<0 | 90 | 270 | 180> =
          [0, 90, 270, 180];

      const results: ReceiverPhoneResult[] =
        [];

      for (const degree of orientations) {
        try {
          const current =
            await runOrientation(
              detector,
              recognizer,
              dictionary,
              original,
              degree,
            );

          results.push(current);

          // This is the key latency optimization:
          // if 0° (or any fallback angle) already has a strong receiver phone,
          // return immediately instead of re-running detector+OCR 3 more times.
          if (
            current.phone &&
            current.score >= FAST_ACCEPT_SCORE &&
            (
              current.selectedLine?.confidence ??
              0
            ) >= FAST_ACCEPT_CONF
          ) {
            const totalMs =
              Date.now() - totalStart;

            console.log(
              '⚡ FAST ACCEPT:',
              current.phone,
              `${degree}°`,
              `total=${totalMs}ms`,
            );

            return {
              ...current,
              debug:
                `${current.debug}, ` +
                `decode=${decodeMs}ms, ` +
                `scanTotal=${totalMs}ms, FAST`,
            };
          }
        } catch (error) {
          console.warn(
            `Orientation ${degree}° failed:`,
            error,
          );
        }
      }

      if (results.length === 0) {
        throw new Error(
          'Không orientation nào chạy OCR được.',
        );
      }

      const withPhone =
        results.filter(r => !!r.phone);

      const best =
        (withPhone.length > 0
          ? withPhone
          : results
        ).sort((a, b) => b.score - a.score)[0];

      const totalMs =
        Date.now() - totalStart;

      console.log(
        '🎯 FINAL RECEIVER RESULT:',
        best,
        `scanTotal=${totalMs}ms`,
      );

      return {
        ...best,
        debug:
          `${best.debug}, ` +
          `decode=${decodeMs}ms, ` +
          `scanTotal=${totalMs}ms`,
      };
    };

    const dispose = async () => {
      try {
        await detector.release();
      } catch {}

      try {
        await recognizer.release();
      } catch {}
    };

    return {
      detector,
      recognizer,
      dictionary,
      scanJpeg,
      dispose,
    };
  };
