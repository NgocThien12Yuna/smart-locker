import React, { useEffect, useState } from 'react';

import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
  LogBox,
  Image,
} from 'react-native';

import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';

import { useIsFocused } from '@react-navigation/native';
import { loadTensorflowModel } from 'react-native-fast-tflite';

import ImageResizer from 'react-native-image-resizer';
import RNFS from 'react-native-fs';
import * as jpeg from 'jpeg-js';
import { Buffer } from 'buffer';

import { API_BASE_URL } from '../config/api';
import { useAuth } from '../context/AuthContext';

// jpeg-js trên Hermes có thể cần Buffer ở global.
if (!(globalThis as any).Buffer) {
  (globalThis as any).Buffer = Buffer;
}

LogBox.ignoreLogs([
  'TfliteModule',
  'Value is undefined',
  'HybridObject',
  'Camera Component Error',
]);

// ============================================================
// CẤU HÌNH V7 + MODEL 2 V5.2
// ============================================================

// Model 1 V7 YOLO
// Input : [1, 640, 640, 3] Float32 RGB (dataset V7 là grayscale,
//         vì vậy app cũng chuyển camera -> grayscale rồi lặp lại 3 channel)
// Output: YOLO raw, 2 class:
//   0 = receiver_block
//   1 = receiver_phone
const DETECTOR_SIZE = 640;
const YOLO_CLASSES = 2;
const YOLO_CHANNELS = 4 + YOLO_CLASSES; // 6
const YOLO_PHONE_CLASS = 1;
const YOLO_BLOCK_CLASS = 0;
// Real-camera confidence is normally lower than the synthetic test set.
// Keep a stricter threshold for receiver_block, but let receiver_phone
// through at a lower score and let Model 2 OCR validate it.
const YOLO_BLOCK_CONF_THRESHOLD = 0.12;
const YOLO_PHONE_CONF_THRESHOLD = 0.005;
const YOLO_RAW_MIN_SCORE = 0.005;
const YOLO_NMS_IOU = 0.45;
const YOLO_MAX_PHONE_CANDIDATES = 10;

// Model 2 V5.2 CRNN + CTC
// Input : [1, 64, 256, 1] Float32
// Output: [1, 64, 11]
// class 0..9 = digit, class 10 = CTC blank.
const OCR_W = 256;
const OCR_H = 64;
const OCR_CLASSES = 11;
const OCR_BLANK = 10;
const OCR_EXPECTED_TIMESTEPS = 64;

// Ảnh làm việc vẫn giữ tỉ lệ, đủ nét để crop OCR.
// Detector chỉ nhìn bản letterbox 640x640.
// OCR crop lấy từ ảnh 1280x1800 này chứ KHÔNG lấy từ ảnh detector 640.
const WORK_MAX_W = 1280;
const WORK_MAX_H = 1800;

const normalizePath = (path: string) =>
  path.startsWith('file://') ? path.replace('file://', '') : path;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const getResizer = () => {
  const resizer: any =
    (ImageResizer as any).createResizedImage ||
    (ImageResizer as any).default?.createResizedImage;

  if (typeof resizer !== 'function') {
    throw new Error('Không tìm thấy createResizedImage.');
  }

  return resizer;
};

const decodeJpegFile = async (path: string) => {
  const cleanPath = normalizePath(path);
  const base64 = await RNFS.readFile(cleanPath, 'base64');

  if (!base64) {
    throw new Error('Không đọc được ảnh JPEG.');
  }

  const jpegBuffer = Buffer.from(base64, 'base64');

  const decode: any =
    (jpeg as any).decode ||
    (jpeg as any).default?.decode ||
    jpeg;

  const rawData = decode(jpegBuffer, {
    useTArray: true,
  });

  if (!rawData || !rawData.data || !rawData.width || !rawData.height) {
    throw new Error('Không decode được JPEG.');
  }

  return rawData;
};

const saveGrayDebugJpeg = async (
  gray: Float32Array,
  width: number,
  height: number
) => {
  const rgba = Buffer.alloc(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const value = clamp(
      Math.round(gray[i] * 255),
      0,
      255
    );

    const p = i * 4;
    rgba[p] = value;
    rgba[p + 1] = value;
    rgba[p + 2] = value;
    rgba[p + 3] = 255;
  }

  const encoder: any =
    (jpeg as any).encode ||
    (jpeg as any).default?.encode;

  if (typeof encoder !== 'function') {
    throw new Error('Không tìm thấy jpeg.encode.');
  }

  const encoded = encoder(
    {
      data: rgba,
      width,
      height,
    },
    95
  );

  if (!encoded?.data) {
    throw new Error('Không encode được ảnh debug.');
  }

  const debugPath =
    `${RNFS.CachesDirectoryPath}/smartlocker_v7_crop_${Date.now()}.jpg`;

  await RNFS.writeFile(
    debugPath,
    Buffer.from(encoded.data).toString('base64'),
    'base64'
  );

  return `file://${debugPath}`;
};

// ============================================================
// IMAGE / LETTERBOX
// ============================================================

type LetterboxInfo = {
  scale: number;
  offsetX: number;
  offsetY: number;
  scaledW: number;
  scaledH: number;
};

type RawBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

const grayAtRawPixel = (
  raw: any,
  x: number,
  y: number
) => {
  const px = clamp(Math.round(x), 0, raw.width - 1);
  const py = clamp(Math.round(y), 0, raw.height - 1);

  const i = (py * raw.width + px) * 4;

  const r = raw.data[i];
  const g = raw.data[i + 1];
  const b = raw.data[i + 2];

  return (
    0.299 * r +
    0.587 * g +
    0.114 * b
  ) / 255.0;
};

const sampleGrayBilinear = (
  raw: any,
  x: number,
  y: number
) => {
  const cx = clamp(x, 0, raw.width - 1);
  const cy = clamp(y, 0, raw.height - 1);

  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(raw.width - 1, x0 + 1);
  const y1 = Math.min(raw.height - 1, y0 + 1);

  const tx = cx - x0;
  const ty = cy - y0;

  const g00 = grayAtRawPixel(raw, x0, y0);
  const g10 = grayAtRawPixel(raw, x1, y0);
  const g01 = grayAtRawPixel(raw, x0, y1);
  const g11 = grayAtRawPixel(raw, x1, y1);

  const top = g00 * (1 - tx) + g10 * tx;
  const bottom = g01 * (1 - tx) + g11 * tx;

  return top * (1 - ty) + bottom * ty;
};

/**
 * Ultralytics V7 được train trên ảnh grayscale JPEG.
 * Vì vậy camera màu cũng chuyển về grayscale, rồi lặp cùng giá trị vào RGB.
 *
 * Letterbox pad=114 giống pipeline YOLO thông dụng.
 */
