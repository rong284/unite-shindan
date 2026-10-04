#!/usr/bin/env node
/**
 * Percentile の分位点と RankBias を、サイトの計算（回答スタイル補正込み）で作り直す。
 *
 *   node tools/calibrate-model.mjs           # excel-handoff/calibration.json を更新
 *   node tools/calibrate-model.mjs --check   # 書き込まずに監査結果だけ表示
 *
 * 手順（設定は data/tuning.json の calibration）:
 *   1. 疑似回答者 calibrationSamples 人（回答スタイル混合。tools/lib/population.mjs）で
 *      各プロファイルの RawMatch 分布を作り、Q00〜Q100 の分位点を保存する
 *   2. 別の rankBiasSamples 人で、1位率が maxTop1Rate を超えるポケモンを少し下げ、
 *      TOP3率が minTop3Rate に届かないポケモンを少し上げる（RankBias、範囲は rankBiasMin〜Max）
 *   3. さらに別の auditSamples 人で監査する（調整に使っていない回答で確認）
 *
 * 結果は excel-handoff/calibration.json に出力する。tools/excel_patch.py --calibration で Excel へ書き戻し、
 * tools/export_excel.py で profiles.json に書き出してからサイトに反映される（Excel が唯一の正本）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyTuning,
  averageSpecificity,
  calculateFinalAxes,
  calculateMatch,
  calculatePersonality,
  calculatePreferences,
  gameAxisKeys,
  personalityAxisKeys,
  playerSignal,
  responseStyle,
  translateToGameplay,
} from '../js/model.js';
import { createRng, independentAnswers, samplePopulation, STYLE_MIX } from './lib/population.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const checkOnly = process.argv.includes('--check');

const questions = read('data/questions.json').questions;
const tuning = read('data/tuning.json');
const settings = tuning.calibration;
// 分位点・RankBias はここで作り直す（Excel の現在の値は使わない）
const { model, profiles } = applyTuning(
  { model: read('data/model.json'), profiles: read('data/profiles.json').profiles },
  tuning,
);
const personalityKeys = personalityAxisKeys(model);
const averageSpec = averageSpecificity(profiles, model);
const QUANTILE_COUNT = 101;

/** 回答 → 最終15軸。 */
function finalAxesOf(answers) {
  const personality = calculatePersonality(answers, questions, model);
  return calculateFinalAxes(
    translateToGameplay(personality, model),
    calculatePreferences(answers, questions, model),
    model,
  );
}

/** 回答 → 全プロファイルの RawMatch（Float64Array）。 */
function rawMatches(answers) {
  const finalAxes = finalAxesOf(answers);
  const context = { signal: playerSignal(finalAxes, model), averageSpecificity: averageSpec };
  const out = new Float64Array(profiles.length);
  profiles.forEach((profile, index) => {
    out[index] = calculateMatch(finalAxes, { ...profile, percentile: null }, model, context).rawMatch;
  });
  return out;
}

function quantilesOf(values) {
  const sorted = Float64Array.from(values).sort();
  return Array.from({ length: QUANTILE_COUNT }, (unused, k) => {
    const position = (k / (QUANTILE_COUNT - 1)) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(sorted.length - 1, lower + 1);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  });
}

/** Excel の MATCH(Raw, Q00:Q100, 1) と同じ Percentile。 */
function percentileFrom(raw, quantiles) {
  let count = 0;
  while (count < quantiles.length && quantiles[count] <= raw) count += 1;
  return count ? (count - 1) / (quantiles.length - 1) : 0;
}

const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

// --- 1. 分位点 --------------------------------------------------------------
const started = Date.now();
const calibrationPeople = samplePopulation(questions, personalityKeys, settings.calibrationSamples, settings.calibrationSeed);
const columns = profiles.map(() => new Float64Array(calibrationPeople.length));
calibrationPeople.forEach((person, row) => {
  const raws = rawMatches(person.answers);
  raws.forEach((value, index) => {
    columns[index][row] = value;
  });
});
const percentiles = {};
profiles.forEach((profile, index) => {
  const values = columns[index];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  percentiles[profile.id] = {
    rawMean: round(mean),
    rawSd: round(sd),
    quantiles: quantilesOf(values).map((value) => round(value)),
  };
});

