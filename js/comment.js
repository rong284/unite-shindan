/**
 * 性格タイプ判定と結果コメントの自動生成。
 *
 * 文章パーツ・タイプ定義は data/comments.json と data/personality-types.json に分離してある。
 * このファイルはそれらを組み立てるだけで、固定の文章は持たない。
 */

import { axisLookup, gameAxisKeys } from './model.js?v=fbba7c41';

// ライセンス名と実際に戦うポケモンの名前が異なる場合の表示名。
export function profileDisplayName(profile) {
  return profile.pokemon === 'ハッサム' && profile.profileName === 'ストライク'
    ? 'ストライク' : profile.pokemon;
}

const PERSONALITY_PREFIX = 'P_';
const DEFAULT_GENERIC_PROFILE_NAMES = ['共通プロファイル'];

/**
 * そのプロファイルが「技構成として紹介できる型」かどうか。
 * 型分けしていないポケモン（ProfileNameが共通プロファイル等）では技構成を表示しない。
 */
export function hasMoveset(profile, commentsData = {}) {
  const generic = commentsData.genericProfileNames ?? DEFAULT_GENERIC_PROFILE_NAMES;
  return Boolean(profile?.profileName) && !generic.includes(profile.profileName);
}

/** "Engage" は最終15軸、"P_Mastery" は性格7軸を参照する。 */
function axisValue(key, result) {
  if (key.startsWith(PERSONALITY_PREFIX)) {
    return result.personality?.[key.slice(PERSONALITY_PREFIX.length)];
  }
  return result.finalAxes?.[key];
}

/** 同じ診断結果なら毎回同じ文章になるように、結果から決定的な擬似乱数の種を作る。 */
function seedFromResult(result, extra = '') {
  let seed = 0;
  for (const value of Object.values(result.finalAxes ?? {})) {
    seed += Math.round(value * 100);
  }
  for (const value of Object.values(result.personality ?? {})) {
    seed += Math.round(value * 10);
  }
  for (const character of String(extra)) {
    seed += character.codePointAt(0);
  }
  return Math.abs(seed);
}

/** テンプレート配列から1つ選ぶ（結果が同じなら常に同じものを返す）。 */
function pickTemplate(templates, seed) {
  if (!templates?.length) return '';
  return templates[seed % templates.length];
}

function fillTemplate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    values[key] !== undefined && values[key] !== null ? String(values[key]) : '',
  );
}

/**
 * 軸の値を「全体の中でどれくらい高いか」（標準化スコア）に直す。
 * axisStats（tools/calibrate-types.mjs が疑似回答から計算）が無い軸は (値-50)/50 で代用する。
 */
function standardized(key, result, axisStats, model) {
  const value = axisValue(key, result);
  if (typeof value !== 'number') return null;
  const stats = axisStats?.[key];
  if (stats && stats.sd > 0) return (value - stats.mean) / stats.sd;
  const center = model.scoreCenter ?? 50;
  const span = model.scoreSpan ?? 50;
  return (value - center) / span;
}

/**
 * 性格タイプを判定する。
 *   score = bias + Σ weights[軸] × 標準化スコア[軸] / |weights|
 * が最大のタイプを選ぶ。weights が空のタイプは bias だけで比べる（どの軸も目立たない人向け）。
 * require（任意）を満たさないタイプは候補から外す。
 */
