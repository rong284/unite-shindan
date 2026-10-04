/**
 * 回答スタイル（3が多い・2〜4だけ・1と5が多い など）で結果がどう変わるかの監査（データは書き換えない）。
 *
 *   node tools/audit-response-styles.mjs [candidates.json]
 *
 * 同じ性格・同じ回答ノイズの人たちが、スタイルだけ変えて答えた場合を比べる。
 * candidates.json（tools/compare-models.mjs と同じ形式）を渡すと、先頭の候補をその場で当てて計算する。
 * Percentile はその場で作り直し（回答スタイル混合の母集団）、RankBias は 0。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyTuning, gameAxisKeys, personalityAxisKeys, selectTopPokemon } from '../js/model.js';
import { buildModel, fitProfiles, rankAll, stagesOf } from './lib/candidate.mjs';
import { createRng, gaussian, latentResponses, randomTraits, samplePopulation } from './lib/population.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const PEOPLE = 3000;
const FIT_SAMPLES = 8000;

const tuning = read('data/tuning.json');
const base = applyTuning({ model: read('data/model.json'), profiles: read('data/profiles.json').profiles }, tuning);
const questions = read('data/questions.json').questions;
const candidate = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0] : { name: '現行' };
const model = buildModel(base.model, candidate);
const personalityKeys = personalityAxisKeys(model);
const gameKeys = gameAxisKeys(model);
const fitPeople = samplePopulation(questions, personalityKeys, FIT_SAMPLES, tuning.calibration.calibrationSeed);
const profiles = fitProfiles(base.profiles, model, questions, fitPeople, candidate.profiles);

// 同じ性格・同じノイズの潜在値（tools/lib/population.mjs と同じ作り方）
const rng = createRng(20261010);
const latents = Array.from({ length: PEOPLE }, () => {
  const traits = randomTraits(personalityKeys, rng);
  const noise = questions.map(() => gaussian(rng) * 0.45);
  return latentResponses(questions, traits, rng, noise);
});

// 「3がこの割合・1と5は合わせて約10%」になる区切りを、潜在値の分布から決める
const magnitudes = latents.flat().map(Math.abs).sort((a, b) => a - b);
const cutAt = (share) => magnitudes[Math.floor(share * (magnitudes.length - 1))];
const middleStyle = (share) => {
  const inner = cutAt(share);
  const outer = cutAt(0.9);
  return [-outer, -inner, inner, outer];
};
const toAnswers = (latent, thresholds, { min = 1, max = 5 } = {}) =>
  latent.map((y) => Math.min(max, Math.max(min, 1 + thresholds.filter((cut) => y > cut).length)));

const STYLES = [
  ['通常分布', (latent) => toAnswers(latent, [-0.81, -0.33, 0.33, 0.81])],
  ['3を50%', (latent) => toAnswers(latent, middleStyle(0.5))],
  ['3を60%', (latent) => toAnswers(latent, middleStyle(0.6))],
  ['2/3/4のみ', (latent) => toAnswers(latent, [-0.81, -0.33, 0.33, 0.81], { min: 2, max: 4 })],
  ['1/5を多用', (latent) => toAnswers(latent, [-0.45, -0.12, 0.12, 0.45])],
  ['全3', () => questions.map(() => 3)],
];

const quantile = (sorted, p) => sorted[Math.round(p * (sorted.length - 1))];
const q3 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return [0.1, 0.5, 0.9].map((p) => quantile(sorted, p).toFixed(0)).join('/');
};
const pct = (value) => `${(value * 100).toFixed(1)}%`;

console.log(`回答スタイル監査: ${candidate.name}（同じ性格の${PEOPLE}人 / Percentileはその場で作り直し・RankBias 0）`);
console.log(`3を50%の区切り ±${middleStyle(0.5)[2].toFixed(2)} / 3を60%の区切り ±${middleStyle(0.6)[2].toFixed(2)}（1・5は合わせて約10%）`);

for (const [name, answer] of STYLES) {
  const answerSets = latents.map((latent) => answer(latent));
  const counts = [0, 0, 0, 0, 0];
  answerSets.flat().forEach((value) => (counts[value - 1] += 1));
  const total = answerSets.length * questions.length;
  const personality = Object.fromEntries(personalityKeys.map((key) => [key, []]));
  const game = Object.fromEntries(gameKeys.map((key) => [key, []]));
  let p40to60 = 0;
  let g40to60 = 0;
  const display = [];
  const roles = new Map();
  const pokemon = new Map();
  for (const answers of answerSets) {
    const s = stagesOf(answers, questions, model);
    personalityKeys.forEach((key) => personality[key].push(s.personality[key]));
    gameKeys.forEach((key) => game[key].push(s.final[key]));
    p40to60 += personalityKeys.filter((key) => s.personality[key] >= 40 && s.personality[key] <= 60).length / personalityKeys.length;
    g40to60 += gameKeys.filter((key) => s.final[key] >= 40 && s.final[key] <= 60).length / gameKeys.length;
    const top = selectTopPokemon(rankAll(s.final, profiles, model), 1)[0];
    display.push(top.displayScore);
    roles.set(top.profile.officialRole, (roles.get(top.profile.officialRole) ?? 0) + 1);
    pokemon.set(top.profile.pokemon, (pokemon.get(top.profile.pokemon) ?? 0) + 1);
  }
  const n = answerSets.length;
  console.log(`\n■ ${name}（回答の内訳 1〜5: ${counts.map((c) => pct(c / total)).join(' / ')}）`);
  console.log(`  7軸 p10/p50/p90: ${personalityKeys.map((key) => `${key} ${q3(personality[key])}`).join(' | ')}`);
  console.log(`  15軸 p10/p50/p90: ${gameKeys.map((key) => `${key} ${q3(game[key])}`).join(' | ')}`);
  console.log(`  40〜60に入る軸の割合: 7軸 ${pct(p40to60 / n)} / 15軸 ${pct(g40to60 / n)}`);
  console.log(`  1位のDisplayScore p10/p50/p90: ${q3(display)}`);
  console.log(`  1位のロール: ${[...roles.entries()].sort((a, b) => b[1] - a[1]).map(([role, c]) => `${role} ${pct(c / n)}`).join(' / ')}`);
  console.log(`  1位のポケモン上位: ${[...pokemon.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name2, c]) => `${name2} ${pct(c / n)}`).join(' / ')}（${pokemon.size}種類）`);
}