// --- 2. RankBias -------------------------------------------------------------
const { rankPercentileWeight: weight, displayBase, displayRange, displayPower, displayMin } = {
  rankPercentileWeight: 0.8,
  displayBase: 42,
  displayRange: 55,
  displayPower: 3,
  displayMin: 55,
  ...model.matchModel,
};
const pokemonNames = [...new Set(profiles.map((profile) => profile.pokemon))];
const pokemonIndex = profiles.map((profile) => pokemonNames.indexOf(profile.pokemon));

/** 回答者ごとの「RankBias 抜きの RankScore」と表示スコアを前計算する。 */
function precompute(answerSets) {
  return answerSets.map((answers) => {
    const raws = rawMatches(answers);
    const base = new Float64Array(profiles.length);
    const display = new Int16Array(profiles.length);
    profiles.forEach((profile, index) => {
      const pct = percentileFrom(raws[index], percentiles[profile.id].quantiles);
      base[index] = weight * pct * 100 + (1 - weight) * raws[index];
      display[index] = Math.round(Math.max(displayMin, displayBase + displayRange * pct ** displayPower));
    });
    return { base, display };
  });
}

const archetypeOf = profiles.map((profile) => profile.primaryArchetype);
const diversityPenalty = model.topDiversity?.archetypePenalty ?? 0;

/** 各回答者の TOP3（異なるポケモン、サイトと同じアーキタイプの重なりペナルティ込み）を数える。 */
function tally(rows, biases) {
  const top1 = new Float64Array(pokemonNames.length);
  const top3 = new Float64Array(pokemonNames.length);
  const topDisplay = [];
  for (const { base, display } of rows) {
    const order = Array.from(base.keys()).sort((a, b) => base[b] + biases[b] - (base[a] + biases[a]) || a - b);
    // ポケモンごとの代表型（最上位の型）
    const pool = [];
    const pooled = new Set();
    for (const index of order) {
      if (pooled.has(pokemonIndex[index])) continue;
      pooled.add(pokemonIndex[index]);
      pool.push(index);
      if (pool.length >= 20) break;
    }
    const chosen = [pool.shift()];
    while (chosen.length < 3 && pool.length) {
      let best = 0;
      let bestScore = -Infinity;
      pool.forEach((index, position) => {
        const overlap = chosen.filter((item) => archetypeOf[item] === archetypeOf[index]).length;
        const score = base[index] + biases[index] - diversityPenalty * overlap;
        if (score > bestScore) {
          bestScore = score;
          best = position;
        }
      });
      chosen.push(pool.splice(best, 1)[0]);
    }
    topDisplay.push(display[chosen[0]]);
    const seen = chosen.map((index) => pokemonIndex[index]);
    top1[seen[0]] += 1;
    for (const poke of seen) top3[poke] += 1;
  }
  const n = rows.length;
  return {
    top1: Array.from(top1, (count) => count / n),
    top3: Array.from(top3, (count) => count / n),
    topDisplay: topDisplay.sort((a, b) => a - b),
  };
}

const biasPeople = samplePopulation(questions, personalityKeys, settings.rankBiasSamples, settings.rankBiasSeed);
const biasRows = precompute(biasPeople.map((person) => person.answers));
const pokemonBias = new Float64Array(pokemonNames.length);
const profileBiases = () => Float64Array.from(profiles, (profile, index) => pokemonBias[pokemonIndex[index]]);
for (let iteration = 0; iteration < 40; iteration += 1) {
  const { top1, top3 } = tally(biasRows, profileBiases());
  let changed = false;
  pokemonNames.forEach((name, index) => {
    if (top1[index] > settings.maxTop1Rate && pokemonBias[index] > settings.rankBiasMin) {
      pokemonBias[index] = Math.max(settings.rankBiasMin, pokemonBias[index] - settings.rankBiasStep);
      changed = true;
    } else if (top3[index] < settings.minTop3Rate && pokemonBias[index] < settings.rankBiasMax) {
      pokemonBias[index] = Math.min(settings.rankBiasMax, pokemonBias[index] + settings.rankBiasStep);
      changed = true;
    }
  });
  if (!changed) break;
}
const rankBias = Object.fromEntries(profiles.map((profile, index) => [profile.id, round(pokemonBias[pokemonIndex[index]], 2)]));

// --- 3. 監査（調整に使っていない回答） ------------------------------------------
const auditPeople = samplePopulation(questions, personalityKeys, settings.auditSamples, settings.auditSeed);
const finalBiases = Float64Array.from(profiles, (profile) => rankBias[profile.id]);
const audit = tally(precompute(auditPeople.map((person) => person.answers)), finalBiases);
const rng = createRng(settings.auditSeed + 1);
const independent = tally(
  precompute(Array.from({ length: settings.auditSamples }, () => independentAnswers(questions, rng))),
  finalBiases,
);