const buildYoloLetterboxInput = (
  raw: any
) => {
  const input = new Float32Array(
    DETECTOR_SIZE * DETECTOR_SIZE * 3
  );

  const scale = Math.min(
    DETECTOR_SIZE / raw.width,
    DETECTOR_SIZE / raw.height
  );

  const scaledW = raw.width * scale;
  const scaledH = raw.height * scale;

  const offsetX =
    (DETECTOR_SIZE - scaledW) / 2;

  const offsetY =
    (DETECTOR_SIZE - scaledH) / 2;

  const pad = 114 / 255.0;

  input.fill(pad);

  for (let y = 0; y < DETECTOR_SIZE; y++) {
    const srcYFloat =
      (y + 0.5 - offsetY) / scale - 0.5;

    if (
      srcYFloat < 0 ||
      srcYFloat > raw.height - 1
    ) {
      continue;
    }

    const srcY = clamp(
      Math.round(srcYFloat),
      0,
      raw.height - 1
    );

    for (let x = 0; x < DETECTOR_SIZE; x++) {
      const srcXFloat =
        (x + 0.5 - offsetX) / scale - 0.5;

      if (
        srcXFloat < 0 ||
        srcXFloat > raw.width - 1
      ) {
        continue;
      }

      const srcX = clamp(
        Math.round(srcXFloat),
        0,
        raw.width - 1
      );

      const i =
        (srcY * raw.width + srcX) * 4;

      const r = raw.data[i];
      const g = raw.data[i + 1];
      const b = raw.data[i + 2];

      const gray =
        (
          0.299 * r +
          0.587 * g +
          0.114 * b
        ) / 255.0;

      const out =
        (y * DETECTOR_SIZE + x) * 3;

      input[out] = gray;
      input[out + 1] = gray;
      input[out + 2] = gray;
    }
  }

  const letterbox: LetterboxInfo = {
    scale,
    offsetX,
    offsetY,
    scaledW,
    scaledH,
  };

  return {
    input,
    letterbox,
  };
};

// ============================================================
// YOLO V7 DECODE + NMS
// ============================================================

type Detection = {
  classId: number;
  confidence: number;

  // detector-space pixels 0..640
  cx: number;
  cy: number;
  width: number;
  height: number;

  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type YoloLayout = 'CHANNEL_MAJOR' | 'ROW_MAJOR';

type DecodedLayout = {
  layout: YoloLayout;
  detections: Detection[];
  highConfidenceCount: number;
  maxConfidence: number;
  maxClass0: number;
  maxClass1: number;
  plausibilityScore: number;
};

const boxIou = (
  a: Detection,
  b: Detection
) => {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);

  const inter = iw * ih;

  const areaA =
    Math.max(0, a.x2 - a.x1) *
    Math.max(0, a.y2 - a.y1);

  const areaB =
    Math.max(0, b.x2 - b.x1) *
    Math.max(0, b.y2 - b.y1);

  return inter / (areaA + areaB - inter + 1e-7);
};

const normalizeYoloCoord = (
  value: number,
  normalized: boolean
) =>
  normalized
    ? value * DETECTOR_SIZE
    : value;

/**
 * Ultralytics TFLite nms=False thường trả [1, 4+nc, N].
 * Bản export mới còn có _NormalizeCoords nên xywh có thể ở 0..1.
 *
 * Hàm này hỗ trợ cả:
 *   [1, 6, N]  -> CHANNEL_MAJOR
 *   [1, N, 6]  -> ROW_MAJOR
 * và tự nhận xywh normalized hay pixel.
 */
const decodeYoloLayout = (
  output: Float32Array,
  layout: YoloLayout
): DecodedLayout => {
  if (
    output.length % YOLO_CHANNELS !== 0
  ) {
    throw new Error(
      `YOLO output length ${output.length} không chia hết cho ${YOLO_CHANNELS}.`
    );
  }

  const count =
    output.length / YOLO_CHANNELS;

  const read = (
    index: number,
    channel: number
  ) => {
    if (layout === 'CHANNEL_MAJOR') {
      return output[channel * count + index];
    }

    return output[index * YOLO_CHANNELS + channel];
  };

  // Ultralytics export in your V7 file contains _NormalizeCoords,
  // so xywh is normally 0..1. Keep auto detection for safety.
  let coordAbsMax = 0;

  const probeCount =
    Math.min(count, 64);

  for (let i = 0; i < probeCount; i++) {
    for (let c = 0; c < 4; c++) {
      coordAbsMax =
        Math.max(
          coordAbsMax,
          Math.abs(read(i, c))
        );
    }
  }

  const normalizedCoords =
    coordAbsMax <= 2.5;

  const detections: Detection[] = [];

  let highConfidenceCount = 0;
  let maxConfidence = 0;
  let maxClass0 = 0;
  let maxClass1 = 0;
  let invalidCount = 0;

  for (let i = 0; i < count; i++) {
    const cx = normalizeYoloCoord(
      read(i, 0),
      normalizedCoords
    );

    const cy = normalizeYoloCoord(
      read(i, 1),
      normalizedCoords
    );

    const width = normalizeYoloCoord(
      read(i, 2),
      normalizedCoords
    );

    const height = normalizeYoloCoord(
      read(i, 3),
      normalizedCoords
    );

    const class0 = read(i, 4);
    const class1 = read(i, 5);

    if (
      !Number.isFinite(cx) ||
      !Number.isFinite(cy) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      !Number.isFinite(class0) ||
      !Number.isFinite(class1)
    ) {
      invalidCount++;
      continue;
    }

    maxClass0 =
      Math.max(maxClass0, class0);

    maxClass1 =
      Math.max(maxClass1, class1);

    const bestScore =
      Math.max(class0, class1);

    maxConfidence =
      Math.max(maxConfidence, bestScore);

    if (bestScore >= 0.20) {
      highConfidenceCount++;
    }

    if (
      width <= 0 ||
      height <= 0 ||
      width > DETECTOR_SIZE * 1.6 ||
      height > DETECTOR_SIZE * 1.6 ||
      cx < -DETECTOR_SIZE * 0.5 ||
      cx > DETECTOR_SIZE * 1.5 ||
      cy < -DETECTOR_SIZE * 0.5 ||
      cy > DETECTOR_SIZE * 1.5
    ) {
      invalidCount++;
      continue;
    }

    const x1 = clamp(
      cx - width / 2,
      0,
      DETECTOR_SIZE
    );

    const y1 = clamp(
      cy - height / 2,
      0,
      DETECTOR_SIZE
    );

    const x2 = clamp(
      cx + width / 2,
      0,
      DETECTOR_SIZE
    );

    const y2 = clamp(
      cy + height / 2,
      0,
      DETECTOR_SIZE
    );

    if (
      x2 - x1 < 2 ||
      y2 - y1 < 2
    ) {
      continue;
    }

    // IMPORTANT:
    // Keep BOTH class scores independently.
    // The old code did:
    //   classId = class1 > class0 ? 1 : 0
    // That could throw away a useful receiver_phone candidate merely
    // because receiver_block was slightly stronger at the same anchor.
    if (class0 >= YOLO_RAW_MIN_SCORE) {
      detections.push({
        classId: YOLO_BLOCK_CLASS,
        confidence: class0,
        cx,
        cy,
        width,
        height,
        x1,
        y1,
        x2,
        y2,
      });
    }

    if (class1 >= YOLO_RAW_MIN_SCORE) {
      detections.push({
        classId: YOLO_PHONE_CLASS,
        confidence: class1,
        cx,
        cy,
        width,
        height,
        x1,
        y1,
        x2,
        y2,
      });
    }
  }

  const overPredictionPenalty =
    Math.max(
      0,
      highConfidenceCount - 250
    ) * 0.02;

  // Correct layout should have plausible coordinates plus sensible
  // class probabilities. Class-1 is explicitly included because it
  // is the target we care about.
  const plausibilityScore =
    maxConfidence * 5 +
    maxClass1 * 2 +
    Math.min(highConfidenceCount, 40) * 0.05 -
    overPredictionPenalty -
    invalidCount * 0.001;

  return {
    layout,
    detections,
    highConfidenceCount,
    maxConfidence,
    maxClass0,
    maxClass1,
    plausibilityScore,
  };
};

