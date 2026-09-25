/**
 * 性格タイプ判定と結果コメントの自動生成。
 *
 * 文章パーツ・タイプ定義は data/comments.json と data/personality-types.json に分離してある。
 * このファイルはそれらを組み立てるだけで、固定の文章は持たない。
 */

import { axisLookup, gameAxisKeys, sortAxesByScore } from './model.js';

const PERSONALITY_PREFIX = 'P_';

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
 * 性格タイプを判定する。
 * require をすべて満たすタイプのうち、weights による score が最大のものを選ぶ。
 */
export function determinePersonalityType(result, typesData, model) {
  const center = model.scoreCenter ?? 50;
  const span = model.scoreSpan ?? 50;

  const evaluate = (type) => {
    let score = typeof type.bias === 'number' ? type.bias : 0;
    for (const [axis, weight] of Object.entries(type.weights ?? {})) {
      const value = axisValue(axis, result);
      if (typeof value !== 'number') continue;
      score += weight * ((value - center) / span);
    }
    return score;
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
    color: best.type.color ?? typesData.fallback?.color ?? null,
    score: best.score,
    matched: true,
    runnerUps: candidates.slice(1, 4).map((item) => ({ id: item.type.id, name: item.type.name, score: item.score })),
  };
}

/**
 * 目立つ軸を取り出す。
 * 閾値（high / low）を満たす軸が無い場合に備えて、順位で並べたものも一緒に返す。
 */
export function pickNotableAxes(result, model, thresholds) {
  const descending = sortAxesByScore(result.finalAxes, model, { descending: true });
  const ascending = [...descending].reverse();
  return {
    descending,
    ascending,
    strongHigh: descending.filter((axis) => result.finalAxes[axis] >= thresholds.high),
    strongLow: ascending.filter((axis) => result.finalAxes[axis] <= thresholds.low),
    high: descending.slice(0, 3),
    low: ascending.slice(0, 2),
  };
}

/**
 * 紹介文に使う特徴を2つ選ぶ。
 * 明確に高い軸があればその「高いときの言い回し」を、
 * 高い軸が足りなければ低い軸の「低いときの言い回し」を使う。
 * （全部の回答が1のようなケースで「突っ込むのが好き」と書かないための処理）
 */
function pickTraitPhrases(notable, phrases, wanted = 2) {
  const traits = [];
  const usedAxes = [];
  for (const axis of notable.strongHigh) {
    if (traits.length >= wanted) break;
    if (!phrases[axis]?.high) continue;
    traits.push(phrases[axis].high);
    usedAxes.push(axis);
  }
  for (const axis of notable.strongLow) {
    if (traits.length >= wanted) break;
    if (!phrases[axis]?.low) continue;
    traits.push(phrases[axis].low);
    usedAxes.push(axis);
  }
  for (const axis of notable.descending) {
    if (traits.length >= wanted) break;
    if (usedAxes.includes(axis) || !phrases[axis]?.high) continue;
    traits.push(phrases[axis].high);
    usedAxes.push(axis);
  }
  return { traits, usedAxes };
}

/**
 * プレイヤーとポケモンで特によく一致している軸を選ぶ。
 * 「差が小さい」かつ「どちらもある程度高い」軸を優先し、
 * 見つからない場合は単純に差が小さい軸を使う。
 */
export function pickSharedAxes(result, profile, model, thresholds) {
  const keys = gameAxisKeys(model);
  const scored = keys
    .map((axis) => {
      const playerValue = result.finalAxes[axis];
      const pokemonValue = profile.axes?.[axis];
      if (typeof playerValue !== 'number' || typeof pokemonValue !== 'number') return null;
      return {
        axis,
        playerValue,
        pokemonValue,
        difference: Math.abs(pokemonValue - playerValue),
        level: (playerValue + pokemonValue) / 2,
      };
    })
    .filter(Boolean);

  const strong = scored
    .filter(
      (entry) =>
        entry.difference <= thresholds.matchAxisMaxDifference &&
        entry.level >= thresholds.matchAxisMinValue,
    )
    .sort((a, b) => b.level - a.level || a.difference - b.difference);

  const fallback = [...scored].sort((a, b) => a.difference - b.difference || b.level - a.level);
  return (strong.length ? strong : fallback).slice(0, thresholds.matchAxisCount);
}

/** MatchScore に応じた一言。 */
export function gradeComment(matchScore, commentsData) {
  const grades = commentsData.gradeComments ?? [];
  return grades.find((grade) => matchScore >= (grade.min ?? 0))?.text ?? '';
}

/**
 * 結果コメントを組み立てる。
 * @param {object} result runDiagnosis() の戻り値
 * @param {object} entry  代表プロファイル（result.top の要素）
 * @param {{model:object, comments:object}} data
 * @returns {{paragraphs:string[], summary:string, matchText:string, profileHint:string, grade:string, role:string}}
 */
export function generateResultComment(result, entry, data) {
  const { model, comments } = data;
  const thresholds = comments.thresholds ?? {};
  const axes = axisLookup(model);
  const profile = entry.profile;
  const seed = seedFromResult(result, profile.pokemon);
  const notable = pickNotableAxes(result, model, thresholds);
  const phrases = comments.gameAxisPhrases ?? {};
  const { traits, usedAxes } = pickTraitPhrases(notable, phrases);

  const summary = fillTemplate(pickTemplate(comments.templates?.playerSummary, seed), {
    highA: traits[0] ?? '',
    highB: traits[1] ?? traits[0] ?? '',
  });

  // 「苦手」を語る軸は、紹介文で使った軸と重複させない
  const lowAxis =
    notable.strongLow.find((axis) => !usedAxes.includes(axis)) ??
    notable.ascending.find((axis) => !usedAxes.includes(axis));
  const lowSentence = lowAxis
    ? fillTemplate(pickTemplate(comments.templates?.playerLow, seed + 1), {
        lowHighPhrase: phrases[lowAxis]?.high ?? '',
        lowPhrase: phrases[lowAxis]?.low ?? '',
      })
    : '';

  const sharedAxes = pickSharedAxes(result, profile, model, thresholds);
  const axisList = sharedAxes.map((item) => `・${axes[item.axis]?.nameJa ?? item.axis}`).join('\n');
  const matchText = [
    fillTemplate(pickTemplate(comments.templates?.matchIntro, seed + 2), {
      pokemon: profile.pokemon,
    }),
    axisList,
    pickTemplate(comments.templates?.matchOutro, seed + 2),
  ]
    .filter(Boolean)
    .join('\n');

  const profileHint = fillTemplate(pickTemplate(comments.templates?.profileHint, seed + 3), {
    profileName: profile.profileName,
    archetypeComment: comments.archetypeComments?.[profile.primaryArchetype] ?? '',
  });

  const role = comments.roleComments?.[profile.officialRole] ?? '';
  const grade = gradeComment(entry.matchScore, comments);

  return {
    summary,
    lowSentence,
    matchText,
    profileHint,
    role,
    grade,
    sharedAxes,
    notable,
    paragraphs: [`${summary}${lowSentence}`, matchText, `${profileHint}${role ? `\n${role}` : ''}`, grade].filter(
      (text) => text && text.trim(),
    ),
  };
}

/** 「意外な適性」用の一文。 */
export function generateSurpriseComment(result, surprise, data) {
  if (!surprise) return '';
  const seed = seedFromResult(result, surprise.profile.pokemon);
  return fillTemplate(pickTemplate(data.comments.templates?.surpriseIntro, seed), {
    pokemon: surprise.profile.pokemon,
  });
}
