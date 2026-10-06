import { NativeModules } from 'react-native';

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
  nativeProfile?: string;
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
  dispose: () => Promise<void>;
  scanJpeg: (path: string) => Promise<ReceiverPhoneResult>;
};

type NativeOrientationResult = {
  lines: OcrLine[];
  profile?: {
    sourceWidth?: number;
    sourceHeight?: number;
    boxes?: number;
    decodeMs?: number;
    rotateMs?: number;
    detPrepMs?: number;
    detOnnxMs?: number;
    detPostMs?: number;
    recPrepMs?: number;
    recOnnxMs?: number;
    ctcMs?: number;
    totalMs?: number;
    recBatches?: number;
  };
};

const NativeOcr = NativeModules.SmartLockerOcrNative;

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



const nativeProfileText = (
  degree: number,
  native: NativeOrientationResult,
) => {
  const p = native.profile || {};
  return (
    `NATIVE R${degree}: ` +
    `decode=${p.decodeMs ?? 0}ms, ` +
    `deskew=${Number(p.deskewDeg ?? 0).toFixed(1)}°, ` +
    `deskewMs=${p.deskewMs ?? 0}ms, ` +
    `rotate=${p.rotateMs ?? 0}ms, ` +
    `detPrep=${p.detPrepMs ?? 0}ms, ` +
    `detOnnx=${p.detOnnxMs ?? 0}ms, ` +
    `detPost=${p.detPostMs ?? 0}ms, ` +
    `boxes=${p.boxes ?? native.lines.length}, ` +
    `recBatches=${p.recBatches ?? 0}, ` +
    `recPrep=${p.recPrepMs ?? 0}ms, ` +
    `recOnnx=${p.recOnnxMs ?? 0}ms, ` +
    `ctc=${p.ctcMs ?? 0}ms, ` +
    `total=${p.totalMs ?? 0}ms`
  );
};

const runNativeOrientation = async (
  path: string,
  orientation: 0 | 90 | 180 | 270,
): Promise<RotationPhoneResult> => {
  const native: NativeOrientationResult =
    await NativeOcr.scanOrientation(
      path,
      orientation,
    );

  const lines = (native.lines || [])
    .filter(
      line =>
        String(line.text || '').trim().length > 0 &&
        Number(line.confidence || 0) >= 0.2,
    )
    .sort((a, b) => {
      const ay = (a.y1 + a.y2) / 2;
      const by = (b.y1 + b.y2) / 2;

      if (Math.abs(ay - by) > 14) {
        return ay - by;
      }

      return a.x1 - b.x1;
    });

  const result =
    extractReceiverForRotation(
      lines,
      orientation,
    );

  const profile =
    nativeProfileText(
      orientation,
      native,
    );

  console.log(
    `🎯 NATIVE V4 ${orientation}°:`,
    result.phone ?? 'UNCERTAIN',
    `confidence=${result.confidence}`,
    `score=${
      result.score === null
        ? 'null'
        : result.score.toFixed(2)
    }`,
    `margin=${
      result.margin === null
        ? 'null'
        : result.margin.toFixed(2)
    }`,
  );

  console.log(profile);

  return {
    ...result,
    nativeProfile: profile,
    debug:
      `${result.debug}, ` +
      `recvAnchors=${result.receiverAnchors.length}, ` +
      `sendAnchors=${result.senderAnchors.length}, ` +
      profile,
  };
};