const decodeYoloOutput = (
  output: Float32Array
) => {
  const channelMajor =
    decodeYoloLayout(
      output,
      'CHANNEL_MAJOR'
    );

  const rowMajor =
    decodeYoloLayout(
      output,
      'ROW_MAJOR'
    );

  const chosen =
    channelMajor.plausibilityScore >=
    rowMajor.plausibilityScore
      ? channelMajor
      : rowMajor;

  console.log(
    'YOLO LAYOUT:',
    `chosen=${chosen.layout}`,
    `channelScore=${channelMajor.plausibilityScore.toFixed(2)}`,
    `rowScore=${rowMajor.plausibilityScore.toFixed(2)}`,
    `high=${chosen.highConfidenceCount}`,
    `maxConf=${chosen.maxConfidence.toFixed(3)}`,
    `maxBlock=${chosen.maxClass0.toFixed(3)}`,
    `maxPhone=${chosen.maxClass1.toFixed(3)}`
  );

  return chosen;
};

const nms = (
  detections: Detection[],
  iouThreshold: number
) => {
  const result: Detection[] = [];

  for (const classId of [
    YOLO_BLOCK_CLASS,
    YOLO_PHONE_CLASS,
  ]) {
    const threshold =
      classId === YOLO_PHONE_CLASS
        ? YOLO_PHONE_CONF_THRESHOLD
        : YOLO_BLOCK_CONF_THRESHOLD;

    // Cap pre-NMS list so very low confidence raw anchors do not
    // make NMS unnecessarily expensive on the phone.
    const sorted =
      detections
        .filter(
          d =>
            d.classId === classId &&
            d.confidence >= threshold
        )
        .sort(
          (a, b) =>
            b.confidence - a.confidence
        )
        .slice(0, 250);

    while (sorted.length > 0) {
      const best = sorted.shift()!;
      result.push(best);

      for (
        let i = sorted.length - 1;
        i >= 0;
        i--
      ) {
        if (
          boxIou(best, sorted[i]) >=
          iouThreshold
        ) {
          sorted.splice(i, 1);
        }
      }
    }
  }

  return result;
};

const pointInsideBox = (
  x: number,
  y: number,
  box: Detection
) =>
  x >= box.x1 &&
  x <= box.x2 &&
  y >= box.y1 &&
  y <= box.y2;

type PhoneCandidate = {
  phone: Detection;
  rank: number;
  supportingBlock: Detection | null;
  source: 'V7_PHONE' | 'BLOCK_STRIP';
};

const chooseReceiverPhoneCandidates = (
  detections: Detection[]
): PhoneCandidate[] => {
  const blocks =
    detections.filter(
      d =>
        d.classId === YOLO_BLOCK_CLASS
    );

  const phones =
    detections.filter(
      d =>
        d.classId === YOLO_PHONE_CLASS
    );

  const ranked:
    PhoneCandidate[] = [];

  for (const phone of phones) {
    let supportingBlock:
      | Detection
      | null = null;

    for (const block of blocks) {
      if (
        pointInsideBox(
          phone.cx,
          phone.cy,
          block
        )
      ) {
        if (
          !supportingBlock ||
          block.confidence >
            supportingBlock.confidence
        ) {
          supportingBlock = block;
        }
      }
    }

    const aspect =
      phone.width /
      Math.max(1, phone.height);

    // Soft preference only. Do not delete candidates.
    // Real camera geometry can make the predicted bbox less horizontal.
    const aspectBonus =
      aspect >= 1.2 &&
      aspect <= 30
        ? 0.03
        : 0;

    const blockBonus =
      supportingBlock
        ? 0.06 *
          supportingBlock.confidence
        : 0;

    ranked.push({
      phone,
      supportingBlock,
      source: 'V7_PHONE',
      rank:
        phone.confidence +
        aspectBonus +
        blockBonus,
    });
  }

  return ranked
    .sort(
      (a, b) =>
        b.rank - a.rank
    )
    .slice(
      0,
      YOLO_MAX_PHONE_CANDIDATES
    );
};

const detectorBoxToRawBox = (
  box: Detection,
  letterbox: LetterboxInfo,
  rawWidth: number,
  rawHeight: number
): RawBox => {
  const x1 =
    (box.x1 - letterbox.offsetX) /
    letterbox.scale;

  const y1 =
    (box.y1 - letterbox.offsetY) /
    letterbox.scale;

  const x2 =
    (box.x2 - letterbox.offsetX) /
    letterbox.scale;

  const y2 =
    (box.y2 - letterbox.offsetY) /
    letterbox.scale;

  return {
    x1: clamp(x1, 0, rawWidth - 1),
    y1: clamp(y1, 0, rawHeight - 1),
    x2: clamp(x2, 1, rawWidth),
    y2: clamp(y2, 1, rawHeight),
  };
};

// ============================================================
// OCR CROP + CTC DECODE
// ============================================================

const buildOcrInputFromBox = (
  raw: any,
  box: RawBox
) => {
  const boxW =
    Math.max(
      1,
      box.x2 - box.x1
    );

  const boxH =
    Math.max(
      1,
      box.y2 - box.y1
    );

  // Giống notebook V7 real-photo helper:
  // ngang +10%, dọc +35% để OCR không mất prefix / đầu cuối chữ số.
  const padX = boxW * 0.10;
  const padY = boxH * 0.35;

  const x1 = clamp(
    box.x1 - padX,
    0,
    raw.width - 1
  );

  const y1 = clamp(
    box.y1 - padY,
    0,
    raw.height - 1
  );

  const x2 = clamp(
    box.x2 + padX,
    1,
    raw.width
  );

  const y2 = clamp(
    box.y2 + padY,
    1,
    raw.height
  );

  const ocrInput =
    new Float32Array(
      OCR_W * OCR_H
    );

  for (let y = 0; y < OCR_H; y++) {
    const sy =
      y1 +
      ((y + 0.5) / OCR_H) *
      (y2 - y1);

    for (let x = 0; x < OCR_W; x++) {
      const sx =
        x1 +
        ((x + 0.5) / OCR_W) *
        (x2 - x1);

      ocrInput[
        y * OCR_W + x
      ] =
        sampleGrayBilinear(
          raw,
          sx,
          sy
        );
    }
  }

  return {
    ocrInput,
    cropBox: {
      x1,
      y1,
      x2,
      y2,
    } as RawBox,
  };
};

type CtcDecodeResult = {
  rawDigits: string;
  charConfidences: number[];
  averageConfidence: number;
  timesteps: number;
};

const softmaxConfidenceAt = (
  logits: Float32Array,
  offset: number,
  classCount: number,
  bestClass: number,
  bestLogit: number
) => {
  let sum = 0;

  for (
    let c = 0;
    c < classCount;
    c++
  ) {
    sum += Math.exp(
      logits[offset + c] -
      bestLogit
    );
  }

  return 1 / Math.max(sum, 1e-12);
};

