/**
 * 性格タイプ判定と結果コメントの自動生成。
 *
 * 文章パーツ・タイプ定義は data/comments.json と data/personality-types.json に分離してある。
 * このファイルはそれらを組み立てるだけで、固定の文章は持たない。
 */

import { axisLookup, gameAxisKeys } from './model.js?v=a4573a67';
import { displayPokemonName } from './ui.js?v=283494cb';

// ライセンス名と実際に戦うポケモンの名前が異なる場合の表示名。
export function profileDisplayName(profile) {
  return profile.pokemon === 'ハッサム' && profile.profileName === 'ストライク'
    ? 'ストライク' : displayPokemonName(profile.pokemon);
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

/**
 * 技構成で分けたプロファイルの「戦い方」の表示名。わざは排他的なビルドではないので「中心」として添える。
 *   例: ブラッキー ねがいごと（Enchanter）→「支援寄り（ねがいごと中心）」
 * 型分けしていないポケモンは空文字。ラベルは comments.json の styleLabels / styleLabelOverrides。
 */
export function profileStyleLabel(profile, commentsData = {}) {
  if (!hasMoveset(profile, commentsData)) return '';
  const override = commentsData.styleLabelOverrides?.[profile.id];
  if (override) return override;
  const base = commentsData.styleLabels?.[profile.primaryArchetype];
  return base ? `${base}（${profile.profileName}中心）` : `${profile.profileName}中心`;
}

/** 候補一覧に添える1行説明（紹介文の1文目）。 */
export function candidateSummary(profile) {
  const text = politeProfileComment(profile.resultComment);
  return (text.match(/^[^。]+。/) ?? [text])[0];
}

/**
 * 2位以下の候補の表示内容。相性の数値は出さず、「こちらもおすすめ」と1行説明を添える
 * （順位は RankScore、数値は DisplayScore で決まるため、数値を並べると順位と食い違って見えることがある）。
 */
export function buildCandidateItems(entries, commentsData = {}) {
  return entries.map((entry) => ({
    pokemon: profileDisplayName(entry.profile),
    role: entry.profile.officialRole ?? '',
    style: profileStyleLabel(entry.profile, commentsData),
    provisional: entry.profile.confidence === '低',
    summary: candidateSummary(entry.profile),
    label: commentsData.candidateLabel ?? 'こちらもおすすめ',
  }));
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
 * 15軸の表示ラベルを comments.json の gameAxisLabels で置き換える（計算用のキーは変えない）。
 * Excel の StyleKeywords（例: 安全ライン、連携依存）も同じ言葉（例: 安全に戦う、連携で力を出す）にそろえる。
 */
export function applyDisplayLabels({ model, profiles }, comments) {
  const labels = comments?.gameAxisLabels;
  if (!labels) return { model, profiles };
  const rename = {};
  const gameAxes = model.gameAxes.map((axis) => {
    const override = labels[axis.key];
    if (!override) return axis;
    if (axis.lowLabel && override.low) rename[axis.lowLabel] = override.low;
    if (axis.highLabel && override.high) rename[axis.highLabel] = override.high;
    return { ...axis, lowLabel: override.low ?? axis.lowLabel, highLabel: override.high ?? axis.highLabel };
  });
  return {
    model: { ...model, gameAxes },
    profiles: profiles.map((profile) => ({
      ...profile,
      styleKeywords: (profile.styleKeywords ?? []).map((word) => rename[word] ?? word),
    })),
  };
}

/**
 * 回答の情報量が極端に少ない（全部3など）ときは「参考結果」として扱う。ランキングはそのまま、表示だけ変える。
 * 閾値は display.json の result.referenceResult.maxResponseInformation（これ未満で参考結果）。
 */
export function isReferenceResult(result, displayConfig) {
  const threshold = displayConfig?.result?.referenceResult?.maxResponseInformation;
  return typeof threshold === 'number' && typeof result.responseInformation === 'number' && result.responseInformation < threshold;
}

/** 結果カードの一言（僅差 / 高相性 / それ以外）。 */
export function heroMessage(result, comments) {
  const messages = comments.heroMessages ?? {};
  const [first, second] = result.top;
  if (second && first.rankScore - second.rankScore < 1 && messages.close) return messages.close;
  if (first.displayScore >= (messages.highMin ?? 90) && messages.high) return messages.high;
  return messages.default ?? '';
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
 * プレイヤーとポケモンが「同じ向きにはっきり寄っている」軸だけを選ぶ（最大 matchAxisCount 個）。
 *   ポケモン側: 中央から matchAxisPokemonMinDistance 以上（その軸がポケモンの持ち味と言える）
 *   プレイヤー側: 中央から matchAxisPlayerMinDistance 以上（その軸が本人の好みと言える）
 *   両者が中央をはさまず同じ側にいる
 * 条件を満たす軸が足りなくても、反対側や中央付近の軸で補わない（間違った理由を出すより少ない方がよい）。
 * side は一致している側（表示ラベルの選択に使う）。
 */
export function pickSharedAxes(result, profile, model, thresholds) {
  const center = model.scoreCenter ?? 50;
  const pokemonMin = thresholds.matchAxisPokemonMinDistance ?? 20;
  const playerMin = thresholds.matchAxisPlayerMinDistance ?? 10;
  const count = thresholds.matchAxisCount ?? 3;
  return gameAxisKeys(model)
    .map((axis) => {
      const playerValue = result.finalAxes[axis];
      const pokemonValue = profile.axes?.[axis];
      if (typeof playerValue !== 'number' || typeof pokemonValue !== 'number') return null;
      const playerDistance = Math.abs(playerValue - center);
      const pokemonDistance = Math.abs(pokemonValue - center);
      const sameSide =
        (playerValue > center && pokemonValue > center) || (playerValue < center && pokemonValue < center);
      if (!sameSide || pokemonDistance < pokemonMin || playerDistance < playerMin) return null;
      return {
        axis,
        playerValue,
        pokemonValue,
        difference: Math.abs(pokemonValue - playerValue),
        side: pokemonValue > center ? 'high' : 'low',
        sameSide: true,
        // プレイヤーとポケモンの両方が強く寄っている軸ほど先に出す
        strength: Math.min(playerDistance, pokemonDistance),
        distance: playerDistance + pokemonDistance,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.strength - a.strength || b.distance - a.distance || a.difference - b.difference)
    .slice(0, count);
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
 *   ② なぜこのポケモン？（同じ向きにはっきり一致している軸。0〜3個）
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

  // 一致した軸（最大3つ）を、タグ（ラベル）と、人の言葉の文（gameAxisPhrases の一致した側）の両方で返す
  const sharedAxes = pickSharedAxes(result, profile, model, thresholds);
  const sharedLabels = sharedAxes.map((item) => axisSideLabel(item.axis, item.side, model));
  const sharedPhrases = sharedAxes.map((item) => phrases[item.axis]?.[item.side] ?? axisSideLabel(item.axis, item.side, model));
  // 一致した軸の数（0〜3）に合わせた文型を使う。0個のときは個別の理由を作らない
  const reasonTemplates = comments.templates?.matchReason ?? {};
  const matchText = fillTemplate(pickTemplate(reasonTemplates[String(sharedPhrases.length)], seed + 2), {
    pokemon: profileDisplayName(profile),
    p1: sharedPhrases[0] ?? '',
    p2: sharedPhrases[1] ?? '',
    p3: sharedPhrases[2] ?? '',
  });

  const profileComment = politeProfileComment(profile.resultComment);
  const grade = gradeComment(entry.displayScore, comments);

  return {
    summary,
    matchText,
    profileComment,
    grade,
    sharedAxes,
    sharedLabels,
    notable,
    paragraphs: [summary, matchText, profileComment, grade].filter((text) => text && text.trim()),
  };
}
