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
const REC_BATCH_SIZE = 2;

type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

type SemanticRole =
  | 'receiver'
  | 'sender'
  | null;

const RECEIVER_TARGETS = [
  'nguoi nhan',
  'thong tin nguoi nhan',
  'receiver',
  'recipient',
  'consignee',
];

const SENDER_TARGETS = [
  'nguoi gui',
  'thong tin nguoi gui',
  'sender',
  'ship from',
  'from',
];

const RECEIVER_FORMS = new Set([
  'nguoinhan',
  'nguinhan',
  'nguinhn',
  'nguoinhn',
  'thongtinnguoinhan',
  'thongtinnguinhan',
  'thongtinnguinhn',
  'thngtinnguoinhan',
  'thngtinnguinhan',
  'thngtinnguinhn',
]);

const SENDER_FORMS = new Set([
  'nguoigui',
  'nguigui',
  'nguigi',
  'nguoigi',
  'thongtinnguoigui',
  'thongtinnguigui',
  'thongtinnguigi',
  'thngtinnguoigui',
  'thngtinnguigui',
  'thngtinnguigi',
]);

const GENERIC_NON_ROLE_FORMS = new Set([
  'delivery',
  'smartlockerdelivery',
  'giaodentu',
  'giaodentuantoan',
  'giaodentuantoantienloimoiluc',
]);

const SHORT_RECEIVER_FORMS = new Set([
  'den',
  'dn',
  'to',
]);

const SHORT_SENDER_FORMS = new Set([
  'tu',
]);

const NEGATIVE_WORDS = [
  'hotline',
  'cskh',
  'tong dai',
  'tracking',
  'ma van don',
  'ma vn don',
  'van don',
  'ma don hang',
  'ma don',
  'order id',
  'parcel id',
  'tracking number',
];

const NEGATIVE_COMPACT_WORDS = [
  'hotline',
  'cskh',
  'tongdai',
  'tracking',
  'mavandon',
  'mavndon',
  'vandon',
  'madonhang',
  'madon',
  'orderid',
  'parcelid',
  'trackingnumber',
];

const CONF_BONUS: Record<ConfidenceLevel, number> = {
  HIGH: 4,
  MEDIUM: 2,
  LOW: 0,
};

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

export type CandidateScore = {
  phone: string;
  score: number;
  text: string;
  lineIndex: number;
  receiverDistance: number | null;
  senderDistance: number | null;
  negativeDistance: number | null;
  reasons: string[];
};

export type RotationPhoneResult = {
  phone: string | null;
  score: number | null;
  margin: number | null;
  confidence: ConfidenceLevel;
  method: string;
  orientation: 0 | 90 | 180 | 270;
  lines: OcrLine[];
  selectedLine?: OcrLine;
  receiverAnchors: string[];
  senderAnchors: string[];
  candidateScores: CandidateScore[];
  debug: string;
};

