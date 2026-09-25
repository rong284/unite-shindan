/**
 * 診断エンジン。
 *
 * Excel（Model_Formula / Questions_30 / Profiles_140 / Simulator / Match_140）の計算を
 * そのまま再現する純粋な計算モジュール。DOM・localStorage・URL には一切触れない。
 *
 *   30問の回答 → 性格7軸 → 正規化 → 15ゲーム軸へ翻訳
 *            → ゲーム嗜好による直接補正 → 最終15軸 → 140プロファイルとマッチング
 *
 * 係数・重み・ペナルティなどの数値は必ず data/*.json（= Excel）から受け取り、
 * このファイルにはハードコードしない。
 */

/** 数値を範囲内に収める。 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** model.json のスコア設定（0〜100化のための定数）を取り出す。 */
function scoreConfig(model) {
  return {
    center: numberOr(model.scoreCenter, 50),
    span: numberOr(model.scoreSpan, 50),
    min: numberOr(model.scoreMin, 0),
    max: numberOr(model.scoreMax, 100),
  };
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 性格軸のキー一覧（model.json の並び順が表示順になる）。 */
export function personalityAxisKeys(model) {
  return model.personalityAxes.map((axis) => axis.key);
}

/** ゲーム軸のキー一覧。 */
export function gameAxisKeys(model) {
  return model.gameAxes.map((axis) => axis.key);
}

/** 軸キー → 軸メタ情報（日本語名など）の辞書。 */
export function axisLookup(model) {
  const lookup = {};
  for (const axis of [...model.personalityAxes, ...model.gameAxes]) {
    lookup[axis.key] = axis;
  }
  return lookup;
}

/** 回答値（1〜5）を正規化係数（-1〜+1）へ。未回答・範囲外は中立扱い。 */
export function answerToNorm(answer, model) {
  const entry = model.answerScale.find((item) => item.value === answer);
  return entry ? entry.norm : 0;
}

/**
 * 0〜100スコア化。
 *   score = center + span × Σ(正規化値 × 係数) / Σ|係数|
 * 係数がすべて0の軸は中央値（=50）を返す。
 */
function toAxisScore(weightedSum, absCoeffSum, model) {
  const { center, span, min, max } = scoreConfig(model);
  if (!absCoeffSum) return center;
  return clamp(center + span * (weightedSum / absCoeffSum), min, max);
}

/**
 * 質問Loadingを使って1軸ぶんのスコアを出す共通処理。
 * @param {number[]} answers 質問と同じ並びの回答値（1〜5）
 * @param {object[]} questions questions.json の questions
 * @param {string} loadingField 'personality' | 'gameplay'
 */
function scoreFromLoadings(answers, questions, model, loadingField, axisKey) {
  let weightedSum = 0;
  let absCoeffSum = 0;
  questions.forEach((question, index) => {
    const loading = question[loadingField]?.[axisKey] ?? 0;
    if (!loading) return;
    weightedSum += answerToNorm(answers[index], model) * loading;
    absCoeffSum += Math.abs(loading);
  });
  return toAxisScore(weightedSum, absCoeffSum, model);
}

/** 回答 → 性格7軸（0〜100）。 */
export function calculatePersonality(answers, questions, model) {
  const scores = {};
  for (const axis of personalityAxisKeys(model)) {
    scores[axis] = scoreFromLoadings(answers, questions, model, 'personality', axis);
  }
  return scores;
}

/** 性格スコア（0〜100）→ 正規化値（-1〜+1）。 */
export function normalizePersonality(personality, model) {
  const { center, span } = scoreConfig(model);
  const normalized = {};
  for (const [axis, score] of Object.entries(personality)) {
    normalized[axis] = (score - center) / span;
  }
  return normalized;
}

/** 性格7軸 → 15ゲーム軸（翻訳係数による変換）。 */
export function translateToGameplay(personality, model) {
  const normalized = normalizePersonality(personality, model);
  const translated = {};
  for (const gameAxis of gameAxisKeys(model)) {
    const coefficients = model.translation[gameAxis] ?? {};
    let weightedSum = 0;
    let absCoeffSum = 0;
    for (const [personalityAxis, coefficient] of Object.entries(coefficients)) {
      if (!coefficient) continue;
      weightedSum += (normalized[personalityAxis] ?? 0) * coefficient;
      absCoeffSum += Math.abs(coefficient);
    }
    translated[gameAxis] = toAxisScore(weightedSum, absCoeffSum, model);
  }
  return translated;
}

/** ゲーム嗜好・操作嗜好の質問から、15軸の直接嗜好スコアを出す。 */
export function calculatePreferences(answers, questions, model) {
  const preferences = {};
  for (const axis of gameAxisKeys(model)) {
    preferences[axis] = scoreFromLoadings(answers, questions, model, 'gameplay', axis);
  }
  return preferences;
}

/** 軸ごとのマッチング設定（Weight / OverReqPenalty / PreferenceBlend）。 */
export function matchingConfig(model, axis) {
  const config = model.matching?.[axis] ?? {};
  return {
    weight: numberOr(config.weight, 1),
    overReqPenalty: numberOr(config.overReqPenalty, 0),
    preferenceBlend: numberOr(config.preferenceBlend, 0),
  };
}

/**
 * 最終15軸 = 翻訳値 × (1 - Blend) + 直接嗜好 × Blend
 * Blend は軸別に Model_Formula から読む。
 */
export function calculateFinalAxes(translated, preference, model) {
  const { min, max } = scoreConfig(model);
  const final = {};
  for (const axis of gameAxisKeys(model)) {
    const { preferenceBlend } = matchingConfig(model, axis);
    const translatedValue = translated[axis] ?? 0;
    const preferenceValue = preference[axis] ?? 0;
    final[axis] = clamp(
      translatedValue * (1 - preferenceBlend) + preferenceValue * preferenceBlend,
      min,
      max,
    );
  }
  return final;
}

/**
 * 1プロファイルとのマッチング計算。
 *   軸別誤差 = Weight × (ポケモン要求値 - プレイヤー値)^2 × (要求値超過なら 1+OverReqPenalty)
 *   MatchScore = max(0, 100 - sqrt(Σ軸別誤差 / ΣWeight))
 */
export function calculateMatch(playerAxes, profile, model) {
  const { max } = scoreConfig(model);
  const axisErrors = {};
  let errorSum = 0;
  let weightSum = 0;

  for (const axis of gameAxisKeys(model)) {
    const pokemonValue = profile.axes?.[axis];
    if (typeof pokemonValue !== 'number') continue; // 未設定の軸は計算から除外する
    const playerValue = playerAxes[axis] ?? 0;
    const { weight, overReqPenalty } = matchingConfig(model, axis);
    const overRequirement = pokemonValue > playerValue;
    const penalty = overRequirement ? 1 + overReqPenalty : 1;
    const difference = pokemonValue - playerValue;
    const error = weight * difference * difference * penalty;

    axisErrors[axis] = {
      pokemonValue,
      playerValue,
      difference,
      weight,
      penalty,
      overRequirement,
      error,
    };
    errorSum += error;
    weightSum += weight;
  }

  const weightedMse = weightSum ? errorSum / weightSum : 0;
  const rmse = Math.sqrt(weightedMse);
  return {
    matchScore: Math.max(0, max - rmse),
    rmse,
    weightedMse,
    weightSum,
    axisErrors,
  };
}

/**
 * 全プロファイルとのマッチングを計算し、MatchScore降順に並べる。
 * 同点は元データの並び順で決着させ、毎回同じ結果になるようにする。
 * position: 表示用の通し番号（同点でも重複しない）
 * rank: 同点を同順位とみなす順位
 */
export function rankProfiles(playerAxes, profiles, model) {
  const scored = profiles.map((profile, index) => ({
    profile,
    sourceIndex: index,
    ...calculateMatch(playerAxes, profile, model),
  }));

  scored.sort((a, b) => b.matchScore - a.matchScore || a.sourceIndex - b.sourceIndex);

  let previousScore = null;
  let previousRank = 0;
  scored.forEach((entry, index) => {
    entry.position = index + 1;
    if (previousScore !== null && Math.abs(entry.matchScore - previousScore) < 1e-9) {
      entry.rank = previousRank;
    } else {
      entry.rank = index + 1;
      previousRank = entry.rank;
      previousScore = entry.matchScore;
    }
  });

  return scored;
}

/**
 * ポケモン単位に畳み込む。同じポケモンの型が上位を独占しないように、
 * 1体につき最も相性の良い型（代表型）だけを残す。
 * 各要素は alternates に同じポケモンの他の型を相性順で持つ。
 */
export function groupByPokemon(ranked) {
  const byPokemon = new Map();
  for (const entry of ranked) {
    const name = entry.profile.pokemon;
    if (!byPokemon.has(name)) {
      byPokemon.set(name, { ...entry, pokemon: name, alternates: [] });
    } else {
      byPokemon.get(name).alternates.push(entry);
    }
  }
  return [...byPokemon.values()];
}

/** おすすめTOP N（異なるポケモン）。 */
export function selectTopPokemon(ranked, count) {
  return groupByPokemon(ranked).slice(0, count);
}

/** 2プロファイル間の15軸の平均絶対差（プレイスタイルの方向性の違い）。 */
export function axisDistance(axesA, axesB, model) {
  const keys = gameAxisKeys(model);
  let total = 0;
  let counted = 0;
  for (const axis of keys) {
    const a = axesA?.[axis];
    const b = axesB?.[axis];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    total += Math.abs(a - b);
    counted += 1;
  }
  return counted ? total / counted : 0;
}

/**
 * 「意外な適性」を1件選ぶ。
 * 上位に出ているポケモンを除き、1位とは方向性（公式ロール／アーキタイプ／15軸）が
 * 違うのに相性が高い候補を探す。条件に合うものが無い場合は段階的に条件を緩める。
 */
export function pickSurprisePick(ranked, displayedPokemon, model, config = {}) {
  if (!ranked.length) return null;
  const settings = {
    searchDepth: 60,
    maxScoreGapFromTop: 12,
    requireDifferentRole: true,
    requireDifferentArchetype: true,
    minAxisDistance: 12,
    axisDistanceBonus: 0.35,
    ...config,
  };

  const top = ranked[0];
  const excluded = new Set(displayedPokemon);
  const pool = groupByPokemon(ranked)
    .slice(0, settings.searchDepth)
    .filter((entry) => !excluded.has(entry.profile.pokemon))
    .filter((entry) => top.matchScore - entry.matchScore <= settings.maxScoreGapFromTop)
    .map((entry) => ({
      ...entry,
      distance: axisDistance(entry.profile.axes, top.profile.axes, model),
      differentRole: entry.profile.officialRole !== top.profile.officialRole,
      differentArchetype: entry.profile.primaryArchetype !== top.profile.primaryArchetype,
    }));

  // 厳しい条件から順に試し、見つからなければ緩める
  const filters = [
    (entry) =>
      (!settings.requireDifferentRole || entry.differentRole) &&
      (!settings.requireDifferentArchetype || entry.differentArchetype) &&
      entry.distance >= settings.minAxisDistance,
    (entry) =>
      (!settings.requireDifferentRole || entry.differentRole) &&
      (!settings.requireDifferentArchetype || entry.differentArchetype),
    (entry) => !settings.requireDifferentRole || entry.differentRole,
    () => true,
  ];

  for (const filter of filters) {
    const candidates = pool.filter(filter);
    if (!candidates.length) continue;
    // 相性の高さと「方向性の違い」の両方を評価して1件選ぶ
    candidates.sort(
      (a, b) =>
        b.matchScore + b.distance * settings.axisDistanceBonus -
        (a.matchScore + a.distance * settings.axisDistanceBonus),
    );
    return candidates[0];
  }
  return null;
}

/**
 * 診断ひとまとめ。UIはこの関数の戻り値だけを見ればよい。
 * @param {number[]} answers 1〜5の回答（questions と同じ並び。未回答は null 可）
 * @param {{questions:object[], model:object, profiles:object[]}} data
 * @param {{topCount?:number, surprise?:object}} options
 */
export function runDiagnosis(answers, data, options = {}) {
  const { questions, model, profiles } = data;
  const topCount = options.topCount ?? 3;

  const personality = calculatePersonality(answers, questions, model);
  const normalizedPersonality = normalizePersonality(personality, model);
  const translated = translateToGameplay(personality, model);
  const preference = calculatePreferences(answers, questions, model);
  const finalAxes = calculateFinalAxes(translated, preference, model);
  const ranked = rankProfiles(finalAxes, profiles, model);
  const top = selectTopPokemon(ranked, topCount);
  const surprise = pickSurprisePick(
    ranked,
    top.map((entry) => entry.profile.pokemon),
    model,
    options.surprise,
  );

  return {
    answers: [...answers],
    answeredCount: answers.filter((value) => typeof value === 'number').length,
    personality,
    normalizedPersonality,
    translated,
    preference,
    finalAxes,
    ranked,
    top,
    surprise,
    profileCount: ranked.length,
  };
}

/** 最も高い／低い軸を取り出す（コメント生成・タイプ判定の共通部品）。 */
export function sortAxesByScore(axes, model, { descending = true } = {}) {
  const keys = gameAxisKeys(model).filter((axis) => typeof axes[axis] === 'number');
  const sorted = [...keys].sort((a, b) =>
    descending ? axes[b] - axes[a] : axes[a] - axes[b],
  );
  return sorted;
}
