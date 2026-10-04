/**
 * 診断エンジン。
 *
 * Excel（Model_Formula / Questions_30 / Profiles_140 / Simulator / Match_140）の計算を
 * そのまま再現する純粋な計算モジュール。DOM・localStorage・URL には一切触れない。
 *
 *   30問の回答 → 性格7軸 → 正規化 → 15ゲーム軸へ翻訳（＋性格の組み合わせ効果）
 *            → ゲーム嗜好による直接補正 → 最終15軸 → 全プロファイルとマッチング
 *
 * マッチング（Excel Match_140）:
 *   RawMatch     = 絶対距離（Absolute）と高低パターンの形（Shape）の合成 ＋ 尖り具合の補正（Specificity）
 *   Percentile   = そのプロファイルの RawMatch 分布（疑似回答20,000件）の中での位置（0〜1）
 *   DisplayScore = 画面に出す「相性 / 100」。Percentile を非線形に広げたもの
 *   RankScore    = 順位決定用。Percentile と RawMatch の加重和 ＋ 小さな RankBias
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
 * 段階ごとの振れ幅（PersonalityScale / TranslationScale / PreferenceScale）。
 * 未設定なら scoreSpan（=50）を使う。
 */
function stageScale(model, stage) {
  return numberOr(model.scales?.[stage], scoreConfig(model).span);
}

/**
 * 0〜100スコア化。
 *   score = center + scale × Σ(正規化値 × 係数) / Σ|係数|
 * 係数がすべて0の軸は中央値（=50）を返す。
 */
function toAxisScore(weightedSum, absCoeffSum, model, stage) {
  const { center, min, max } = scoreConfig(model);
  if (!absCoeffSum) return center;
  return clamp(center + stageScale(model, stage) * (weightedSum / absCoeffSum), min, max);
}

/**
 * 回答スタイル補正（model.responseStyle。未設定なら補正なし）。
 *
 * 「2・3・4中心で1・5をあまり使わない人」は、方向性があっても全軸が50付近に潰れやすい。
 * そこで回答の強さ ResponseExtremity = 平均|正規化回答|（全部3なら0、全部1/5なら1）を求め、
 *   scale = clamp((target / Extremity) ^ strength, minScale, maxScale)
 * を各回答の正規化値に掛ける（±1で頭打ち）。
 *   - 全部3（Extremity=0）は補正しない → 7軸は50のまま
 *   - 控えめな回答者は 2/4 が少し強めに効く（maxScale で上限）
 *   - ただし「ほぼ全部3」のように情報が少ない回答では強めない:
 *     Extremity が rampExtremity に届くまでは、強める量を比例して小さくする
 *   - 1/5 を多用する回答者はわずかに弱める（minScale で下限）
 * 回答の向き（どちら寄りか）は変えないので、極端な性格を捏造しない。
 */
export function responseStyle(answers, model) {
  const config = model.responseStyle;
  const norms = answers.map((answer) => answerToNorm(answer, model));
  const answered = answers.filter((answer) => model.answerScale.some((item) => item.value === answer)).length;
  const extremity = answered ? norms.reduce((sum, value) => sum + Math.abs(value), 0) / answered : 0;
  let scale = 1;
  if (config?.enabled !== false && config && extremity > 0) {
    scale = clamp(
      (numberOr(config.target, extremity) / extremity) ** numberOr(config.strength, 1),
      numberOr(config.minScale, 1),
      numberOr(config.maxScale, 1),
    );
    const ramp = numberOr(config.rampExtremity, 0);
    if (scale > 1 && ramp > 0 && extremity < ramp) {
      scale = 1 + (scale - 1) * (extremity / ramp);
    }
  }
  return {
    extremity,
    scale,
    norms: norms.map((value) => clamp(value * scale, -1, 1)),
  };
}

