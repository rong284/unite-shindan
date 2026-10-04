#!/usr/bin/env node
/**
 * 目視確認用: 代表的な回答パターンの診断結果を一覧にする。
 *
 *   node tools/review-patterns.mjs
 *
 * 「出てくるポケモンが理屈として納得できるか」を人が読んで確かめるためのもの。
 * 性格パターンは、指定した気質の向きに沿う質問を 5（逆向きの質問は 1）、それ以外を 3 で答えた回答。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyTuning, personalityAxisKeys, runDiagnosis } from '../js/model.js';
import { applyDisplayLabels, axisSideLabel, determinePersonalityType, generateResultComment } from '../js/comment.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const questions = read('data/questions.json').questions;
const { model, profiles } = applyDisplayLabels(
  applyTuning(
    { model: read('data/model.json'), profiles: read('data/profiles.json').profiles },
    read('data/tuning.json'),
  ),
  read('data/comments.json'),
);
const data = {
  questions,
  model,
  profiles,
  comments: read('data/comments.json'),
  personalityTypes: read('data/personality-types.json'),
};

/** 指定した気質の向き（+1 / -1）に沿って答える。strong=false なら 4 / 2 で控えめに答える。 */
function traitAnswers(directions, strong = true) {
  return questions.map((question) => {
    let score = 0;
    for (const [axis, direction] of Object.entries(directions)) score += (question.personality?.[axis] ?? 0) * direction;
    if (score > 0.3) return strong ? 5 : 4;
    if (score < -0.3) return strong ? 1 : 2;
    return 3;
  });
}

const fill = (value) => questions.map(() => value);
export const PATTERNS = [
  ['全部1', fill(1)],
  ['全部2', fill(2)],
  ['全部3', fill(3)],
  ['全部4', fill(4)],
  ['全部5', fill(5)],
  ['1/5交互', questions.map((q, i) => (i % 2 ? 1 : 5))],
  ['2/4交互', questions.map((q, i) => (i % 2 ? 2 : 4))],
  ['主導性だけ極端', traitAnswers({ Initiative: 1 })],
  ['協働だけ極端', traitAnswers({ Cooperation: 1 })],
  ['熟達志向だけ極端', traitAnswers({ Mastery: 1 })],
  ['慎重＋計画型', traitAnswers({ RiskTolerance: -1, Planning: 1 })],
  ['主導＋リスク型', traitAnswers({ Initiative: 1, RiskTolerance: 1 })],
  ['主導＋リスク型（2/4だけで回答）', traitAnswers({ Initiative: 1, RiskTolerance: 1 }, false)],
  ['協働＋計画型', traitAnswers({ Cooperation: 1, Planning: 1 })],
  ['自己決定＋適応型', traitAnswers({ SelfReliance: 1, Adaptability: 1 })],
];

const axes = Object.fromEntries(model.personalityAxes.map((axis) => [axis.key, axis]));
for (const [name, answers] of PATTERNS) {
  const result = runDiagnosis(answers, data);
  const type = determinePersonalityType(result, data.personalityTypes, model);
  const comment = generateResultComment(result, result.top[0], data);
  const traits = personalityAxisKeys(model)
    .map((key) => ({ key, value: result.personality[key] }))
    .filter((item) => Math.abs(item.value - 50) >= 10)
    .map((item) => `${item.value >= 50 ? axes[item.key].highLabel : axes[item.key].lowLabel}${Math.round(item.value)}`);
  console.log(`\n■ ${name}（回答の強さ ${result.responseStyle.extremity.toFixed(2)} → 補正 ×${result.responseStyle.scale.toFixed(2)}）`);
  console.log(`  気質: ${traits.join(' / ') || 'すべて中央付近'}　タイプ: ${type.name}`);
  console.log(
    `  TOP5: ${result.top
      .map((entry) => `${entry.profile.pokemon}${entry.profile.profileName === '共通' ? '' : `(${entry.profile.profileName})`}[${entry.profile.primaryArchetype}] ${entry.displayScore}`)
      .join(' / ')}`,
  );
  console.log(`  一致した傾向: ${comment.sharedLabels.join('・')}`);
  console.log(`  合う理由: ${comment.matchText}`);
  console.log(`  持ち味: ${(result.top[0].profile.styleKeywords ?? []).join('・')}`);
}