function summarize(label, result) {
  const at = (p) => result.topDisplay[Math.floor(p * (result.topDisplay.length - 1))];
  const maxIndex = result.top1.indexOf(Math.max(...result.top1));
  const missing = pokemonNames.filter((name, index) => result.top3[index] === 0);
  return {
    label,
    maxTop1: { pokemon: pokemonNames[maxIndex], rate: round(result.top1[maxIndex]) },
    top3Missing: missing,
    topDisplay: { p10: at(0.1), median: at(0.5), p90: at(0.9) },
  };
}

// 回答スタイル別の「15軸の丸さ」（40〜60に入る軸の割合）
const gameKeys = gameAxisKeys(model);
const roundness = {};
for (const person of auditPeople) {
  const finalAxes = finalAxesOf(person.answers);
  const entry = (roundness[person.style] ??= { n: 0, mid: 0, extremity: 0 });
  entry.n += 1;
  entry.mid += gameKeys.filter((axis) => Math.abs(finalAxes[axis] - 50) <= 10).length / gameKeys.length;
  entry.extremity += responseStyle(person.answers, model).extremity;
}

const report = {
  styleMix: Object.fromEntries(STYLE_MIX),
  population: summarize('回答スタイル混合（校正と同じ種類の母集団・別サンプル）', audit),
  independent: summarize('各問を独立に1〜5（Excel Calibration_Audit と同じ方式）', independent),
  roundnessByStyle: Object.fromEntries(
    Object.entries(roundness).map(([style, entry]) => [
      style,
      { mid15Rate: round(entry.mid / entry.n, 3), meanExtremity: round(entry.extremity / entry.n, 3) },
    ]),
  ),
  rankBiasNonZero: Object.fromEntries(
    pokemonNames.map((name, index) => [name, round(pokemonBias[index], 2)]).filter(([, value]) => value),
  ),
};

console.log(`校正完了（${((Date.now() - started) / 1000).toFixed(1)}秒）`);
for (const key of ['population', 'independent']) {
  const item = report[key];
  console.log(
    `  ${item.label}\n    最大1位率 ${item.maxTop1.pokemon} ${(item.maxTop1.rate * 100).toFixed(1)}% / TOP3未出現 ${item.top3Missing.length}体` +
      `${item.top3Missing.length ? `（${item.top3Missing.join('、')}）` : ''} / 1位の表示相性 p10 ${item.topDisplay.p10}・中央値 ${item.topDisplay.median}・p90 ${item.topDisplay.p90}`,
  );
}
console.log('  15軸のうち40〜60に入る割合（回答スタイル別）:');
for (const [style, entry] of Object.entries(report.roundnessByStyle)) {
  console.log(`    ${style.padEnd(12)} ${(entry.mid15Rate * 100).toFixed(0)}%（平均Extremity ${entry.meanExtremity}）`);
}
console.log('  RankBias（0以外）:', JSON.stringify(report.rankBiasNonZero));

if (checkOnly) {
  console.log('（--check のため書き込んでいません）');
  process.exit(0);
}

const meta = {
  generatedAt: new Date().toISOString(),
  note: 'tools/calibrate-model.mjs が生成する中間ファイル。tools/excel_patch.py --calibration で Excel（Percentile_Calibration / Profiles_140 RankBias）へ書き戻す。サイトは Excel から書き出した profiles.json を使う。',
  responseStyle: model.responseStyle,
  calibration: settings,
  sourceWorkbook: read('data/profiles.json').meta?.sourceWorkbook ?? null,
};
let text = `${JSON.stringify({ meta, audit: report, rankBias, percentiles }, null, 2)}\n`;
text = text.replace(/\[\s+(-?[0-9.e+-]+(?:,\s+-?[0-9.e+-]+)*)\s+\]/g, (match, body) => `[${body.split(',').map((part) => part.trim()).join(', ')}]`);
const output = path.join(ROOT, 'excel-handoff', 'calibration.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, text);
console.log('更新: excel-handoff/calibration.json');
console.log('次に Excel へ書き戻してから書き出す: python3 tools/excel_patch.py --calibration excel-handoff/calibration.json → python3 tools/export_excel.py');