/**
 * 質問Loadingを使って1軸ぶんのスコアを出す共通処理。
 * @param {number[]} norms 質問と同じ並びの（回答スタイル補正後の）正規化回答 -1〜+1
 * @param {object[]} questions questions.json の questions
 * @param {string} loadingField 'personality' | 'gameplay'
 */
function scoreFromLoadings(norms, questions, model, loadingField, axisKey, stage) {
  let weightedSum = 0;
  let absCoeffSum = 0;
  questions.forEach((question, index) => {
    const loading = question[loadingField]?.[axisKey] ?? 0;
    if (!loading) return;
    weightedSum += (norms[index] ?? 0) * loading;
    absCoeffSum += Math.abs(loading);
  });
  return toAxisScore(weightedSum, absCoeffSum, model, stage);
}

/** 回答 → 性格7軸（0〜100）。回答スタイル補正を含む。 */
export function calculatePersonality(answers, questions, model) {
  const { norms } = responseStyle(answers, model);
  const scores = {};
  for (const axis of personalityAxisKeys(model)) {
    scores[axis] = scoreFromLoadings(norms, questions, model, 'personality', axis, 'personality');
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
  const { center, min, max } = scoreConfig(model);
  const normalized = normalizePersonality(personality, model);
  const bonuses = interactionBonuses(normalized, model);
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
    const linear = absCoeffSum ? stageScale(model, 'translation') * (weightedSum / absCoeffSum) : 0;
    translated[gameAxis] = clamp(center + linear + (bonuses[gameAxis] ?? 0), min, max);
  }
  return translated;
}

/**
 * 性格の組み合わせ効果（Excel Interaction_Model）。
 * 例:「自分から動く × 勝負に出る」が両方高いほど Engage / Dive を足す。
 *   high_high : max(0,a)×max(0,b)   low_second: max(0,a)×max(0,-b)
 *   low_first : max(0,-a)×max(0,b)  low_low   : max(0,-a)×max(0,-b)
 * （a, b は正規化した性格値 -1〜+1）
 */
export function interactionBonuses(normalized, model) {
  const strength = {
    high_high: (a, b) => Math.max(0, a) * Math.max(0, b),
    low_second: (a, b) => Math.max(0, a) * Math.max(0, -b),
    low_first: (a, b) => Math.max(0, -a) * Math.max(0, b),
    low_low: (a, b) => Math.max(0, -a) * Math.max(0, -b),
  };
  const bonuses = {};
  for (const interaction of model.interactions ?? []) {
    const factor = strength[interaction.mode]?.(
      normalized[interaction.factorA] ?? 0,
      normalized[interaction.factorB] ?? 0,
    );
    if (!factor) continue;
    for (const [axis, bonus] of Object.entries(interaction.bonus ?? {})) {
      bonuses[axis] = (bonuses[axis] ?? 0) + factor * bonus;
    }
  }
  return bonuses;
}