const ctcGreedyDecode = (
  logits: Float32Array
): CtcDecodeResult => {
  if (
    logits.length % OCR_CLASSES !== 0
  ) {
    throw new Error(
      `OCR output length ${logits.length} không chia hết cho ${OCR_CLASSES}.`
    );
  }

  const timesteps =
    logits.length / OCR_CLASSES;

  let previousClass = -1;
  let rawDigits = '';

  const charConfidences: number[] = [];

  for (
    let t = 0;
    t < timesteps;
    t++
  ) {
    const offset =
      t * OCR_CLASSES;

    let bestClass = 0;
    let bestLogit =
      logits[offset];

    for (
      let c = 1;
      c < OCR_CLASSES;
      c++
    ) {
      const value =
        logits[offset + c];

      if (value > bestLogit) {
        bestLogit = value;
        bestClass = c;
      }
    }

    // CTC:
    // - blank bỏ qua
    // - repeated liên tiếp gộp
    // - nếu có blank ở giữa thì digit giống nhau vẫn được emit lại.
    if (
      bestClass !== OCR_BLANK &&
      bestClass !== previousClass &&
      bestClass >= 0 &&
      bestClass <= 9
    ) {
      rawDigits +=
        String(bestClass);

      charConfidences.push(
        softmaxConfidenceAt(
          logits,
          offset,
          OCR_CLASSES,
          bestClass,
          bestLogit
        )
      );
    }

    previousClass =
      bestClass;
  }

  const averageConfidence =
    charConfidences.length > 0
      ? charConfidences.reduce(
          (sum, value) =>
            sum + value,
          0
        ) /
        charConfidences.length
      : 0;

  return {
    rawDigits,
    charConfidences,
    averageConfidence,
    timesteps,
  };
};

const normalizeVnPhone = (
  raw: string
) => {
  const digits =
    raw.replace(/\D/g, '');

  // 0xxxxxxxxx
  if (
    digits.length === 10 &&
    digits.startsWith('0')
  ) {
    return digits;
  }

  // 84xxxxxxxxx hoặc +84xxxxxxxxx
  // OCR chỉ có digit nên dấu + không xuất hiện.
  if (
    digits.length === 11 &&
    digits.startsWith('84')
  ) {
    return `0${digits.slice(2)}`;
  }

  return null;
};

const isVietnamMobile = (
  phone: string
) =>
  /^0[35789]\d{8}$/.test(phone);

// ============================================================
// SCREEN
// ============================================================