export function determinePersonalityType(result, typesData, model) {
  const axisStats = typesData.axisStats ?? {};

  const evaluate = (type) => {
    let score = 0;
    let norm = 0;
    for (const [axis, weight] of Object.entries(type.weights ?? {})) {
      const z = standardized(axis, result, axisStats, model);
      if (z === null) continue;
      score += weight * z;
      norm += weight * weight;
    }
    return (norm ? score / Math.sqrt(norm) : 0) + (typeof type.bias === 'number' ? type.bias : 0);
  };

  const satisfies = (type) =>
    (type.require ?? []).every((condition) => {
      const value = axisValue(condition.axis, result);
      if (typeof value !== 'number') return false;
      if (typeof condition.min === 'number' && value < condition.min) return false;
      if (typeof condition.max === 'number' && value > condition.max) return false;
      return true;
    });

  const candidates = (typesData.types ?? [])
    .filter(satisfies)
    .map((type) => ({ type, score: evaluate(type) }))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    const fallback = typesData.fallback ?? { id: 'unknown', name: '診断中', tagline: '' };
    return { ...fallback, score: 0, matched: false };
  }
  const best = candidates[0];
  return {
    id: best.type.id,
    name: best.type.name,
    tagline: best.type.tagline ?? '',
    lead: best.type.lead ?? '',
    body: best.type.body ?? '',
    color: best.type.color ?? typesData.fallback?.color ?? null,
    score: best.score,
    matched: true,
    runnerUps: candidates.slice(1, 4).map((item) => ({ id: item.type.id, name: item.type.name, score: item.score })),
  };
}

/**
 * 15軸の「どちら側に寄っているか」のラベル（Excel Axes の 0側 / 100側）。
 * 例: Dive が低い → 「安全ライン」、高い → 「深い踏み込み」。
 */
export function axisSideLabel(axis, side, model) {
  const meta = axisLookup(model)[axis];
  const label = side === 'low' ? meta?.lowLabel : meta?.highLabel;
  return label || meta?.nameJa || axis;
}

/**
 * 目立つ軸を取り出す。軸ごとに「全体の中でどちらへどれだけ寄っているか」（標準化スコア）を求め、
 * 寄りの大きい順に並べる。低い側に大きく寄っている軸も「低い側の特徴」として扱う。
 * @returns {{axis:string, side:'high'|'low', z:number}[]}
 */
export function pickNotableAxes(result, model, axisStats = null) {
  return gameAxisKeys(model)
    .filter((axis) => typeof result.finalAxes?.[axis] === 'number')
    .map((axis) => {
      const z = standardized(axis, result, axisStats, model);
      return { axis, z, side: z >= 0 ? 'high' : 'low' };
    })
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}

/**
 * プレイヤーとポケモンで特によく一致している軸を選ぶ。
 * 「差が小さい」かつ「同じ側（どちらも高い／どちらも低い）にはっきり寄っている」軸を優先し、
 * 足りなければ差の小さい軸で補う。side は一致している側（表示ラベルの選択に使う）。
 */
export function pickSharedAxes(result, profile, model, thresholds) {
  const center = model.scoreCenter ?? 50;
  const scored = gameAxisKeys(model)
    .map((axis) => {
      const playerValue = result.finalAxes[axis];
      const pokemonValue = profile.axes?.[axis];
      if (typeof playerValue !== 'number' || typeof pokemonValue !== 'number') return null;
      const level = (playerValue + pokemonValue) / 2;
      return {
        axis,
        playerValue,
        pokemonValue,
        difference: Math.abs(pokemonValue - playerValue),
        level,
        side: level >= center ? 'high' : 'low',
        sameSide: (playerValue >= center) === (pokemonValue >= center),
        distance: Math.abs(level - center),
      };
    })
    .filter(Boolean);

  const strong = scored
    .filter(
      (entry) =>
        entry.sameSide &&
        entry.difference <= (thresholds.matchAxisMaxDifference ?? 12) &&
        entry.distance >= (thresholds.matchAxisMinDistance ?? 6),
    )
    .sort((a, b) => b.distance - a.distance || a.difference - b.difference);

  // 条件を満たす軸が足りないときは、差の小さい軸で補う（同じ軸は重ねない）
  const fallback = [...scored].sort((a, b) => a.difference - b.difference || b.distance - a.distance);
  const count = thresholds.matchAxisCount ?? 3;
  const picked = strong.slice(0, count);
  for (const entry of fallback) {
    if (picked.length >= count) break;
    if (!picked.some((item) => item.axis === entry.axis)) picked.push(entry);
  }
  return picked;
}