/** ゲーム嗜好・操作嗜好の質問から、15軸の直接嗜好スコアを出す。 */
export function calculatePreferences(answers, questions, model) {
  const { norms } = responseStyle(answers, model);
  const preferences = {};
  for (const axis of gameAxisKeys(model)) {
    preferences[axis] = scoreFromLoadings(norms, questions, model, 'gameplay', axis, 'preference');
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

/** マッチングの全体設定（Shape/Specificity補正）。未設定なら補正なし＝距離だけで評価する。 */
export function matchModelConfig(model) {
  const config = model.matchModel ?? {};
  return {
    baseShapeWeight: numberOr(config.baseShapeWeight, 0),
    signalReference: numberOr(config.signalReference, 18),
    specificityCorrection: numberOr(config.specificityCorrection, 0),
    specificityCap: numberOr(config.specificityCap, 0),
    displayBase: numberOr(config.displayBase, 42),
    displayRange: numberOr(config.displayRange, 55),
    displayPower: numberOr(config.displayPower, 3),
    displayMin: numberOr(config.displayMin, 55),
    rankPercentileWeight: numberOr(config.rankPercentileWeight, 0.8),
  };
}

/**
 * RawMatch がそのプロファイルの分布の中でどの位置か（0〜1、0.01刻み）。
 * Excel の MATCH(Raw, Q00:Q100, 1) と同じく「Raw 以下の分位点の数 - 1」を100で割る。
 * 分位点が無いプロファイルは null（呼び出し側で RawMatch をそのまま使う）。
 */
export function percentileOf(rawMatch, profile) {
  const quantiles = profile.percentile?.quantiles;
  if (!quantiles?.length) return null;
  let count = 0;
  while (count < quantiles.length && quantiles[count] <= rawMatch) count += 1;
  if (!count) return 0;
  return clamp((count - 1) / (quantiles.length - 1), 0, 1);
}

/** 15軸の重み付き平均（Weight で加重）。 */
function weightedMean(axes, model) {
  let total = 0;
  let weightSum = 0;
  for (const axis of gameAxisKeys(model)) {
    if (typeof axes?.[axis] !== 'number') continue;
    const { weight } = matchingConfig(model, axis);
    total += weight * axes[axis];
    weightSum += weight;
  }
  return weightSum ? total / weightSum : 0;
}

/**
 * プロファイルの「尖り具合」。15軸が50からどれだけ離れているかの重み付きRMS。
 *   ProfileSpecificity = sqrt(Σ Weight × (軸値 - 50)^2 / ΣWeight)
 */
export function profileSpecificity(profile, model) {
  const { center } = scoreConfig(model);
  let total = 0;
  let weightSum = 0;
  for (const axis of gameAxisKeys(model)) {
    const value = profile.axes?.[axis];
    if (typeof value !== 'number') continue;
    const { weight } = matchingConfig(model, axis);
    total += weight * (value - center) ** 2;
    weightSum += weight;
  }
  return weightSum ? Math.sqrt(total / weightSum) : 0;
}

/**
 * プレイヤー側の「好みのはっきり度」（PlayerSignal, 0〜1）。
 * 15軸の重み付き標準偏差 / SignalReference を1で頭打ち。
 * 回答が中立に近いほど0になり、ShapeScore（形の比較）をほとんど使わない。
 */
export function playerSignal(playerAxes, model) {
  const { signalReference } = matchModelConfig(model);
  const mean = weightedMean(playerAxes, model);
  let total = 0;
  let weightSum = 0;
  for (const axis of gameAxisKeys(model)) {
    if (typeof playerAxes?.[axis] !== 'number') continue;
    const { weight } = matchingConfig(model, axis);
    total += weight * (playerAxes[axis] - mean) ** 2;
    weightSum += weight;
  }
  const deviation = weightSum ? Math.sqrt(total / weightSum) : 0;
  return signalReference ? Math.min(1, deviation / signalReference) : 0;
}

/**
 * 形の近さ（ShapeScore）。15軸の高低パターンの重み付き相関を 0〜100 にしたもの。
 *   ShapeScore = 50 + 50 × corr(プレイヤー, プロファイル)
 * どちらかが完全に平ら（分散0）のときは 50。
 */
function shapeScore(playerAxes, profile, model) {
  const playerMean = weightedMean(playerAxes, model);
  const profileMean = weightedMean(profile.axes, model);
  let covariance = 0;
  let playerVariance = 0;
  let profileVariance = 0;
  for (const axis of gameAxisKeys(model)) {
    const value = profile.axes?.[axis];
    if (typeof value !== 'number') continue;
    const { weight } = matchingConfig(model, axis);
    const playerDiff = (playerAxes[axis] ?? 0) - playerMean;
    const profileDiff = value - profileMean;
    covariance += weight * playerDiff * profileDiff;
    playerVariance += weight * playerDiff ** 2;
    profileVariance += weight * profileDiff ** 2;
  }
  const denominator = Math.sqrt(playerVariance * profileVariance);
  // 分散がほぼ0（全軸同じ値）のときは相関が定義できないので中立の50にする
  if (denominator < 1e-9) return 50;
  return 50 + 50 * (covariance / denominator);
}

/**
 * 1プロファイルとのマッチング計算（Excel Match_140 と同じ式）。
 *   軸別誤差   = Weight × (ポケモン要求値 - プレイヤー値)^2 × (要求値超過なら 1+OverReqPenalty)
 *   Absolute   = max(0, 100 - sqrt(Σ軸別誤差 / ΣWeight))
 *   Hybrid     = Absolute × (1 - BaseShapeWeight×Signal) + Shape × (BaseShapeWeight×Signal)
 *   Specificity補正 = clamp(係数 × (ProfileSpecificity - 全プロファイル平均), ±Cap)
 *   RawMatch   = clamp(Hybrid + Specificity補正, 0, 100)
 *   DisplayScore = round(max(DisplayMin, DisplayBase + DisplayRange × Percentile^DisplayPower))
 *   RankScore  = w × Percentile×100 + (1-w) × RawMatch + RankBias（w = RankPercentileWeight）
 *
 * @param {object} [context] rankProfiles が全体から求めた値
 *   { signal: PlayerSignal, averageSpecificity: 全プロファイルの平均Specificity }
 *   省略時は Shape・Specificity 補正なし。
 */
export function calculateMatch(playerAxes, profile, model, context = {}) {
  const { min, max } = scoreConfig(model);
  const settings = matchModelConfig(model);
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
  const absoluteScore = Math.max(0, max - rmse);

  const signal = numberOr(context.signal, 0);
  const shape = shapeScore(playerAxes, profile, model);
  const shapeWeight = settings.baseShapeWeight * signal;
  const hybridScore = absoluteScore * (1 - shapeWeight) + shape * shapeWeight;

  const specificity = profileSpecificity(profile, model);
  const averageSpecificity = numberOr(context.averageSpecificity, specificity);
  const specificityCorrection = clamp(
    settings.specificityCorrection * (specificity - averageSpecificity),
    -settings.specificityCap,
    settings.specificityCap,
  );
  const rawMatch = clamp(hybridScore + specificityCorrection, min, max);

  // 表示用（相性 / 100）と順位用のスコア
  const percentile = percentileOf(rawMatch, profile);
  const displayScore =
    percentile === null
      ? Math.round(rawMatch)
      : Math.round(
          Math.max(
            settings.displayMin,
            settings.displayBase + settings.displayRange * percentile ** settings.displayPower,
          ),
        );
  const rankBias = numberOr(profile.rankBias, 0);
  const weight = settings.rankPercentileWeight;
  const rankScore =
    percentile === null
      ? rawMatch + rankBias
      : weight * percentile * 100 + (1 - weight) * rawMatch + rankBias;

  return {
    displayScore,
    rankScore,
    rawMatch,
    percentile,
    rankBias,
    absoluteScore,
    shapeScore: shape,
    hybridScore,
    specificity,
    specificityCorrection,
    rmse,
    weightedMse,
    weightSum,
    axisErrors,
  };
}

/** 全プロファイルの平均Specificity（SpecificityCorrection の基準点）。 */
export function averageSpecificity(profiles, model) {
  if (!profiles.length) return 0;
  return profiles.reduce((total, profile) => total + profileSpecificity(profile, model), 0) / profiles.length;
}

/**
 * 全プロファイルとのマッチングを計算し、RankScore降順に並べる（表示は DisplayScore）。
 * 同点は元データの並び順で決着させ、毎回同じ結果になるようにする。
 * position: 表示用の通し番号（同点でも重複しない）
 * rank: 同点を同順位とみなす順位
 */
export function rankProfiles(playerAxes, profiles, model) {
  const context = {
    signal: playerSignal(playerAxes, model),
    averageSpecificity: averageSpecificity(profiles, model),
  };
  const scored = profiles.map((profile, index) => ({
    profile,
    sourceIndex: index,
    ...calculateMatch(playerAxes, profile, model, context),
  }));

  scored.sort((a, b) => b.rankScore - a.rankScore || a.sourceIndex - b.sourceIndex);

  let previousScore = null;
  let previousRank = 0;
  scored.forEach((entry, index) => {
    entry.position = index + 1;
    if (previousScore !== null && Math.abs(entry.rankScore - previousScore) < 1e-9) {
      entry.rank = previousRank;
    } else {
      entry.rank = index + 1;
      previousRank = entry.rank;
      previousScore = entry.rankScore;
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

/**
 * おすすめTOP N（異なるポケモン）。
 * 1位は RankScore の最上位で固定。2位以降は、すでに選んだ候補と同じアーキタイプに
 * archetypePenalty（RankScore の点数）× 重なり数 だけペナルティを付けて選ぶ
 * （同じアーキタイプだけで候補欄が埋まらないようにするため。0なら単純な上位N）。
 */
export function selectTopPokemon(ranked, count, { archetypePenalty = 0 } = {}) {
  const pool = groupByPokemon(ranked);
  if (!archetypePenalty) return pool.slice(0, count);
  const picked = pool.slice(0, 1);
  const rest = pool.slice(1);
  while (picked.length < count && rest.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    rest.forEach((entry, index) => {
      const overlap = picked.filter((item) => item.profile.primaryArchetype === entry.profile.primaryArchetype).length;
      const score = entry.rankScore - archetypePenalty * overlap;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    picked.push(rest.splice(bestIndex, 1)[0]);
  }
  return picked;
}

/**
 * 診断ひとまとめ。UIはこの関数の戻り値だけを見ればよい。
 * @param {number[]} answers 1〜5の回答（questions と同じ並び。未回答は null 可）
 * @param {{questions:object[], model:object, profiles:object[]}} data
 * @param {{topCount?:number}} options
 */
export function runDiagnosis(answers, data, options = {}) {
  const { questions, model, profiles } = data;
  const topCount = options.topCount ?? 5;

  const personality = calculatePersonality(answers, questions, model);
  const normalizedPersonality = normalizePersonality(personality, model);
  const translated = translateToGameplay(personality, model);
  const preference = calculatePreferences(answers, questions, model);
  const finalAxes = calculateFinalAxes(translated, preference, model);
  const ranked = rankProfiles(finalAxes, profiles, model);
  const top = selectTopPokemon(ranked, topCount, { archetypePenalty: model.topDiversity?.archetypePenalty ?? 0 });

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
    playerSignal: playerSignal(finalAxes, model),
    responseStyle: (({ extremity, scale }) => ({ extremity, scale }))(responseStyle(answers, model)),
    // 回答の情報量（補正前の平均|正規化回答|）。全部3なら0、1・5ばかりなら1に近い
    responseInformation: responseStyle(answers, model).extremity,
    profileCount: ranked.length,
  };
}

/**
 * サイトだけの設定を Excel 由来のデータに重ねる。
 *   tuning.topDiversity → おすすめ2〜5位の選び方（アーキタイプの重なりペナルティ。順位計算そのものは変えない）
 * Percentile・RankBias・回答スタイル補正は Excel（profiles.json / model.json）の値をそのまま使う。
 */
export function applyTuning({ model, profiles }, tuning = null) {
  const tunedModel = tuning?.topDiversity ? { ...model, topDiversity: tuning.topDiversity } : model;
  return { model: tunedModel, profiles };
}

/** 最も高い／低い軸を取り出す（コメント生成・タイプ判定の共通部品）。 */
export function sortAxesByScore(axes, model, { descending = true } = {}) {
  const keys = gameAxisKeys(model).filter((axis) => typeof axes[axis] === 'number');
  const sorted = [...keys].sort((a, b) =>
    descending ? axes[b] - axes[a] : axes[a] - axes[b],
  );
  return sorted;
}