export const ShipperScreen = ({
  navigation,
}: any) => {
  const {
    currentUser,
    currentToken,
    logoutToHome,
  } = useAuth();

  // ==========================================================
  // CAMERA
  // ==========================================================

  const isFocused = useIsFocused();

  const {
    hasPermission,
    requestPermission,
  } =
    useCameraPermission();

  const device =
    useCameraDevice('back');

  const photoOutput =
    usePhotoOutput({
      qualityPrioritization:
        'quality',
    });

  // ==========================================================
  // STATE
  // ==========================================================

  const [
    isCameraReady,
    setIsCameraReady,
  ] = useState(false);

  const [
    detectorModel,
    setDetectorModel,
  ] = useState<any>(null);

  const [
    ocrModel,
    setOcrModel,
  ] = useState<any>(null);

  const [
    isModelLoading,
    setIsModelLoading,
  ] = useState(true);

  const [
    modelError,
    setModelError,
  ] = useState('');

  const [
    phoneNumber,
    setPhoneNumber,
  ] = useState('');

  const [
    isScanning,
    setIsScanning,
  ] = useState(false);

  const [
    captureLocked,
    setCaptureLocked,
  ] = useState(false);

  const [
    isCreatingOrder,
    setIsCreatingOrder,
  ] = useState(false);

  const [
    debugCropUri,
    setDebugCropUri,
  ] = useState('');

  const [
    debugInfo,
    setDebugInfo,
  ] = useState('');

  // ==========================================================
  // 1. CAMERA PERMISSION
  // ==========================================================

  useEffect(() => {
    if (
    !currentUser ||
    currentUser.role !== 'SHIPPER'
  ) {
    return (
      <View style={styles.authRequired}>
        <Text style={styles.authRequiredIcon}>🔒</Text>
        <Text style={styles.authRequiredTitle}>
          Chưa đăng nhập Shipper
        </Text>
        <Text style={styles.authRequiredText}>
          Vui lòng đăng nhập bằng tài khoản Shipper để sử dụng camera AI và tạo đơn giao hàng.
        </Text>

        <TouchableOpacity
          style={styles.backHomeButton}
          onPress={() =>
            navigation.reset({
              index: 0,
              routes: [{ name: 'Home' }],
            })
          }
        >
          <Text style={styles.backHomeButtonText}>
            VỀ TRANG CHỦ
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!hasPermission) {
      requestPermission();
    }
  }, [
    hasPermission,
    requestPermission,
  ]);

  // ==========================================================
  // 2. LOAD V7 + V5.2
  // ==========================================================

  useEffect(() => {
    let mounted = true;

    const initAI = async () => {
      try {
        console.log(
          '===================================='
        );

        console.log(
          'AI: Đang nạp V7 YOLO + OCR V5.2 CTC...'
        );

        console.log(
          '===================================='
        );

        setIsModelLoading(true);
        setModelError('');

        const detectorAsset =
          require(
            '../../assets/phone_detector_receiver_v7_yolo_float32.tflite'
          );

        const ocrAsset =
          require(
            '../../assets/phone_ocr_v52_crnn_unrolled_float32.tflite'
          );

        const detector =
          await loadTensorflowModel(
            detectorAsset,
            []
          );

        const ocr =
          await loadTensorflowModel(
            ocrAsset,
            []
          );

        if (!detector) {
          throw new Error(
            'Không thể nạp phone_detector_receiver_v7_yolo_float32.tflite'
          );
        }

        if (!ocr) {
          throw new Error(
            'Không thể nạp phone_ocr_v52_crnn_unrolled_float32.tflite'
          );
        }

        if (mounted) {
          setDetectorModel(detector);
          setOcrModel(ocr);

          console.log(
            '✅ MODEL 1 V7 YOLO: sẵn sàng.'
          );

          console.log(
            '✅ MODEL 2 V5.2 CRNN/CTC: sẵn sàng.'
          );
        }
      } catch (error: any) {
        console.error(
          '❌ AI LOAD ERROR:',
          error
        );

        const message =
          error?.message ||
          String(error);

        if (mounted) {
          setDetectorModel(null);
          setOcrModel(null);
          setModelError(message);
        }

        Alert.alert(
          'Lỗi nạp Model AI',
          message
        );
      } finally {
        if (mounted) {
          setIsModelLoading(false);
        }
      }
    };

    initAI();

    return () => {
      mounted = false;
    };
  }, []);

  // ==========================================================
  // 3. CAMERA -> V7 -> CROP HIGH-RES -> V5.2 CTC
  // ==========================================================

  const handleScanAI = async () => {
    if (!isCameraReady) {
      Alert.alert(
        'Camera chưa sẵn sàng',
        'Vui lòng chờ Camera khởi động.'
      );
      return;
    }

    if (
      !detectorModel ||
      !ocrModel
    ) {
      Alert.alert(
        'AI chưa sẵn sàng',
        modelError
          ? `Model AI lỗi:\n${modelError}`
          : 'Hai model AI đang được nạp.'
      );
      return;
    }

    if (isScanning) {
      return;
    }

    setIsScanning(true);
    setCaptureLocked(false);
    setDebugCropUri('');
    setDebugInfo('');

    try {
      // ======================================================
      // A. CHỤP
      // ======================================================

      console.log(
        '------------------------------------'
      );

      console.log(
        '📷 CAMERA: Chụp bill...'
      );

      const result =
        await photoOutput.capturePhotoToFile(
          {
            flashMode: 'off',
          },
          {}
        );

      if (!result?.filePath) {
        throw new Error(
          'Camera không trả về filePath.'
        );
      }

      const photoPath =
        result.filePath.startsWith(
          'file://'
        )
          ? result.filePath
          : `file://${result.filePath}`;

      console.log(
        '✅ CAMERA FILE:',
        photoPath
      );

      console.log(
        '✅ PHOTO LOCKED: có thể lấy bill ra khỏi camera.'
      );

      setCaptureLocked(true);

      // ======================================================
      // B. ẢNH LÀM VIỆC HIGH-RES
      // ======================================================

      const resizer =
        getResizer();

      console.log(
        `🖼️ IMAGE: giữ tỉ lệ trong ${WORK_MAX_W}x${WORK_MAX_H}`
      );

      const workImage =
        await resizer(
          photoPath,
          WORK_MAX_W,
          WORK_MAX_H,
          'JPEG',
          95,
          0,
          undefined,
          false,
          {
            mode: 'contain',
            onlyScaleDown: false,
          }
        );

      if (!workImage) {
        throw new Error(
          'Không tạo được ảnh làm việc.'
        );
      }

      const workPath =
        normalizePath(
          workImage.path ||
            workImage.uri ||
            ''
        );

      if (!workPath) {
        throw new Error(
          'Không lấy được path ảnh làm việc.'
        );
      }

      const raw =
        await decodeJpegFile(
          workPath
        );

      console.log(
        `✅ WORK IMAGE: ${raw.width}x${raw.height}`
      );

      // ======================================================
      // C. MODEL 1 V7 — ONE PASS YOLO
      // ======================================================

      console.log(
        '🚀 MODEL 1 V7: receiver_phone detection...'
      );

      const {
        input: detectorInput,
        letterbox,
      } =
        buildYoloLetterboxInput(
          raw
        );

      const detectorOutputs =
        await detectorModel.run([
          detectorInput.buffer as ArrayBuffer,
        ]);

      if (
        !detectorOutputs ||
        detectorOutputs.length === 0
      ) {
        throw new Error(
          'Model 1 V7 không trả về output.'
        );
      }

      const yoloOutput =
        new Float32Array(
          detectorOutputs[0]
        );

      console.log(
        'MODEL 1 V7 OUTPUT LENGTH:',
        yoloOutput.length
      );

      if (
        yoloOutput.length %
          YOLO_CHANNELS !==
        0
      ) {
        throw new Error(
          `Output YOLO không đúng cấu trúc 6 channel. ` +
          `Length=${yoloOutput.length}.`
        );
      }

      const decoded =
        decodeYoloOutput(
          yoloOutput
        );

      const afterNms =
        nms(
          decoded.detections,
          YOLO_NMS_IOU
        );

      console.log(
        'YOLO AFTER NMS:',
        afterNms.map(
          d =>
            `cls=${d.classId},conf=${d.confidence.toFixed(3)},` +
            `x=${d.cx.toFixed(1)},y=${d.cy.toFixed(1)},` +
            `w=${d.width.toFixed(1)},h=${d.height.toFixed(1)}`
        )
      );

      let candidates =
        chooseReceiverPhoneCandidates(
          afterNms
        );

      // ======================================================
      // REAL-CAMERA FALLBACK
      //
      // Log thực tế cho thấy receiver_block đã được V7 nhận ra
      // (0.23~0.35) nhưng receiver_phone chỉ ~0.02.
      //
      // Khi phone head yếu, tận dụng class receiver_block:
      // quét vài dải ngang ở nửa dưới block người nhận rồi để
      // Model 2 V5.2 xác minh xem dải nào thực sự là số VN.
      //
      // Đây KHÔNG phải OCR cả bill; chỉ là fallback trong block
      // mà V7 đã nhận là vùng người nhận.
      // ======================================================

      if (
        decoded.maxClass1 < 0.05 ||
        candidates.length < 3
      ) {
        const receiverBlocks =
          afterNms
            .filter(
              d =>
                d.classId ===
                YOLO_BLOCK_CLASS
            )
            .sort(
              (a, b) =>
                b.confidence -
                a.confidence
            )
            .slice(0, 2);

        const verticalFractions = [
          0.56,
          0.68,
          0.80,
        ];

        for (
          const block of
            receiverBlocks
        ) {
          for (
            const fraction of
              verticalFractions
          ) {
            const stripWidth =
              block.width * 0.96;

            const stripHeight =
              Math.max(
                10,
                block.height * 0.18
              );

            const cx =
              block.cx;

            const cy =
              block.y1 +
              block.height *
                fraction;

            const x1 = clamp(
              cx - stripWidth / 2,
              0,
              DETECTOR_SIZE
            );

            const y1 = clamp(
              cy - stripHeight / 2,
              0,
              DETECTOR_SIZE
            );

            const x2 = clamp(
              cx + stripWidth / 2,
              0,
              DETECTOR_SIZE
            );

            const y2 = clamp(
              cy + stripHeight / 2,
              0,
              DETECTOR_SIZE
            );

            const syntheticPhone:
              Detection = {
              classId:
                YOLO_PHONE_CLASS,

              // Chỉ dùng để ranking/debug.
              // OCR verifier mới quyết định cuối.
              confidence:
                Math.max(
                  0.006,
                  block.confidence *
                    0.12
                ),

              cx,
              cy,
              width:
                x2 - x1,
              height:
                y2 - y1,
              x1,
              y1,
              x2,
              y2,
            };

            candidates.push({
              phone:
                syntheticPhone,
              supportingBlock:
                block,
              source:
                'BLOCK_STRIP',
              rank:
                0.04 +
                block.confidence *
                  0.18,
            });
          }
        }
      }

      candidates =
        candidates
          .sort(
            (a, b) =>
              b.rank - a.rank
          )
          .slice(
            0,
            YOLO_MAX_PHONE_CANDIDATES
          );

      console.log(
        'V7 PHONE CANDIDATES:',
        candidates.map(
          (c, i) =>
            `#${i + 1}:${c.source},` +
            `phone=${c.phone.confidence.toFixed(3)},` +
            `rank=${c.rank.toFixed(3)},` +
            `aspect=${(c.phone.width / Math.max(1, c.phone.height)).toFixed(2)},` +
            `block=${c.supportingBlock ? c.supportingBlock.confidence.toFixed(3) : 'none'}`
        )
      );

      if (candidates.length === 0) {
        throw new Error(
          `V7 không tạo được candidate. ` +
          `maxPhone=${decoded.maxClass1.toFixed(3)}, ` +
          `maxBlock=${decoded.maxClass0.toFixed(3)}.`
        );
      }

      // ======================================================
      // D + E. THỬ TỐI ĐA 6 PHONE CANDIDATE
      //
      // V7 chỉ đề xuất vùng. Model 2 V5.2 sẽ đóng vai trò verifier:
      // candidate nào OCR ra số di động VN hợp lệ sẽ được ưu tiên.
      // ======================================================

      type CandidateOcrResult = {
        candidate: PhoneCandidate;
        rawPhoneBox: RawBox;
        cropBox: RawBox;
        cropUri: string;
        ctc: CtcDecodeResult;
        normalizedPhone: string | null;
        valid: boolean;
        combinedScore: number;
      };

      const candidateResults:
        CandidateOcrResult[] = [];

      for (
        let candidateIndex = 0;
        candidateIndex <
          candidates.length;
        candidateIndex++
      ) {
        const candidate =
          candidates[candidateIndex];

        const rawPhoneBox =
          detectorBoxToRawBox(
            candidate.phone,
            letterbox,
            raw.width,
            raw.height
          );

        const {
          ocrInput,
          cropBox,
        } =
          buildOcrInputFromBox(
            raw,
            rawPhoneBox
          );

        const ocrOutputs =
          await ocrModel.run([
            ocrInput.buffer as ArrayBuffer,
          ]);

        if (
          !ocrOutputs ||
          ocrOutputs.length === 0
        ) {
          continue;
        }

        const logits =
          new Float32Array(
            ocrOutputs[0]
          );

        const ctc =
          ctcGreedyDecode(
            logits
          );

        const normalizedPhone =
          normalizeVnPhone(
            ctc.rawDigits
          );

        const valid =
          normalizedPhone
            ? isVietnamMobile(
                normalizedPhone
              )
            : false;

        const combinedScore =
          candidate.rank * 0.55 +
          ctc.averageConfidence * 0.35 +
          (valid ? 0.25 : 0);

        const cropUri =
          await saveGrayDebugJpeg(
            ocrInput,
            OCR_W,
            OCR_H
          );

        candidateResults.push({
          candidate,
          rawPhoneBox,
          cropBox,
          cropUri,
          ctc,
          normalizedPhone,
          valid,
          combinedScore,
        });

        console.log(
          `V7→OCR CANDIDATE #${candidateIndex + 1}:`,
          `source=${candidate.source},`,
          `phoneConf=${candidate.phone.confidence.toFixed(3)},`,
          `raw=${ctc.rawDigits || '(empty)'},`,
          `normalized=${normalizedPhone || 'null'},`,
          `ocrConf=${ctc.averageConfidence.toFixed(3)},`,
          `valid=${valid},`,
          `score=${combinedScore.toFixed(3)}`
        );
      }

      if (
        candidateResults.length === 0
      ) {
        throw new Error(
          'V7 có candidate nhưng Model 2 không chạy được candidate nào.'
        );
      }

      // Prefer valid Vietnamese mobile number.
      const validResults =
        candidateResults
          .filter(r => r.valid)
          .sort(
            (a, b) =>
              b.combinedScore -
              a.combinedScore
          );

      const selectedResult =
        validResults[0] ??
        candidateResults
          .sort(
            (a, b) =>
              b.combinedScore -
              a.combinedScore
          )[0];

      const phoneDetection =
        selectedResult.candidate.phone;

      const ctc =
        selectedResult.ctc;

      const normalizedPhone =
        selectedResult.normalizedPhone;

      setDebugCropUri(
        selectedResult.cropUri
      );

      setDebugInfo(
        `source=${selectedResult.candidate.source}, ` +
        `V7 phone conf=${(
          phoneDetection.confidence *
          100
        ).toFixed(1)}%, ` +
        `maxPhone=${(
          decoded.maxClass1 *
          100
        ).toFixed(1)}%, ` +
        `layout=${decoded.layout}, ` +
        `blockSupport=${selectedResult.candidate.supportingBlock ? 'yes' : 'no'}, ` +
        `crop=${Math.round(selectedResult.cropBox.x2 - selectedResult.cropBox.x1)}x` +
        `${Math.round(selectedResult.cropBox.y2 - selectedResult.cropBox.y1)}`
      );

      console.log(
        '✅ V7 SELECTED RECEIVER_PHONE:',
        `source=${selectedResult.candidate.source},`,
        `conf=${phoneDetection.confidence.toFixed(3)},`,
        `maxPhone=${decoded.maxClass1.toFixed(3)},`,
        `raw=${ctc.rawDigits},`,
        `normalized=${normalizedPhone},`,
        `valid=${selectedResult.valid}`
      );

      if (
        ctc.timesteps !==
        OCR_EXPECTED_TIMESTEPS
      ) {
        console.warn(
          `⚠️ OCR timestep=${ctc.timesteps}, ` +
          `not expected ${OCR_EXPECTED_TIMESTEPS}.`
        );
      }

      const displayedPhone =
        normalizedPhone ??
        ctc.rawDigits
          .replace(/\D/g, '')
          .slice(0, 10);

      setPhoneNumber(
        displayedPhone
      );

      console.log(
        '===================================='
      );

      console.log(
        '🎯 OCR RAW:',
        ctc.rawDigits
      );

      console.log(
        '🎯 OCR NORMALIZED:',
        normalizedPhone
      );

      console.log(
        '🎯 CHAR CONF:',
        ctc.charConfidences
      );

      console.log(
        '🎯 AVG OCR CONF:',
        ctc.averageConfidence
      );

      console.log(
        '===================================='
      );

      // ======================================================
      // F. VALIDATE
      // ======================================================

      const valid =
        normalizedPhone
          ? isVietnamMobile(
              normalizedPhone
            )
          : false;

      if (!valid) {
        Alert.alert(
          '⚠️ AI đã đọc nhưng cần kiểm tra',
          `V7 detector: ${(phoneDetection.confidence * 100).toFixed(1)}%\n` +
          `OCR raw: ${ctc.rawDigits || '(rỗng)'}\n` +
          `OCR confidence TB: ${(ctc.averageConfidence * 100).toFixed(1)}%\n\n` +
          'Kết quả chưa khớp định dạng số di động Việt Nam. ' +
          'Bạn có thể sửa tay trong ô bên dưới.'
        );
      } else {
        Alert.alert(
          '🤖 AI nhận diện thành công',
          `Số điện thoại: ${normalizedPhone}\n` +
          `V7 detector: ${(phoneDetection.confidence * 100).toFixed(1)}%\n` +
          `OCR confidence TB: ${(ctc.averageConfidence * 100).toFixed(1)}%`
        );
      }
    } catch (error: any) {
      console.error(
        '❌ FINAL AI ERROR:',
        error
      );

      Alert.alert(
        '🚨 Lỗi hệ thống',
        error?.message ||
          String(error)
      );
    } finally {
      setIsScanning(false);
      setCaptureLocked(false);
    }
  };

  // ==========================================================
  // 4. BACKEND: TẠO ĐƠN + FIREBASE PUSH
  //
  // Shipper BẮT BUỘC đăng nhập.
  // App gửi JWT + SĐT người nhận lên backend.
  // Backend sẽ:
  //   1) tìm tài khoản RESIDENT theo SĐT,
  //   2) tự tìm tủ trống phù hợp size,
  //   3) tạo package + OTP một lần,
  //   4) tìm FCM token của cư dân,
  //   5) gửi notification tự động.
  // ==========================================================

  const handleDeposit = async () => {
    if (
      !currentUser ||
      currentUser.role !== 'SHIPPER' ||
      !currentToken
    ) {
      Alert.alert(
        'Chưa đăng nhập Shipper',
        'Vui lòng đăng nhập bằng tài khoản Shipper để tạo đơn.',
      );
      return;
    }

    if (!phoneNumber) {
      Alert.alert(
        'Lỗi',
        'Chưa có SĐT!'
      );
      return;
    }

    if (!/^0\d{9}$/.test(phoneNumber)) {
      Alert.alert(
        'Kiểm tra SĐT',
        'Số điện thoại phải gồm 10 chữ số và bắt đầu bằng 0.'
      );
      return;
    }

    setIsCreatingOrder(true);

    try {
      console.log(
        '📦 CREATE PACKAGE REQUEST:',
        phoneNumber
      );

      const response = await fetch(
        `${API_BASE_URL}/packages`,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
            Authorization:
              `Bearer ${currentToken}`,
          },
          body: JSON.stringify({
            receiverPhone:
              phoneNumber,
            size: 'M',
            sender:
              `Shipper ${currentUser.phone}`,
          }),
        }
      );

      let data: any = null;

      try {
        data =
          await response.json();
      } catch {
        // Backend trả body không phải JSON.
      }

      if (
        !response.ok ||
        !data?.ok
      ) {
        throw new Error(
          data?.message ||
            `Không tạo được đơn (HTTP ${response.status}).`
        );
      }

      console.log(
        '✅ BACKEND PACKAGE CREATED:',
        data.package
      );

      console.log(
        '🔔 PUSH RESULT:',
        data.notification
      );

      const sentCount =
        Number(
          data.notification
            ?.successCount || 0
        );

      const noDevice =
        !!data.notification
          ?.noDevice;

      if (noDevice) {
        Alert.alert(
          '⚠️ Đã tạo đơn',
          `Đã tạo kiện hàng cho ${phoneNumber} tại tủ ${data.package?.locker || 'tủ được backend cấp'}.\n\n` +
          'Tài khoản cư dân này chưa có thiết bị nhận thông báo Firebase được liên kết.'
        );
      } else if (
        sentCount > 0
      ) {
        Alert.alert(
          '✅ Gửi hàng thành công',
          `Đã tạo đơn cho ${phoneNumber} tại tủ ${data.package?.locker || 'tủ được backend cấp'}.\n\n` +
          `🔔 Đã gửi thông báo tới ${sentCount} thiết bị của người nhận.`
        );
      } else {
        Alert.alert(
          '⚠️ Đã tạo đơn',
          `Đơn đã được lưu cho ${phoneNumber}, nhưng Firebase chưa gửi được thông báo.\n\n` +
          `${data.notification?.message || 'Kiểm tra Firebase Admin ở backend.'}`
        );
      }

      // Xóa SĐT sau khi tạo đơn thành công để tránh bấm gửi hai lần.
      setPhoneNumber('');
    } catch (error: any) {
      console.error(
        '❌ CREATE PACKAGE ERROR:',
        error
      );

      Alert.alert(
        'Không tạo được đơn',
        error?.message ||
          'Không kết nối được SmartLocker Backend.'
      );
    } finally {
      setIsCreatingOrder(false);
    }
  };

  const handleLogout = () => {
    logoutToHome();

    navigation.reset({
      index: 0,
      routes: [{ name: 'Home' }],
    });
  };

  // ==========================================================
  // CAMERA PERMISSION / DEVICE
  // ==========================================================

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator
          size="large"
          color="#FF6B00"
        />

        <Text style={styles.statusText}>
          Đang xin quyền Camera...
        </Text>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <ActivityIndicator
          size="large"
          color="#FF6B00"
        />

        <Text style={styles.statusText}>
          Đang tìm Camera sau...
        </Text>
      </View>
    );
  }

  // ==========================================================
  // UI
  // ==========================================================

  const aiReady =
    !!detectorModel &&
    !!ocrModel;

  return (
    <ScrollView
      contentContainerStyle={
        styles.container
      }
    >
      <Text style={styles.title}>
        📦 Giao Hàng Shipper
      </Text>

      <View style={styles.shipperAccountCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.shipperAccountLabel}>
            🚚 SHIPPER ĐÃ XÁC THỰC
          </Text>
          <Text style={styles.shipperAccountPhone}>
            {currentUser.phone}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.shipperLogoutButton}
          onPress={handleLogout}
        >
          <Text style={styles.shipperLogoutText}>
            Đăng xuất
          </Text>
        </TouchableOpacity>
      </View>

      <View
        style={
          styles.softwareModeCard
        }
      >
        <Text
          style={
            styles.softwareModeTitle
          }
        >
          🔔 BACKEND + FIREBASE MODE
        </Text>

        <Text
          style={
            styles.softwareModeText
          }
        >
          Chỉ Shipper đã đăng nhập mới được tạo đơn. Backend xác thực tài khoản, tự chọn tủ rồi gửi Firebase cho cư dân.
        </Text>
      </View>

      {/* AI STATUS */}

      <View
        style={styles.aiStatus}
      >
        {isModelLoading ? (
          <>
            <ActivityIndicator
              size="small"
              color="#FF6B00"
            />

            <Text
              style={
                styles.aiStatusText
              }
            >
              Đang nạp V7 + OCR V5.2...
            </Text>
          </>
        ) : aiReady ? (
          <Text
            style={
              styles.aiReadyText
            }
          >
            ✅ AI sẵn sàng - V7 YOLO + OCR V5.2 CTC
          </Text>
        ) : (
          <Text
            style={
              styles.aiErrorText
            }
          >
            ❌ AI chưa sẵn sàng
          </Text>
        )}
      </View>

      {/* CAMERA */}

      <View
        style={styles.cameraBox}
      >
        <Camera
          style={
            StyleSheet.absoluteFill
          }
          device={device}
          isActive={isFocused}
          outputs={[photoOutput]}
          onConfigured={() => {
            console.log(
              '✅ CAMERA READY'
            );
            setIsCameraReady(true);
          }}
          onError={error => {
            console.error(
              '❌ CAMERA ERROR:',
              error
            );
            setIsCameraReady(false);
          }}
        />

        <View
          pointerEvents="none"
          style={
            styles.overlayFrame
          }
        >
          <Text
            style={
              styles.overlayText
            }
          >
            Có SĐT người nhận trong ảnh là được
          </Text>
        </View>

        {isScanning && (
          <View
            pointerEvents="none"
            style={
              styles.captureHint
            }
          >
            <Text
              style={
                styles.captureHintText
              }
            >
              {captureLocked
                ? '✅ Đã chụp - có thể lấy bill ra'
                : '📷 Giữ yên tới khi hiện ĐÃ CHỤP'}
            </Text>
          </View>
        )}

        {!isCameraReady && (
          <View
            style={
              styles.cameraLoading
            }
          >
            <ActivityIndicator
              color="#FFFFFF"
            />

            <Text
              style={
                styles.cameraLoadingText
              }
            >
              Đang khởi động Camera...
            </Text>
          </View>
        )}
      </View>

      {/* SCAN */}

      <TouchableOpacity
        style={[
          styles.btnScan,
          (
            isScanning ||
            !isCameraReady ||
            !aiReady
          ) &&
            styles.btnDisabled,
        ]}
        onPress={handleScanAI}
        disabled={
          isScanning ||
          !isCameraReady ||
          !aiReady
        }
      >
        {isScanning ? (
          <ActivityIndicator
            color="#FFFFFF"
          />
        ) : (
          <Text
            style={
              styles.btnScanText
            }
          >
            📷 Chụp bill & Tự tìm SĐT AI
          </Text>
        )}
      </TouchableOpacity>

      {/* DEBUG CROP */}

      {!!debugCropUri && (
        <View
          style={styles.debugBox}
        >
          <Text
            style={
              styles.debugTitle
            }
          >
            Debug crop V7 → Model 2 V5.2
          </Text>

          <Image
            source={{
              uri: debugCropUri,
            }}
            style={
              styles.debugImage
            }
            resizeMode="contain"
          />

          {!!debugInfo && (
            <Text
              style={
                styles.debugText
              }
            >
              {debugInfo}
            </Text>
          )}
        </View>
      )}

      {/* RESULT */}

      <View
        style={styles.formGroup}
      >
        <Text
          style={styles.label}
        >
          Số điện thoại nhận diện:
        </Text>

        <TextInput
          style={styles.input}
          value={phoneNumber}
          onChangeText={text =>
            setPhoneNumber(
              text
                .replace(/\D/g, '')
                .slice(0, 10)
            )
          }
          placeholder="Số hiện ở đây..."
          keyboardType="phone-pad"
          maxLength={10}
        />

        <TouchableOpacity
          onPress={() =>
            setPhoneNumber('')
          }
          style={
            styles.clearButton
          }
        >
          <Text
            style={
              styles.clearText
            }
          >
            Xóa tất cả
          </Text>
        </TouchableOpacity>
      </View>

      {/* SUBMIT */}

      <TouchableOpacity
        style={[
          styles.btnSubmit,
          isCreatingOrder &&
            styles.btnDisabled,
        ]}
        onPress={handleDeposit}
        disabled={
          isCreatingOrder
        }
      >
        {isCreatingOrder ? (
          <ActivityIndicator
            color="#FFFFFF"
          />
        ) : (
          <Text
            style={
              styles.btnSubmitText
            }
          >
            📲 XÁC NHẬN GỬI HÀNG
          </Text>
        )}
      </TouchableOpacity>

      <Text
        style={styles.zaloHint}
      >
        AI chỉ đọc SĐT người nhận. Bạn vẫn có thể sửa tay trước khi xác nhận. Backend sẽ tự cấp tủ trống; OTP được tự điền ở tài khoản Cư dân.
      </Text>
    </ScrollView>
  );
};