/** 表示相性（DisplayScore）に応じた一言。 */
export function gradeComment(displayScore, commentsData) {
  const grades = commentsData.gradeComments ?? [];
  return grades.find((grade) => displayScore >= (grade.min ?? 0))?.text ?? '';
}

/**
 * Excel の ResultComment を、ほかの段落と同じ「です・ます」に揃える。
 * あわせて、1文目と同じ語句を2文目で繰り返している場合はその語句を落とす
 * （例:「味方の強みを引き出し…タイプ。味方の強みを引き出すことと、…ことを楽しめる人ほど」）。
 */
export function politeProfileComment(text) {
  if (!text) return '';
  const sentences = text.match(/[^。]+。?/g) ?? [text];
  const first = sentences[0] ?? '';
  return sentences
    .map((sentence, index) => {
      let result = sentence.trim();
      if (index > 0) {
        // 「引き出す」と「引き出し、」のように活用が違っても拾えるよう、語尾1文字を除いて比べる
        const appears = (phrase) => first.includes(phrase.slice(0, -1));
        result = result.replace(/^(.+?)ことと、(.+?)ことを楽しめる/, (match, a, b) => {
          if (appears(a)) return `${b}ことを楽しめる`;
          if (appears(b)) return `${a}ことを楽しめる`;
          return match;
        });
      }
      return result
        .replace(/に向く。$/, 'に向いています。')
        .replace(/効く。$/, '効きます。')
        .replace(/い。$/, 'いです。')
        .replace(/(タイプ|型|向け)。$/, '$1です。');
    })
    .join('');
}

/**
 * 結果コメントを組み立てる。
 *   ① あなたの特徴（寄りの大きい2軸 ＋ 3番目の軸との対比）
 *   ② なぜこのポケモン？（一致している3軸）
 *   ③ ポケモン（型）の紹介（Excel の ResultComment）
 *   ④ 相性の一言
 * @param {object} result runDiagnosis() の戻り値
 * @param {object} entry  代表プロファイル（result.top の要素）
 * @param {{model:object, comments:object, personalityTypes?:object}} data
 */
export function generateResultComment(result, entry, data) {
  const { model, comments } = data;
  const thresholds = comments.thresholds ?? {};
  const profile = entry.profile;
  const seed = seedFromResult(result, profile.pokemon);
  const phrases = comments.gameAxisPhrases ?? {};
  const notable = pickNotableAxes(result, model, data.personalityTypes?.axisStats);

  // 寄りの大きい軸から、その向き（高い側／低い側）の言い回しを使う
  const usable = notable.filter((item) => phrases[item.axis]?.[item.side]);
  const [first, second, third] = usable;
  const phrase = (item, side = item?.side) => (item ? phrases[item.axis]?.[side] ?? '' : '');
  const opposite = (side) => (side === 'high' ? 'low' : 'high');
  const summary = fillTemplate(pickTemplate(comments.templates?.playerSummary, seed), {
    traitA: phrase(first),
    traitB: phrase(second) || phrase(first),
    otherSide: third ? phrase(third, opposite(third.side)) : '',
    ownSide: phrase(third),
  });

  const sharedAxes = pickSharedAxes(result, profile, model, thresholds);
  const names = sharedAxes.map((item) => axisSideLabel(item.axis, item.side, model));
  const matchText = fillTemplate(pickTemplate(comments.templates?.matchReason, seed + 2), {
    pokemon: profileDisplayName(profile),
    axis1: names[0] ?? '',
    axis2: names[1] ?? names[0] ?? '',
    axis3: names[2] ?? names[1] ?? names[0] ?? '',
  });

  const profileComment = politeProfileComment(profile.resultComment);
  const grade = gradeComment(entry.displayScore, comments);

  return {
    summary,
    matchText,
    profileComment,
    grade,
    sharedAxes,
    notable,
    paragraphs: [summary, matchText, profileComment, grade].filter((text) => text && text.trim()),
  };
}
