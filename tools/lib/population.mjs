/**
 * 疑似回答者の生成（校正ツール・監査・テストで共通）。
 *
 * これまでの「各問に1〜5を独立にランダムで選ぶ」方式では、
 * 「2・3・4中心だが方向性のある人」のような回答スタイルの違いを表現できない。
 * そこで、
 *   1. 回答者ごとに「本当の性格」traits（7気質、-1〜+1付近）を決める
 *   2. 各質問の性格Loadingから、その人が感じる同意の強さ（潜在値）を求めてノイズを足す
 *   3. 回答スタイルごとの区切り値で 1〜5 に変換する
 * という手順で回答を作る。同じ traits・同じノイズで回答スタイルだけを変えることもできる。
 */

/** 再現できる疑似乱数（mulberry32）。 */
export function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 標準正規乱数（Box-Muller）。 */
export function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * 回答スタイル。潜在値 y を thresholds で区切って 1〜5 にする。
 *   normal     : 1〜5 をバランスよく使う（おおむね 10/20/40/20/10%）
 *   midpoint   : 「どちらともいえない」が多い
 *   noExtreme  : 1 と 5 を使わない（2・3・4 だけ）
 *   extreme    : 1 と 5 をよく使う
 *   acquiescent: 何でも「やや当てはまる」寄り（同意しがち）
 *   random     : 性格と関係なく各問を独立に選ぶ（読まずに押す人。Excel Calibration_Audit と同じ 10/20/40/20/10%）
 */
export const RESPONSE_STYLES = {
  normal: { thresholds: [-0.81, -0.33, 0.33, 0.81] },
  midpoint: { thresholds: [-1.05, -0.55, 0.55, 1.05] },
  noExtreme: { thresholds: [-0.81, -0.33, 0.33, 0.81], min: 2, max: 4 },
  extreme: { thresholds: [-0.45, -0.12, 0.12, 0.45] },
  acquiescent: { thresholds: [-0.81, -0.33, 0.33, 0.81], shift: 0.35 },
  random: { independent: true },
};

/** 母集団の回答スタイル構成（校正・監査用）。 */
export const STYLE_MIX = [
  ['normal', 0.4],
  ['midpoint', 0.18],
  ['noExtreme', 0.14],
  ['extreme', 0.1],
  ['acquiescent', 0.08],
  ['random', 0.1],
];

const TRAIT_SD = 0.55;
const ITEM_NOISE_SD = 0.45;

function pickStyle(rng) {
  let x = rng();
  for (const [style, weight] of STYLE_MIX) {
    if ((x -= weight) < 0) return style;
  }
  return STYLE_MIX[0][0];
}

/** 本当の性格（7気質）をランダムに決める。 */
export function randomTraits(personalityKeys, rng) {
  return Object.fromEntries(personalityKeys.map((key) => [key, gaussian(rng) * TRAIT_SD]));
}

/** traits から各質問の潜在値（同意の強さ）を作る。noise を渡すと同じノイズを再利用できる。 */
export function latentResponses(questions, traits, rng, noise = null) {
  return questions.map((question, index) => {
    let signal = 0;
    let absSum = 0;
    for (const [axis, loading] of Object.entries(question.personality ?? {})) {
      signal += loading * (traits[axis] ?? 0);
      absSum += Math.abs(loading);
    }
    const base = absSum ? signal / absSum : 0;
    return base + (noise ? noise[index] : gaussian(rng) * ITEM_NOISE_SD);
  });
}

/** 潜在値を、指定した回答スタイルで 1〜5 に変換する。 */
export function toAnswers(latent, style) {
  const config = RESPONSE_STYLES[style];
  return latent.map((value) => {
    const y = value + (config.shift ?? 0);
    let answer = 1 + config.thresholds.filter((cut) => y > cut).length;
    if (config.min) answer = Math.max(config.min, answer);
    if (config.max) answer = Math.min(config.max, answer);
    return answer;
  });
}

/**
 * 疑似回答者を n 人作る。
 * @returns {{answers:number[], style:string, traits:object}[]}
 */
export function samplePopulation(questions, personalityKeys, n, seed) {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => {
    const traits = randomTraits(personalityKeys, rng);
    const style = pickStyle(rng);
    const answers = RESPONSE_STYLES[style].independent
      ? independentAnswers(questions, rng)
      : toAnswers(latentResponses(questions, traits, rng), style);
    return { answers, style, traits };
  });
}

/**
 * 同じ性格・同じノイズの人が、回答スタイルだけ変えて答えた場合の回答を作る（スタイル不変性の監査用）。
 * @returns {{traits:object, answersByStyle:Object<string, number[]>}}
 */
export function sameTraitsAllStyles(questions, personalityKeys, rng) {
  const traits = randomTraits(personalityKeys, rng);
  const noise = questions.map(() => gaussian(rng) * ITEM_NOISE_SD);
  const latent = latentResponses(questions, traits, rng, noise);
  const answersByStyle = Object.fromEntries(
    Object.keys(RESPONSE_STYLES)
      .filter((style) => !RESPONSE_STYLES[style].independent)
      .map((style) => [style, toAnswers(latent, style)]),
  );
  return { traits, answersByStyle };
}

/** Excel Calibration_Audit と同じ「各問を独立に 1〜5（10/20/40/20/10%）」の回答。比較用。 */
export function independentAnswers(questions, rng) {
  return questions.map(() => {
    const x = rng();
    return x < 0.1 ? 1 : x < 0.3 ? 2 : x < 0.7 ? 3 : x < 0.9 ? 4 : 5;
  });
}