// ============================================================
// STYLE
// ============================================================

const styles =
  StyleSheet.create({
    authRequired: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 28,
      backgroundColor: '#F8F9FA',
    },

    authRequiredIcon: {
      fontSize: 48,
      marginBottom: 12,
    },

    authRequiredTitle: {
      fontSize: 21,
      fontWeight: '900',
      color: '#212529',
      marginBottom: 8,
    },

    authRequiredText: {
      textAlign: 'center',
      color: '#6C757D',
      lineHeight: 20,
      marginBottom: 20,
    },

    backHomeButton: {
      backgroundColor: '#FF6B00',
      paddingHorizontal: 24,
      paddingVertical: 13,
      borderRadius: 10,
    },

    backHomeButtonText: {
      color: '#FFFFFF',
      fontWeight: '900',
    },

    shipperAccountCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#FFF8EC',
      borderWidth: 1,
      borderColor: '#FFD79A',
      borderRadius: 12,
      padding: 12,
      marginBottom: 12,
    },

    shipperAccountLabel: {
      color: '#9A5B13',
      fontSize: 11,
      fontWeight: '900',
    },

    shipperAccountPhone: {
      marginTop: 3,
      color: '#212529',
      fontSize: 16,
      fontWeight: '900',
    },

    shipperLogoutButton: {
      backgroundColor: '#DC3545',
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 8,
    },

    shipperLogoutText: {
      color: '#FFFFFF',
      fontSize: 12,
      fontWeight: '900',
    },

    container: {
      padding: 20,
      backgroundColor: '#F8F9FA',
      flexGrow: 1,
    },

    center: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },

    statusText: {
      marginTop: 10,
      color: '#343A40',
    },

    title: {
      fontSize: 24,
      fontWeight: 'bold',
      color: '#212529',
      marginBottom: 12,
    },

    softwareModeCard: {
      backgroundColor: '#FFF4E6',
      borderWidth: 1,
      borderColor: '#FFB366',
      borderRadius: 10,
      padding: 12,
      marginBottom: 12,
    },

    softwareModeTitle: {
      color: '#D9480F',
      fontWeight: '800',
      marginBottom: 4,
    },

    softwareModeText: {
      color: '#7C2D12',
      lineHeight: 18,
      fontSize: 13,
    },

    aiStatus: {
      minHeight: 35,
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 10,
    },

    aiStatusText: {
      marginLeft: 8,
      color: '#555555',
      fontWeight: '600',
    },

    aiReadyText: {
      color: '#2B8A3E',
      fontWeight: '700',
    },

    aiErrorText: {
      color: '#D32F2F',
      fontWeight: '700',
    },

    cameraBox: {
      height: 340,
      borderRadius: 12,
      overflow: 'hidden',
      marginBottom: 15,
      position: 'relative',
      backgroundColor: '#000000',
    },

    overlayFrame: {
      position: 'absolute',
      top: '6%',
      left: '8%',
      width: '84%',
      height: '88%',
      borderWidth: 2,
      borderColor: '#FF6B00',
      borderRadius: 8,
      borderStyle: 'dashed',
      justifyContent: 'flex-end',
      alignItems: 'center',
      paddingBottom: 10,
    },

    overlayText: {
      color: '#FFFFFF',
      backgroundColor:
        'rgba(0,0,0,0.55)',
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 6,
      fontWeight: '700',
    },

    cameraLoading: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor:
        'rgba(0,0,0,0.35)',
    },

    cameraLoadingText: {
      color: '#FFFFFF',
      marginTop: 8,
      fontWeight: '600',
    },

    captureHint: {
      position: 'absolute',
      left: 12,
      right: 12,
      top: 12,
      alignItems: 'center',
    },

    captureHintText: {
      color: '#FFFFFF',
      backgroundColor:
        'rgba(0,0,0,0.72)',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      fontWeight: '800',
    },

    btnScan: {
      backgroundColor: '#FF6B00',
      paddingVertical: 14,
      borderRadius: 8,
      alignItems: 'center',
      marginBottom: 20,
    },

    btnScanText: {
      color: '#FFFFFF',
      fontSize: 16,
      fontWeight: 'bold',
    },

    debugBox: {
      backgroundColor: '#FFFFFF',
      borderWidth: 1,
      borderColor: '#CED4DA',
      borderRadius: 8,
      padding: 10,
      marginBottom: 16,
    },

    debugTitle: {
      fontSize: 14,
      fontWeight: '700',
      color: '#343A40',
      marginBottom: 8,
    },

    debugImage: {
      width: '100%',
      height: 90,
      backgroundColor: '#EEEEEE',
      borderRadius: 6,
    },

    debugText: {
      marginTop: 8,
      fontSize: 12,
      color: '#495057',
    },

    formGroup: {
      marginBottom: 16,
    },

    label: {
      fontSize: 15,
      fontWeight: '600',
      color: '#343A40',
      marginBottom: 8,
    },

    input: {
      backgroundColor: '#FFFFFF',
      borderWidth: 1,
      borderColor: '#CED4DA',
      borderRadius: 8,
      paddingHorizontal: 15,
      paddingVertical: 12,
      fontSize: 18,
      color: '#000000',
      fontWeight: 'bold',
    },

    clearButton: {
      marginTop: 5,
      alignSelf: 'flex-end',
    },

    clearText: {
      color: '#007AFF',
      fontWeight: '500',
    },

    btnSubmit: {
      backgroundColor: '#2B8A3E',
      paddingVertical: 16,
      borderRadius: 8,
      alignItems: 'center',
      marginTop: 10,
    },

    btnSubmitText: {
      color: '#FFFFFF',
      fontSize: 16,
      fontWeight: 'bold',
    },

    zaloHint: {
      marginTop: 12,
      textAlign: 'center',
      color: '#6C757D',
      lineHeight: 19,
    },

    btnDisabled: {
      opacity: 0.45,
    },
  });

export default ShipperScreen;
