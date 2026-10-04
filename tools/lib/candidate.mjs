/**
 * 係数・プロファイル値の「候補」を、データを書き換えずにその場で当てて計算するための共通部品。
 * tools/compare-models.mjs と tools/audit-response-styles.mjs で使う。
 *
 * candidate: { translation?: {軸: {性格軸: 係数}}, preferenceBlend?: {軸: 値}, profiles?: {ProfileID: {軸: 値}} }
 */

import {
  averageSpecificity,
  calculateFinalAxes,
  calculateMatch,
  calculatePersonality,
  calculatePreferences,
  playerSignal,
  translateToGameplay,
} from '../../js/model.js';

const QUANTILES = 101;

export function buildModel(baseModel, candidate = {}) {
  const model = structuredClone(baseModel);
  for (const [axis, coefficients] of Object.entries(candidate.translation ?? {})) model.translation[axis] = coefficients;
  for (const [axis, blend] of Object.entries(candidate.preferenceBlend ?? {})) model.matching[axis].preferenceBlend = blend;
  return model;
}

/** 回答 → 翻訳のみ / 嗜好のみ / Blend後 の15軸と、性格7軸。 */
export function stagesOf(answers, questions, model) {
  const personality = calculatePersonality(answers, questions, model);
  const translated = translateToGameplay(personality, model);
  const preference = calculatePreferences(answers, questions, model);
  return { personality, translated, preference, final: calculateFinalAxes(translated, preference, model) };
}

/**
 * プロファイル値の上書きを当て、Percentile の分位点を fitPeople で作り直す（RankBias は 0）。
 * tools/calibrate-model.mjs と同じ分位点の取り方。
 */
export function fitProfiles(baseProfiles, model, questions, fitPeople, overrides = {}) {
  const profiles = baseProfiles.map((profile) => ({
    ...profile,
    axes: { ...profile.axes, ...(overrides[profile.id] ?? {}) },
    percentile: null,
    rankBias: 0,
  }));
  const avg = averageSpecificity(profiles, model);
  const columns = profiles.map(() => new Float64Array(fitPeople.length));
  fitPeople.forEach((person, row) => {
    const axes = stagesOf(person.answers, questions, model).final;
    const context = { signal: playerSignal(axes, model), averageSpecificity: avg };
    profiles.forEach((profile, index) => {
      columns[index][row] = calculateMatch(axes, profile, model, context).rawMatch;
    });
  });
  return profiles.map((profile, index) => {
    const sorted = columns[index].sort();
    const quantiles = Array.from({ length: QUANTILES }, (unused, k) => {
      const position = (k / (QUANTILES - 1)) * (sorted.length - 1);
      const lower = Math.floor(position);
      const upper = Math.min(sorted.length - 1, lower + 1);
      return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
    });
    return { ...profile, percentile: { quantiles } };
  });
}

/** 全プロファイルを RankScore 順に並べる。 */
export function rankAll(axes, profiles, model) {
  const context = { signal: playerSignal(axes, model), averageSpecificity: averageSpecificity(profiles, model) };
  return profiles
    .map((profile) => ({ profile, ...calculateMatch(axes, profile, model, context) }))
    .sort((a, b) => b.rankScore - a.rankScore);
}