export const createSmartLockerOcr =
  async (): Promise<SmartLockerOcrEngine> => {
    if (
      !NativeOcr ||
      typeof NativeOcr.initialize !== 'function' ||
      typeof NativeOcr.scanOrientation !== 'function'
    ) {
      throw new Error(
        'SmartLockerOcrNative chưa được đăng ký. Hãy kiểm tra MainApplication.kt và rebuild Android.',
      );
    }

    console.log(
      '🚀 Loading SmartLocker Native OCR...',
    );

    const initInfo =
      await NativeOcr.initialize();

    console.log(
      '✅ SmartLocker Native OCR READY',
      initInfo,
    );

    const scanJpeg = async (
      path: string,
    ): Promise<ReceiverPhoneResult> => {
      const totalStart = Date.now();

      const rotations:
        RotationPhoneResult[] = [];

      const orientations:
        Array<0 | 90 | 180 | 270> = [
          0,
          90,
          270,
          180,
        ];

      for (
        const degree of orientations
      ) {
        const current =
          await runNativeOrientation(
            path,
            degree,
          );

        rotations.push(
          current,
        );

        // ==================================================
        // NATIVE FAST PATH V3 — TRUST R0 V4 HIGH
        // ==================================================
        // V4 itself already defines HIGH conservatively:
        //
        // 1 candidate:
        //   score >= 4
        //
        // >=2 candidates:
        //   top score >= 4 AND margin >= 2
        //
        // Phone candidates have already passed:
        // - Vietnamese mobile validation
        // - hotline / tracking / order-id rejection
        // - receiver/sender spatial scoring
        //
        // Therefore, after native deskew, if R0 itself is HIGH,
        // running 90/270/180 again is redundant for the common case.
        //
        // Difficult cases still keep the full rotation fallback.
        const r0HighEnough =
          degree === 0 &&
          current.phone !== null &&
          current.confidence === 'HIGH' &&
          current.score !== null &&
          current.score >= 4;

        if (r0HighEnough) {
          console.log(
            '⚡ NATIVE FAST V3 ACCEPT R0:',
            current.phone,
            `score=${current.score?.toFixed(2)}`,
            `margin=${
              current.margin === null
                ? 'single'
                : current.margin.toFixed(2)
            }`,
            `candidates=${current.candidateScores.length}`,
            `receiverAnchors=${current.receiverAnchors.length}`,
            `senderAnchors=${current.senderAnchors.length}`,
          );

          break;
        }

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
              '⚡ NATIVE FAST AGREEMENT:',
              partial.phone,
            );

            break;
          }
        }
      }

      if (
        rotations.length === 0
      ) {
        throw new Error(
          'Native OCR không chạy được orientation nào.',
        );
      }

      const final =
        chooseAcrossRotations(
          rotations,
        );

      let representative =
        rotations[0];

      if (final.phone) {
        const matching =
          rotations.filter(
            rotation =>
              rotation.phone ===
              final.phone,
          );

        if (matching.length > 0) {
          representative =
            [...matching].sort(
              (a, b) =>
                (b.score ??
                  Number.NEGATIVE_INFINITY) -
                (a.score ??
                  Number.NEGATIVE_INFINITY),
            )[0];
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
        Date.now() - totalStart;

      const score =
        final.score ?? 0;

      const profileLines =
        rotations
          .map(
            r =>
              r.nativeProfile || '',
          )
          .filter(Boolean)
          .join('\n');

      const finalMethod =
        rotations.length === 1 &&
        final.phone
          ? 'NATIVE_FAST_V4'
          : final.method;

      return {
        phone: final.phone,
        score,
        margin: final.margin,
        confidence:
          final.confidence,
        method:
          finalMethod,
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
          `Native V4 phone=${
            final.phone ??
            'UNCERTAIN'
          }, ` +
          `confidence=${final.confidence}, ` +
          `method=${finalMethod}, ` +
          `score=${score.toFixed(2)}, ` +
          `margin=${
            final.margin === null
              ? 'null'
              : final.margin.toFixed(2)
          }, ` +
          `rotations=${rotations.length}, ` +
          `scanTotal=${totalMs}ms` +
          (
            profileLines
              ? `\n${profileLines}`
              : ''
          ),
      };
    };

    const dispose =
      async () => {
        try {
          await NativeOcr.dispose();
        } catch {}
      };

    return {
      dispose,
      scanJpeg,
    };
  };