export type ReceiverPhoneResult = {
  phone: string | null;
  score: number;
  margin: number | null;
  confidence: ConfidenceLevel;
  method: string;
  orientation: 0 | 90 | 180 | 270;
  lines: OcrLine[];
  selectedLine?: OcrLine;
  rotations: RotationPhoneResult[];
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
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const compactText = (value: string) =>
  normalizeText(value).replace(/[^a-z0-9]/g, '');

const levenshteinDistance = (
  a: string,
  b: string,
) => {
  const aa = compactText(a);
  const bb = compactText(b);

  if (aa === bb) {
    return 0;
  }

  if (!aa.length) {
    return bb.length;
  }

  if (!bb.length) {
    return aa.length;
  }

  const prev = new Array(bb.length + 1);
  const curr = new Array(bb.length + 1);

  for (let j = 0; j <= bb.length; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= aa.length; i++) {
    curr[0] = i;

    for (let j = 1; j <= bb.length; j++) {
      const cost =
        aa[i - 1] === bb[j - 1]
          ? 0
          : 1;

      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }

    for (let j = 0; j <= bb.length; j++) {
      prev[j] = curr[j];
    }
  }

  return prev[bb.length];
};

const similarity = (
  a: string,
  b: string,
) => {
  const aa = compactText(a);
  const bb = compactText(b);

  if (!aa || !bb) {
    return 0;
  }

  const maxLen = Math.max(
    aa.length,
    bb.length,
  );

  if (maxLen === 0) {
    return 0;
  }

  return (
    1 -
    levenshteinDistance(
      aa,
      bb,
    ) /
      maxLen
  );
};

const targetScore = (
  text: string,
  targets: string[],
  noisyForms: Set<string>,
) => {
  const compact =
    compactText(text);

  if (!compact) {
    return 0;
  }

  if (
    noisyForms.has(
      compact,
    )
  ) {
    return 1;
  }

  let best = 0;

  for (const target of targets) {
    const t =
      compactText(target);

    if (!t) {
      continue;
    }

    if (compact === t) {
      best = Math.max(
        best,
        1,
      );
      continue;
    }

    if (
      t.length >= 6 &&
      compact.includes(t)
    ) {
      best = Math.max(
        best,
        0.96,
      );
    }

    best = Math.max(
      best,
      similarity(
        compact,
        t,
      ),
    );
  }

  return best;
};

const semanticRole = (
  text: string,
): {
  role: SemanticRole;
  receiverScore: number;
  senderScore: number;
} => {
  const compact =
    compactText(text);

  if (!compact) {
    return {
      role: null,
      receiverScore: 0,
      senderScore: 0,
    };
  }

  if (
    GENERIC_NON_ROLE_FORMS.has(
      compact,
    )
  ) {
    return {
      role: null,
      receiverScore: 0,
      senderScore: 0,
    };
  }

  if (
    SHORT_RECEIVER_FORMS.has(
      compact,
    )
  ) {
    return {
      role: 'receiver',
      receiverScore: 1,
      senderScore: 0,
    };
  }

  if (
    SHORT_SENDER_FORMS.has(
      compact,
    )
  ) {
    return {
      role: 'sender',
      receiverScore: 0,
      senderScore: 1,
    };
  }

  if (
    compact.includes(
      'giaodentu',
    ) ||
    compact === 'delivery' ||
    compact.endsWith(
      'delivery',
    )
  ) {
    return {
      role: null,
      receiverScore: 0,
      senderScore: 0,
    };
  }

  const receiverScore =
    targetScore(
      text,
      RECEIVER_TARGETS,
      RECEIVER_FORMS,
    );

  const senderScore =
    targetScore(
      text,
      SENDER_TARGETS,
      SENDER_FORMS,
    );

  const threshold = 0.68;
  const margin = 0.08;

  if (
    receiverScore >=
      threshold &&
    receiverScore -
      senderScore >=
      margin
  ) {
    return {
      role: 'receiver',
      receiverScore,
      senderScore,
    };
  }

  if (
    senderScore >=
      threshold &&
    senderScore -
      receiverScore >=
      margin
  ) {
    return {
      role: 'sender',
      receiverScore,
      senderScore,
    };
  }

  return {
    role: null,
    receiverScore,
    senderScore,
  };
};

const isNegativeAnchorText = (
  value: string,
) => {
  const normalized =
    normalizeText(value);

  const compact =
    compactText(value);

  if (
    NEGATIVE_WORDS.some(
      key =>
        normalized.includes(
          key,
        ),
    )
  ) {
    return true;
  }

  return (
    NEGATIVE_COMPACT_WORDS.some(
      key =>
        compact.includes(
          key,
        ),
    )
  );
};

const normalizePhoneDigits = (
  candidate: string,
): string | null => {
  let digits =
    String(candidate || '').replace(/\D/g, '');

  // (+84)0xxxxxxxxx
  if (
    digits.length === 12 &&
    digits.startsWith('840')
  ) {
    digits = digits.slice(2);
  }

  // +84xxxxxxxxx / 84xxxxxxxxx
  if (
    digits.length === 11 &&
    digits.startsWith('84')
  ) {
    digits = `0${digits.slice(2)}`;
  }

  if (/^0[35789]\d{8}$/.test(digits)) {
    return digits;
  }

  return null;
};

const extractVnPhones = (
  value: string,
): string[] => {
  if (
    isNegativeAnchorText(
      value,
    )
  ) {
    return [];
  }

  const source =
    String(
      value || '',
    );

  const phonePattern =
    /(?:\+?84|0)[\s().-]*[35789](?:[\s().-]*\d){8}/g;

  const phones: string[] = [];
  let match:
    | RegExpExecArray
    | null;

  while (
    (
      match =
        phonePattern.exec(
          source,
        )
    ) !== null
  ) {
    const start =
      match.index;

    const end =
      start +
      match[0].length;

    const before =
      start > 0
        ? source[
            start - 1
          ]
        : '';

    const after =
      end <
      source.length
        ? source[end]
        : '';

    if (
      before &&
      /[A-Za-z0-9]/.test(
        before,
      )
    ) {
      continue;
    }

    if (
      after &&
      /[A-Za-z0-9]/.test(
        after,
      )
    ) {
      continue;
    }

    const phone =
      normalizePhoneDigits(
        match[0],
      );

    if (
      phone &&
      !phones.includes(
        phone,
      )
    ) {
      phones.push(
        phone,
      );
    }
  }

  return phones;
};

const normalizeVnPhone = (
  value: string,
): string | null =>
  extractVnPhones(
    value,
  )[0] ?? null;

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

type ScoredLine = OcrLine & {
  index: number;
  cx: number;
  cy: number;
  role: SemanticRole;
  isNegative: boolean;
  phones: string[];
};

const lineCenter = (
  line: TextBox,
) => ({
  x:
    (line.x1 + line.x2) /
    2,
  y:
    (line.y1 + line.y2) /
    2,
});

const buildScoredLines = (
  lines: OcrLine[],
): ScoredLine[] =>
  lines.map(
    (
      line,
      index,
    ) => {
      const center =
        lineCenter(line);

      const semantic =
        semanticRole(
          line.text,
        );

      return {
        ...line,
        index,
        cx: center.x,
        cy: center.y,
        role:
          semantic.role,
        isNegative:
          isNegativeAnchorText(
            line.text,
          ),
        phones:
          extractVnPhones(
            line.text,
          ),
      };
    },
  );

const layoutSpan = (
  lines: ScoredLine[],
) => {
  if (
    lines.length === 0
  ) {
    return {
      spanX: 1,
      spanY: 1,
    };
  }

  const xs =
    lines.map(
      l => l.cx,
    );

  const ys =
    lines.map(
      l => l.cy,
    );

  return {
    spanX: Math.max(
      Math.max(...xs) -
        Math.min(...xs),
      1,
    ),
    spanY: Math.max(
      Math.max(...ys) -
        Math.min(...ys),
      1,
    ),
  };
};

const normalizedDistance = (
  a: ScoredLine,
  b: ScoredLine,
  spanX: number,
  spanY: number,
) => {
  const dx =
    (a.cx - b.cx) /
    spanX;

  const dy =
    (a.cy - b.cy) /
    spanY;

  return Math.sqrt(
    dx * dx + dy * dy,
  );
};

const proximityStrength = (
  distance: number | null,
  radius: number,
) => {
  if (
    distance === null ||
    distance >= radius
  ) {
    return 0;
  }

  return (
    1 -
    distance / radius
  );
};

const nearestDistance = (
  line: ScoredLine,
  anchors: ScoredLine[],
  spanX: number,
  spanY: number,
): number | null => {
  if (
    anchors.length === 0
  ) {
    return null;
  }

  let best =
    Number.POSITIVE_INFINITY;

  for (
    const anchor of anchors
  ) {
    best = Math.min(
      best,
      normalizedDistance(
        line,
        anchor,
        spanX,
        spanY,
      ),
    );
  }

  return Number.isFinite(
    best,
  )
    ? best
    : null;
};

const nearestIndexGap = (
  line: ScoredLine,
  anchors: ScoredLine[],
): number | null => {
  if (
    anchors.length === 0
  ) {
    return null;
  }

  let best =
    Number.POSITIVE_INFINITY;

  for (
    const anchor of anchors
  ) {
    best = Math.min(
      best,
      Math.abs(
        line.index -
          anchor.index,
      ),
    );
  }

  return Number.isFinite(
    best,
  )
    ? best
    : null;
};

const scorePhoneCandidates = (
  lines: OcrLine[],
) => {
  const scoredLines =
    buildScoredLines(
      lines,
    );

  const receivers =
    scoredLines.filter(
      l =>
        l.role ===
        'receiver',
    );

  const senders =
    scoredLines.filter(
      l =>
        l.role ===
        'sender',
    );

  const negatives =
    scoredLines.filter(
      l =>
        l.isNegative,
    );

  const phoneLines =
    scoredLines.filter(
      l =>
        l.phones.length >
        0,
    );

  const {
    spanX,
    spanY,
  } = layoutSpan(
    scoredLines,
  );

  const candidateMap =
    new Map<
      string,
      CandidateScore
    >();

  for (
    const line of phoneLines
  ) {
    for (
      const phone of
        line.phones
    ) {
      const receiverDistance =
        nearestDistance(
          line,
          receivers,
          spanX,
          spanY,
        );

      const senderDistance =
        nearestDistance(
          line,
          senders,
          spanX,
          spanY,
        );

      const negativeDistance =
        nearestDistance(
          line,
          negatives,
          spanX,
          spanY,
        );

      const receiverGap =
        nearestIndexGap(
          line,
          receivers,
        );

      const senderGap =
        nearestIndexGap(
          line,
          senders,
        );

      let score = 0;
      const reasons: string[] =
        [];

      const receiverStrength =
        proximityStrength(
          receiverDistance,
          0.55,
        );

      if (
        receiverStrength > 0
      ) {
        const delta =
          12 *
          receiverStrength;

        score += delta;

        reasons.push(
          `receiver_geo:+${delta.toFixed(2)}`,
        );
      }

      const senderStrength =
        proximityStrength(
          senderDistance,
          0.55,
        );

      if (
        senderStrength > 0
      ) {
        const delta =
          11 *
          senderStrength;

        score -= delta;

        reasons.push(
          `sender_geo:-${delta.toFixed(2)}`,
        );
      }

      const negativeStrength =
        proximityStrength(
          negativeDistance,
          0.32,
        );

      if (
        negativeStrength >
        0
      ) {
        const delta =
          8 *
          negativeStrength;

        score -= delta;

        reasons.push(
          `negative_geo:-${delta.toFixed(2)}`,
        );
      }

      if (
        receiverGap !==
          null &&
        receiverGap <= 4
      ) {
        const delta =
          (2.5 *
            (5 -
              receiverGap)) /
          5;

        score += delta;

        reasons.push(
          `receiver_order:+${delta.toFixed(2)}`,
        );
      }

      if (
        senderGap !== null &&
        senderGap <= 4
      ) {
        const delta =
          (2 *
            (5 -
              senderGap)) /
          5;

        score -= delta;

        reasons.push(
          `sender_order:-${delta.toFixed(2)}`,
        );
      }

      if (
        receivers.length ===
          0 &&
        senders.length >
          0 &&
        senderDistance !==
          null
      ) {
        const delta =
          Math.min(
            3,
            4 *
              senderDistance,
          );

        score += delta;

        reasons.push(
          `away_from_sender:+${delta.toFixed(2)}`,
        );
      }

      const compact =
        compactText(
          line.text,
        );

      if (
        compact.includes(
          'sdt',
        ) ||
        compact.includes(
          'phone',
        ) ||
        compact.includes(
          'tel',
        ) ||
        compact.includes(
          'mobile',
        )
      ) {
        score += 0.75;

        reasons.push(
          'phone_label:+0.75',
        );
      }

      const row:
        CandidateScore = {
        phone,
        score,
        text: line.text,
        lineIndex:
          line.index,
        receiverDistance,
        senderDistance,
        negativeDistance,
        reasons,
      };

      const old =
        candidateMap.get(
          phone,
        );

      if (
        !old ||
        row.score >
          old.score
      ) {
        candidateMap.set(
          phone,
          row,
        );
      }
    }
  }

  const ranked =
    Array.from(
      candidateMap.values(),
    ).sort(
      (a, b) =>
        b.score -
        a.score,
    );

  return {
    ranked,
    receivers,
    senders,
  };
};

const extractReceiverForRotation = (
  lines: OcrLine[],
  orientation:
    | 0
    | 90
    | 180
    | 270,
): RotationPhoneResult => {
  const scored =
    scorePhoneCandidates(
      lines,
    );

  const receiverAnchors =
    scored.receivers.map(
      l => l.text,
    );

  const senderAnchors =
    scored.senders.map(
      l => l.text,
    );

  const ranked =
    scored.ranked;

  if (
    ranked.length === 0
  ) {
    return {
      phone: null,
      score: null,
      margin: null,
      confidence: 'LOW',
      method:
        'NO_VALID_PHONE',
      orientation,
      lines,
      receiverAnchors,
      senderAnchors,
      candidateScores: [],
      debug:
        `orientation=${orientation}°, no valid phone`,
    };
  }

  if (
    ranked.length === 1
  ) {
    const top =
      ranked[0];

    const selectedLine =
      lines[
        top.lineIndex
      ];

    const confidence:
      ConfidenceLevel =
        top.score >= 4
          ? 'HIGH'
          : 'MEDIUM';

    return {
      phone: top.phone,
      score: top.score,
      margin: null,
      confidence,
      method:
        'SCORE_ONLY_ONE_PHONE_V4',
      orientation,
      lines,
      selectedLine,
      receiverAnchors,
      senderAnchors,
      candidateScores:
        ranked,
      debug:
        `orientation=${orientation}°, selected=${top.phone}, score=${top.score.toFixed(2)}, single`,
    };
  }

  const top = ranked[0];
  const second =
    ranked[1];

  const margin =
    top.score -
    second.score;

  if (
    top.score < 1 ||
    margin < 1.25
  ) {
    return {
      phone: null,
      score: top.score,
      margin,
      confidence: 'LOW',
      method:
        'SCORE_UNCERTAIN_V4',
      orientation,
      lines,
      receiverAnchors,
      senderAnchors,
      candidateScores:
        ranked,
      debug:
        `orientation=${orientation}°, uncertain, top=${top.phone}:${top.score.toFixed(2)}, margin=${margin.toFixed(2)}`,
    };
  }

  const confidence:
    ConfidenceLevel =
      top.score >= 4 &&
      margin >= 2
        ? 'HIGH'
        : 'MEDIUM';

  return {
    phone: top.phone,
    score: top.score,
    margin,
    confidence,
    method:
      'CANDIDATE_SCORE_V4',
    orientation,
    lines,
    selectedLine:
      lines[
        top.lineIndex
      ],
    receiverAnchors,
    senderAnchors,
    candidateScores:
      ranked,
    debug:
      `orientation=${orientation}°, selected=${top.phone}, score=${top.score.toFixed(2)}, margin=${margin.toFixed(2)}`,
  };
};

const chooseAcrossRotations = (
  rotationResults:
    RotationPhoneResult[],
) => {
  type Aggregate = {
    candidateScoreSum: number;
    voteBonus: number;
    selectedCount: number;
    highCount: number;
    positiveCandidateCount: number;
    finalScore: number;
  };

  const agg =
    new Map<
      string,
      Aggregate
    >();

  const ensure = (
    phone: string,
  ) => {
    let stat =
      agg.get(phone);

    if (!stat) {
      stat = {
        candidateScoreSum: 0,
        voteBonus: 0,
        selectedCount: 0,
        highCount: 0,
        positiveCandidateCount:
          0,
        finalScore: 0,
      };

      agg.set(
        phone,
        stat,
      );
    }

    return stat;
  };

  for (
    const result of
      rotationResults
  ) {
    for (
      const candidate of
        result.candidateScores
    ) {
      const stat =
        ensure(
          candidate.phone,
        );

      const clipped =
        Math.max(
          -12,
          Math.min(
            12,
            candidate.score,
          ),
        );

      stat.candidateScoreSum +=
        clipped;

      if (
        candidate.score > 0
      ) {
        stat.positiveCandidateCount +=
          1;
      }
    }

    if (
      result.phone
    ) {
      const stat =
        ensure(
          result.phone,
        );

      stat.voteBonus +=
        CONF_BONUS[
          result.confidence
        ];

      stat.selectedCount +=
        1;

      if (
        result.confidence ===
        'HIGH'
      ) {
        stat.highCount +=
          1;
      }
    }
  }

  const ranked =
    Array.from(
      agg.entries(),
    ).map(
      ([phone, stat]) => {
        const consistencyBonus =
          1.5 *
          stat.positiveCandidateCount;

        stat.finalScore =
          stat.candidateScoreSum +
          stat.voteBonus +
          consistencyBonus;

        return {
          phone,
          ...stat,
        };
      },
    ).sort(
      (a, b) =>
        b.finalScore -
          a.finalScore ||
        b.selectedCount -
          a.selectedCount ||
        b.highCount -
          a.highCount ||
        b.positiveCandidateCount -
          a.positiveCandidateCount,
    );

  if (
    ranked.length === 0
  ) {
    return {
      phone: null,
      score: null,
      margin: null,
      confidence:
        'LOW' as ConfidenceLevel,
      method:
        'ALL_ROTATIONS_NO_PHONE_V4',
    };
  }

  const top =
    ranked[0];

  const secondScore =
    ranked.length >= 2
      ? ranked[1]
          .finalScore
      : null;

  const margin =
    secondScore === null
      ? null
      : top.finalScore -
        secondScore;

  if (
    top.finalScore <= 0
  ) {
    return {
      phone: null,
      score:
        top.finalScore,
      margin,
      confidence:
        'LOW' as ConfidenceLevel,
      method:
        'ROTATION_SCORE_NONPOSITIVE_V4',
    };
  }

  if (
    secondScore !== null &&
    margin !== null &&
    margin < 2
  ) {
    return {
      phone: null,
      score:
        top.finalScore,
      margin,
      confidence:
        'LOW' as ConfidenceLevel,
      method:
        'ROTATION_SCORE_TIE_V4',
    };
  }

  const confidence:
    ConfidenceLevel =
      top.finalScore >= 6 &&
      (
        top.highCount >= 1 ||
        top.selectedCount >=
          2
      )
        ? 'HIGH'
        : 'MEDIUM';

  return {
    phone: top.phone,
    score:
      top.finalScore,
    margin,
    confidence,
    method:
      'ROTATION_SCORE_V4',
  };
};

const runOrientation = async (
  detector: InferenceSession,
  recognizer: InferenceSession,
  dictionary: string[],
  original: RawImage,
  orientation: 0 | 90 | 180 | 270,
): Promise<RotationPhoneResult> => {
  const orientationStart =
    Date.now();

  const raw =
    rotateRaw(
      original,
      orientation,
    );

  const detStart =
    Date.now();

  const boxes =
    await detectTextBoxes(
      detector,
      raw,
    );

  const detMs =
    Date.now() -
    detStart;

  const lines: OcrLine[] =
    [];

  let recMs = 0;

  // IMPORTANT V4:
  // OCR theo batch và chấm V4 tăng dần.
  // Chỉ early-stop khi đã có đủ receiver/sender evidence + >=2 phone candidates.
  for (
    let startIndex = 0;
    startIndex <
    boxes.length;
    startIndex +=
    REC_BATCH_SIZE
  ) {
    const batch =
      boxes.slice(
        startIndex,
        startIndex +
          REC_BATCH_SIZE,
      );

    try {
      const recStart =
        Date.now();

      const batchLines =
        await recognizeBatch(
          recognizer,
          raw,
          batch,
          dictionary,
        );

      recMs +=
        Date.now() -
        recStart;

      for (
        const line of
          batchLines
      ) {
        if (
          line.text
            .trim()
            .length >
            0 &&
          line.confidence >=
            0.2
        ) {
          lines.push(
            line,
          );
        }
      }

      // ==================================================
      // FAST-SAFE INSIDE ONE ROTATION
      // ==================================================
      // V4 cũ phải OCR hết mọi box rồi mới chấm.
      // Trên mobile điều này rất chậm vì một bill có thể 40-50 box.
      //
      // Sau mỗi batch, thử chấm tạm. Chỉ dừng khi:
      // - đã thấy cả receiver + sender anchor
      // - có ít nhất 2 phone candidates
      // - top candidate HIGH
      // - margin >= 2
      //
      // Như vậy không dừng chỉ vì gặp SĐT đầu tiên.
      if (lines.length >= 6) {
        const partial =
          extractReceiverForRotation(
            lines,
            orientation,
          );

        if (
          partial.phone &&
          partial.confidence === 'HIGH' &&
          partial.receiverAnchors.length > 0 &&
          partial.senderAnchors.length > 0 &&
          partial.candidateScores.length >= 2 &&
          partial.margin !== null &&
          partial.margin >= 2 &&
          partial.score !== null &&
          partial.score >= 4
        ) {
          console.log(
            `⚡ PARTIAL V4 ACCEPT ${orientation}°:`,
            partial.phone,
            `lines=${lines.length}`,
            `candidates=${partial.candidateScores.length}`,
            `score=${partial.score.toFixed(2)}`,
            `margin=${partial.margin.toFixed(2)}`,
          );

          break;
        }
      }
    } catch (error) {
      console.warn(
        `OCR batch ${startIndex}-${startIndex + batch.length - 1} fail:`,
        error,
      );
    }
  }

  lines.sort(
    (a, b) => {
      const ay =
        (a.y1 + a.y2) /
        2;

      const by =
        (b.y1 + b.y2) /
        2;

      if (
        Math.abs(
          ay - by,
        ) > 14
      ) {
        return ay - by;
      }

      return (
        a.x1 - b.x1
      );
    },
  );

  const result =
    extractReceiverForRotation(
      lines,
      orientation,
    );

  const totalMs =
    Date.now() -
    orientationStart;

  console.log(
    `===== OCR V4 ${orientation}° =====`,
  );

  for (
    const line of lines
  ) {
    console.log(
      `[${line.confidence.toFixed(2)}]`,
      line.text,
    );
  }

  console.log(
    `🎯 ROTATION V4 ${orientation}°:`,
    result.phone ??
      'UNCERTAIN',
    `score=${
      result.score ===
      null
        ? 'null'
        : result.score.toFixed(
            2,
          )
    }`,
    `confidence=${result.confidence}`,
    `method=${result.method}`,
  );

  console.log(
    `⏱️ OCR ${orientation}° timing:`,
    `det=${detMs}ms`,
    `rec=${recMs}ms`,
    `total=${totalMs}ms`,
  );

  return {
    ...result,
    debug:
      `${result.debug}, ` +
      `boxes=${boxes.length}, ` +
      `ocrLines=${lines.length}, ` +
      `det=${detMs}ms, ` +
      `rec=${recMs}ms, ` +
      `total=${totalMs}ms`,
  };
};

const createFastSession = async (
  modelPath: string,
) => {
  console.log(
    '🛡️ Creating ONNX session in SAFE CPU mode...',
  );

  return InferenceSession.create(
    modelPath,
    {
      // Native crash was observed inside libonnxruntime during session.run.
      // Use CPU only first; XNNPACK can be re-enabled later after stability is proven.
      executionProviders: ['cpu'],

      graphOptimizationLevel: 'all',

      // Keep memory predictable on Android / emulator.
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      executionMode: 'sequential',

      // Disable native memory caching/pattern optimization for dynamic OCR calls.
      enableCpuMemArena: false,
      enableMemPattern: false,
    },
  );
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
      const totalStart =
        Date.now();

      const decodeStart =
        Date.now();

      const original =
        await decodeJpeg(
          path,
        );

      const decodeMs =
        Date.now() -
        decodeStart;

      console.log(
        '📷 OCR SOURCE:',
        `${original.width}x${original.height}`,
        `decode=${decodeMs}ms`,
      );

      // V4 benchmark dùng đủ 4 rotations.
      // Không accept 0° sớm, vì số đầu tiên có thể là sender.
      const orientations:
        Array<
          0 | 90 | 180 | 270
        > = [
          0,
          90,
          270,
          180,
        ];

      const rotations:
        RotationPhoneResult[] =
          [];

      for (
        const degree of
          orientations
      ) {
        try {
          const current =
            await runOrientation(
              detector,
              recognizer,
              dictionary,
              original,
              degree,
            );

          rotations.push(
            current,
          );

          // ==================================================
          // MOBILE FAST-SAFE EXIT
          // ==================================================
          // Ảnh chụp từ camera thường đã đúng chiều.
          // Nếu 0° có đầy đủ bằng chứng receiver + sender,
          // candidate thắng rõ và confidence HIGH thì không
          // cần chạy thêm 3 lần OCR nặng.
          if (
            degree === 0 &&
            current.phone &&
            current.confidence === 'HIGH' &&
            current.receiverAnchors.length > 0 &&
            current.senderAnchors.length > 0 &&
            current.score !== null &&
            current.score >= 4 &&
            (
              current.margin === null ||
              current.margin >= 2
            )
          ) {
            console.log(
              '⚡ FAST-SAFE ACCEPT 0°:',
              current.phone,
              `score=${current.score.toFixed(2)}`,
              `margin=${
                current.margin === null
                  ? 'single'
                  : current.margin.toFixed(2)
              }`,
            );
            break;
          }

          // Nếu 0° chưa đủ chắc, chạy thêm 90°.
          // Khi hai rotation độc lập cùng chọn một số và
          // aggregate đã HIGH thì có thể dừng an toàn.
          if (rotations.length >= 2) {
            const partial =
              chooseAcrossRotations(
                rotations,
              );

            const agreeing =
              partial.phone
                ? rotations.filter(
                    item =>
                      item.phone ===
                      partial.phone,
                  ).length
                : 0;

            if (
              partial.phone &&
              partial.confidence === 'HIGH' &&
              agreeing >= 2
            ) {
              console.log(
                '⚡ FAST-SAFE AGREEMENT:',
                partial.phone,
                `agree=${agreeing}`,
                `score=${partial.score.toFixed(2)}`,
              );
              break;
            }
          }
        } catch (error) {
          console.warn(
            `Orientation ${degree}° failed:`,
            error,
          );
        }
      }

      if (
        rotations.length ===
        0
      ) {
        throw new Error(
          'Không orientation nào chạy OCR được.',
        );
      }

      const final =
        chooseAcrossRotations(
          rotations,
        );

      // Chọn rotation đại diện để giữ compatibility
      // với UI cũ (orientation / lines / selectedLine).
      let representative =
        rotations[0];

      if (
        final.phone
      ) {
        const matching =
          rotations.filter(
            rotation =>
              rotation.phone ===
              final.phone,
          );

        if (
          matching.length >
          0
        ) {
          representative =
            matching.sort(
              (a, b) =>
                (b.score ??
                  Number.NEGATIVE_INFINITY) -
                (a.score ??
                  Number.NEGATIVE_INFINITY),
            )[0];
        } else {
          // Trường hợp final phone thắng nhờ candidate evidence
          // dù không được chọn riêng ở rotation nào.
          let bestCandidateScore =
            Number.NEGATIVE_INFINITY;

          for (
            const rotation of
              rotations
          ) {
            const candidate =
              rotation.candidateScores.find(
                item =>
                  item.phone ===
                  final.phone,
              );

            if (
              candidate &&
              candidate.score >
                bestCandidateScore
            ) {
              bestCandidateScore =
                candidate.score;

              representative =
                rotation;
            }
          }
        }
      } else {
        representative =
          [...rotations].sort(
            (a, b) =>
              (b.score ??
                Number.NEGATIVE_INFINITY) -
              (a.score ??
                Number.NEGATIVE_INFINITY),
          )[0];
      }

      const totalMs =
        Date.now() -
        totalStart;

      const score =
        final.score ?? 0;

      console.log(
        '🎯 FINAL RECEIVER V4:',
        final.phone ??
          'UNCERTAIN',
        `confidence=${final.confidence}`,
        `method=${final.method}`,
        `score=${score.toFixed(2)}`,
        `margin=${
          final.margin ===
          null
            ? 'null'
            : final.margin.toFixed(
                2,
              )
        }`,
        `scanTotal=${totalMs}ms`,
      );

      return {
        phone:
          final.phone,
        score,
        margin:
          final.margin,
        confidence:
          final.confidence,
        method:
          final.method,
        orientation:
          representative.orientation,
        lines:
          representative.lines,
        selectedLine:
          final.phone
            ? representative.lines.find(
                line =>
                  extractVnPhones(
                    line.text,
                  ).includes(
                    final.phone!,
                  ),
              )
            : undefined,
        rotations,
        debug:
          `V4 phone=${
            final.phone ??
            'UNCERTAIN'
          }, ` +
          `confidence=${final.confidence}, ` +
          `method=${final.method}, ` +
          `score=${score.toFixed(2)}, ` +
          `margin=${
            final.margin ===
            null
              ? 'null'
              : final.margin.toFixed(
                  2,
                )
          }, ` +
          `representative=${representative.orientation}°, ` +
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
