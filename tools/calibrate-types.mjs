#!/usr/bin/env node
/**
 * 性格タイプの出現率をならすための自動調整。
 *
 *   node tools/calibrate-types.mjs            # data/personality-types.json を更新
 *   node tools/calibrate-types.mjs --check    # 書き込まずに出現率だけ表示
 *
 * やっていること:
 *   1. 疑似回答者（回答スタイル混合。tools/lib/population.mjs）の回答を、サイトと同じ補正込みで計算する
 *   2. 各軸の平均・標準偏差（axisStats）を求める → 判定では軸の値を「全体の中での高さ」に直す
 *   3. 各タイプの bias を少しずつ動かして、出現率がほぼ均等になるようにする
 *
 * タイプの意味（weights）は変えない。weights・質問・Excel を変えたら実行し直すこと。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyTuning,
  calculateFinalAxes,
  calculatePersonality,
  calculatePreferences,
  gameAxisKeys,
  personalityAxisKeys,
  translateToGameplay,
} from '../js/model.js';
import { determinePersonalityType } from '../js/comment.js';
import { samplePopulation } from './lib/population.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES_PATH = path.join(ROOT, 'data/personality-types.json');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));

const CALIBRATION_SAMPLES = 8000;
const CHECK_SAMPLES = 4000;
const ITERATIONS = 400;
const STEP = 0.4;

const checkOnly = process.argv.includes('--check');
const { model } = applyTuning(
  { model: read('data/model.json'), profiles: read('data/profiles.json').profiles },
  read('data/tuning.json'),
);
const questions = read('data/questions.json').questions;
const typesData = read('data/personality-types.json');

function sampleAnswers(count, seed) {
  return samplePopulation(questions, personalityAxisKeys(model), count, seed).map((person) => person.answers);
}

function toResult(answers) {
  const personality = calculatePersonality(answers, questions, model);
  const finalAxes = calculateFinalAxes(
    translateToGameplay(personality, model),
    calculatePreferences(answers, questions, model),
    model,
  );
  return { personality, finalAxes };
}

function computeAxisStats(results) {
  const keys = [
    ...gameAxisKeys(model).map((axis) => ({ key: axis, get: (r) => r.finalAxes[axis] })),
    ...personalityAxisKeys(model).map((axis) => ({ key: `P_${axis}`, get: (r) => r.personality[axis] })),
  ];
  const stats = {};
  for (const { key, get } of keys) {
    const values = results.map(get);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    stats[key] = { mean: round(mean, 3), sd: round(Math.sqrt(variance), 3) };
  }
  return stats;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** bias 抜きのスコア表（サンプル × タイプ）。 */
function baseScores(results, data) {
  const unbiased = { ...data, types: data.types.map((type) => ({ ...type, bias: 0, require: undefined })) };
  return results.map((result) =>
    unbiased.types.map((type) => determinePersonalityType(result, { ...unbiased, types: [type] }, model).score),
  );
}

function assign(scores, biases) {
  return scores.map((row) => {
    let best = 0;
    for (let index = 1; index < row.length; index += 1) {
      if (row[index] + biases[index] > row[best] + biases[best]) best = index;
    }
    return best;
  });
}

function frequencies(assignments, typeCount) {
  const counts = new Array(typeCount).fill(0);
  for (const index of assignments) counts[index] += 1;
  return counts.map((count) => count / assignments.length);
}

const types = typesData.types;
const target = 1 / types.length;

const calibrationResults = sampleAnswers(CALIBRATION_SAMPLES, 20260929).map(toResult);
const axisStats = computeAxisStats(calibrationResults);
const withStats = { ...typesData, axisStats };
const scores = baseScores(calibrationResults, withStats);

const biases = new Array(types.length).fill(0);
for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
  const freq = frequencies(assign(scores, biases), types.length);
  freq.forEach((value, index) => {
    biases[index] += STEP * (Math.log(target) - Math.log(Math.max(value, 0.5 / CALIBRATION_SAMPLES))) * 0.1;
  });
  // 平均を0に戻して、値が全体としてずれていかないようにする
  const mean = biases.reduce((sum, value) => sum + value, 0) / biases.length;
  biases.forEach((value, index) => {
    biases[index] = value - mean;
  });
}

const calibrated = {
  ...typesData,
  axisStats,
  types: types.map((type, index) => ({ ...type, bias: round(biases[index], 3) })),
};

// 調整に使っていない別の疑似回答で出現率を確認する
const checkResults = sampleAnswers(CHECK_SAMPLES, 777).map(toResult);
const counts = new Map();
for (const result of checkResults) {
  const type = determinePersonalityType(result, calibrated, model);
  counts.set(type.id, (counts.get(type.id) ?? 0) + 1);
}
console.log(`性格タイプの出現率（検証用の疑似回答 ${CHECK_SAMPLES}件、目標 ${(target * 100).toFixed(1)}%）`);
for (const type of calibrated.types) {
  const rate = ((counts.get(type.id) ?? 0) / CHECK_SAMPLES) * 100;
  console.log(`  ${rate.toFixed(1).padStart(5)}%  bias ${type.bias.toFixed(2).padStart(6)}  ${type.name}`);
}

if (checkOnly) {
  console.log('（--check のため書き込んでいません）');
} else {
  fs.writeFileSync(TYPES_PATH, `${JSON.stringify(calibrated, null, 2)}\n`);
  console.log(`更新: ${path.relative(ROOT, TYPES_PATH)}`);
}
