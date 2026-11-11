// prior.json — 녹화본에서 미리 학습한 "평소" (콜드스타트용).
//
// 파일 형식(v1):
//   { v: 1, createdAt, sourceMinutes, postsPerMinute, background: string[],
//     c: { "<key>": [mu, phi] | [mu, phi, hf[24]] } }
// mu는 탈계절화 평균 점유율, phi는 과분산, hf는 UTC 시각별 배수(평균 1). 숫자는 유효숫자
// 4자리로 잘라 파일을 줄인다.

export interface PriorEntry {
  mu: number;
  phi: number;
  hf?: Float32Array;
}

export interface Prior {
  createdAt: string;
  sourceMinutes: number;
  postsPerMinute: number;
  background: string[];
  entries: Map<string, PriorEntry>;
  /** 언어별 평소 post 점유율 — 언어 믹스 보정의 초기값 */
  langShare?: Record<string, number>;
}

export interface PriorFile {
  v: 1;
  createdAt: string;
  sourceMinutes: number;
  postsPerMinute: number;
  background: string[];
  c: Record<string, [number, number] | [number, number, number[]]>;
  langShare?: Record<string, number>;
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** 형식이 어긋나면 null — 깨진 prior는 "prior 없음"과 같다 */
export function parsePrior(json: unknown): Prior | null {
  if (typeof json !== "object" || json === null) return null;
  const f = json as Partial<PriorFile>;
  if (f.v !== 1 || typeof f.c !== "object" || f.c === null) return null;
  const ppm = num(f.postsPerMinute);
  if (ppm === null || ppm <= 0) return null;
  const entries = new Map<string, PriorEntry>();
  for (const [key, val] of Object.entries(f.c)) {
    if (!Array.isArray(val)) continue;
    const mu = num(val[0]);
    const phi = num(val[1]);
    if (mu === null || phi === null || mu < 0) continue;
    const e: PriorEntry = { mu, phi };
    const hf = val[2];
    if (Array.isArray(hf) && hf.length === 24 && hf.every((x) => num(x) !== null)) {
      e.hf = Float32Array.from(hf as number[]);
    }
    entries.set(key, e);
  }
  let langShare: Record<string, number> | undefined;
  if (typeof f.langShare === "object" && f.langShare !== null) {
    langShare = {};
    for (const [l, v] of Object.entries(f.langShare)) if (num(v) !== null && v >= 0) langShare[l] = v;
  }
  return {
    langShare,
    createdAt: typeof f.createdAt === "string" ? f.createdAt : "",
    sourceMinutes: num(f.sourceMinutes) ?? 0,
    postsPerMinute: ppm,
    background: Array.isArray(f.background) ? f.background.filter((w): w is string => typeof w === "string") : [],
    entries,
  };
}

const sig = (x: number): number => Number(x.toPrecision(4));

export function serializePrior(p: Prior): PriorFile {
  const c: PriorFile["c"] = {};
  for (const [k, e] of p.entries) {
    c[k] = e.hf === undefined ? [sig(e.mu), sig(e.phi)] : [sig(e.mu), sig(e.phi), Array.from(e.hf, (x) => Number(x.toFixed(2)))];
  }
  const out: PriorFile = {
    v: 1,
    createdAt: p.createdAt,
    sourceMinutes: p.sourceMinutes,
    postsPerMinute: sig(p.postsPerMinute),
    background: p.background,
    c,
  };
  if (p.langShare !== undefined) {
    out.langShare = {};
    for (const [l, v] of Object.entries(p.langShare)) out.langShare[l] = sig(v);
  }
  return out;
}

/**
 * UTC 시각별 언급 수·post 수 → hourFactor(평균 1). 이웃 시각과 1:2:1로 섞어 잡음을 줄이고
 * [0.2, 5]로 자른다. 하루 평균 점유율이 0이면 null. (build-prior가 24시간 이상 녹화에서 쓴다)
 */
export function hourFactorFrom(mentions: ArrayLike<number>, posts: ArrayLike<number>): number[] | null {
  const shares = Array.from({ length: 24 }, (_, h) => (posts[h] > 0 ? mentions[h] / posts[h] : 0));
  const mean = shares.reduce((a, b) => a + b, 0) / 24;
  if (!(mean > 0)) return null;
  return shares.map((_, h) => {
    const sm = (shares[(h + 23) % 24] + 2 * shares[h] + shares[(h + 1) % 24]) / 4;
    return Math.min(5, Math.max(0.2, sm / mean));
  });
}
