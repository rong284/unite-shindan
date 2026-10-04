/**
 * 7→15 翻訳係数などの候補を、データを書き換えずに比べる。
 *
 *   node tools/compare-models.mjs candidates.json
 *   node tools/compare-models.mjs              # 候補なし: サイトの現在のデータ（profiles.json の Percentile・RankBias）をそのまま評価
 *
 * candidates.json: [{ "name": "案A", "translation": { "Dive": { "Initiative": 0.25, ... }, ... },
 *                     "preferenceBlend": { "Dive": 0.2 },
 *                     "profiles": { "アブソル-1": { "Frontline": 15 } } }, ...]
 *   profiles はプロファイルの15軸の値を、その候補の中でだけ置き換える。
 *   translation は軸ごとに係数をまるごと置き換える（書いていない軸は現行のまま）。
 *   先頭に「現行」が自動で入る。
 *
 * 比べ方（すべての候補で同じ条件にする）:
 *   - Percentile の分位点は候補ごとに、その場で作り直す（calibrationSamples 件のかわりに FIT_SAMPLES 件）
 *   - RankBias は 0（係数が決まってから最後にまとめて作り直すため）
 *   - 評価は別の母集団（tuning.calibration.auditSeed）
 *
 * 出力: 段階別（翻訳のみ / 嗜好のみ / Blend後）の Dive×Frontline・Peel×Support、ロール別 Top1/Top3、
 *       ポケモン別Top1最大、Top3未出現数、1位の DisplayScore 分布、ロールごとの「1位にできる回答」の探索結果
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyTuning, personalityAxisKeys, selectTopPokemon } from '../js/model.js';
import { buildModel, fitProfiles, rankAll, stagesOf } from './lib/candidate.mjs';
import { createRng, samplePopulation } from './lib/population.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const FIT_SAMPLES = 8000;
const FIT_SEED = 20261001;

const tuning = read('data/tuning.json');
const base = applyTuning({ model: read('data/model.json'), profiles: read('data/profiles.json').profiles }, tuning);
const questions = read('data/questions.json').questions;
const roster = read('data/roster.json');
const ROLES = roster.roles.map((role) => role.key);
const candidates = process.argv[2]
  ? [{ name: '現行' }, ...JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))]
  : [{ name: 'サイトの現在のデータ（作り直しなし）', site: true }];
// サイトの現在のデータ = Excel から書き出した profiles.json の Percentile・RankBias
const siteProfiles = base.profiles;

const personalityKeys = personalityAxisKeys(base.model);
const fitPeople = samplePopulation(questions, personalityKeys, FIT_SAMPLES, FIT_SEED);
const auditPeople = samplePopulation(questions, personalityKeys, tuning.calibration.auditSamples, tuning.calibration.auditSeed);

const stages = (answers, model) => stagesOf(answers, questions, model);
const rank = rankAll;

const quantile = (sorted, p) => sorted[Math.round(p * (sorted.length - 1))];
function corr(xs, ys) {
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i] - my);
    sxx += (x - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  });
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

// 対象（ロール、または1つのプロファイル）の最上位と、それ以外の最上位の RankScore の差を、
// 回答を1問ずつ変えて最大化する。差が正なら「その対象を1位にする回答」が存在する
function reach(isTarget, profiles, model, isRival = (entry) => !isTarget(entry)) {
  const rng = createRng(4242);
  let best = { margin: -Infinity };
  const marginOf = (answers) => {
    const ranked = rank(stages(answers, model).final, profiles, model);
    const top = ranked.find(isTarget);
    const other = ranked.find(isRival);
    return { margin: top.rankScore - other.rankScore, top, answers: [...answers] };
  };
  for (let restart = 0; restart < 4; restart += 1) {
    let answers = questions.map(() => 1 + Math.floor(rng() * 5));
    let current = marginOf(answers);
    for (let sweep = 0; sweep < 3; sweep += 1) {
      let improved = false;
      for (let q = 0; q < questions.length; q += 1) {
        for (let value = 1; value <= 5; value += 1) {
          if (value === answers[q]) continue;
          const trial = [...answers];
          trial[q] = value;
          const result = marginOf(trial);
          if (result.margin > current.margin) {
            current = result;
            answers = trial;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    if (current.margin > best.margin) best = current;
  }
  return best;
}

const pct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const rows = [];
for (const candidate of candidates) {
  const started = Date.now();
  const model = buildModel(base.model, candidate);
  const profiles = candidate.site ? siteProfiles : fitProfiles(base.profiles, model, questions, fitPeople, candidate.profiles);

  // 段階別の軸の結びつき
  const stageData = { translated: {}, preference: {}, final: {} };
  const finalAll = {};
  for (const person of auditPeople) {
    const s = stages(person.answers, model);
    for (const [axis, value] of Object.entries(s.final)) (finalAll[axis] ??= []).push(value);
    for (const stage of Object.keys(stageData)) {
      for (const axis of ['Dive', 'Frontline', 'Peel', 'Support']) (stageData[stage][axis] ??= []).push(s[stage][axis]);
    }
  }

  const top1 = Object.fromEntries(ROLES.map((role) => [role, 0]));
  const top3 = Object.fromEntries(ROLES.map((role) => [role, 0]));
  const pokemonTop1 = new Map();
  const seenTop3 = new Set();
  const display = [];
  for (const person of auditPeople) {
    const ranked = rank(stages(person.answers, model).final, profiles, model);
    const top = selectTopPokemon(ranked, 3, { archetypePenalty: model.topDiversity?.archetypePenalty ?? 0 });
    top1[top[0].profile.officialRole] += 1;
    top.forEach((entry) => {
      top3[entry.profile.officialRole] += 1;
      seenTop3.add(entry.profile.pokemon);
    });
    pokemonTop1.set(top[0].profile.pokemon, (pokemonTop1.get(top[0].profile.pokemon) ?? 0) + 1);
    display.push(top[0].displayScore);
  }
  display.sort((a, b) => a - b);
  const [maxPokemon, maxCount] = [...pokemonTop1.entries()].sort((a, b) => b[1] - a[1])[0];
  const reachRoles = Object.fromEntries(
    ROLES.map((role) => [role, reach((entry) => entry.profile.officialRole === role, profiles, model)]),
  );
  // スピード型は型ごとに、別ポケモンより上に来る回答があるかを見る
  // サイトの現在のデータを評価するときは全プロファイル、候補比較のときはスピード型だけ
  const reachSpeed = profiles
    .filter((profile) => candidate.site || profile.officialRole === 'スピード型')
    .map((target) => reach((entry) => entry.profile.id === target.id, profiles, model, (entry) => entry.profile.pokemon !== target.pokemon));
  rows.push({ candidate, finalAll, stageData, top1, top3, maxPokemon, maxCount, unseen: roster.pokemon.map((entry) => entry.name).filter((name) => !seenTop3.has(name)), display, reach: reachRoles, reachSpeed, seconds: (Date.now() - started) / 1000 });
}

const n = auditPeople.length;
for (const row of rows) {
  console.log(`\n================ ${row.candidate.name}（${row.seconds.toFixed(0)}秒）`);
  for (const [a, b] of [['Dive', 'Frontline'], ['Peel', 'Support']]) {
    console.log(`  ${a}×${b}`);
    for (const stage of ['translated', 'preference', 'final']) {
      const xs = row.stageData[stage][a];
      const ys = row.stageData[stage][b];
      const q = (values) => {
        const sorted = [...values].sort((x, y) => x - y);
        return [0.01, 0.1, 0.5, 0.9, 0.99].map((p) => quantile(sorted, p).toFixed(0)).join('/');
      };
      const joint =
        a === 'Dive'
          ? xs.filter((x, i) => x >= 70 && ys[i] <= 35).length / xs.length
          : xs.filter((x, i) => x >= 65 && ys[i] <= 35).length / xs.length;
      const jointReverse = a === 'Peel' ? ys.filter((y, i) => y >= 65 && xs[i] <= 35).length / xs.length : null;
      const label = { translated: '翻訳のみ', preference: '嗜好のみ', final: 'Blend後' }[stage];
      console.log(
        `    ${label.padEnd(5, '　')} r=${corr(xs, ys).toFixed(2).padStart(5)}  ${a} p1/p10/p50/p90/p99=${q(xs).padEnd(16)} ${b}=${q(ys).padEnd(16)}` +
          (a === 'Dive' ? ` Dive≥70かつFrontline≤35=${pct(joint, 2)}` : ` Peel≥65かつSupport≤35=${pct(joint, 2)} / 逆=${pct(jointReverse, 2)}`),
      );
    }
  }
  console.log(`  ロール別  ${ROLES.map((role) => `${role} Top1 ${pct(row.top1[role] / n)} / Top3 ${pct(row.top3[role] / (n * 3))}`).join('\n            ')}`);
  console.log(`  ポケモン別Top1最大: ${row.maxPokemon} ${pct(row.maxCount / n)} / Top3未出現: ${row.unseen.length}体${row.unseen.length ? `（${row.unseen.join('・')}）` : ''}`);
  console.log('  最終15軸 p1/p10/p50/p90/p99: ' + Object.entries(row.finalAll).map(([axis, values]) => {
    const sorted = [...values].sort((x, y) => x - y);
    return `${axis} ${[0.01, 0.1, 0.5, 0.9, 0.99].map((p) => quantile(sorted, p).toFixed(0)).join('/')}`;
  }).join(' | '));
  console.log(`  1位のDisplayScore p10/p50/p90: ${[0.1, 0.5, 0.9].map((p) => quantile(row.display, p)).join('/')}`);
  console.log(`  1位にできる回答の探索（ロール最上位と他ロール最上位のRankScore差・そのときの1位）:`);
  for (const role of ROLES) {
    const item = row.reach[role];
    console.log(`    ${role.padEnd(7, '　')} 差 ${item.margin.toFixed(1).padStart(6)} → ${item.top.profile.id}（Display ${item.top.displayScore}）${item.margin > 0 ? '' : ' ※到達できず'}`);
  }
  const reached = row.reachSpeed.filter((item) => item.margin > 0);
  console.log(`  ${row.candidate.site ? '全プロファイル' : 'スピード型'}の各型を1位にできる回答: ${reached.length}/${row.reachSpeed.length}型`);
  if (row.candidate.site) {
    for (const role of ROLES) {
      const list = row.reachSpeed.filter((item) => item.top.profile.officialRole === role);
      console.log(`    ${role} ${list.filter((item) => item.margin > 0).length}/${list.length}`);
    }
    const missed = row.reachSpeed.filter((item) => item.margin <= 0);
    console.log(`    1位にできなかった型: ${missed.length ? missed.map((item) => `${item.top.profile.id}（差 ${item.margin.toFixed(1)}）`).join(' / ') : 'なし'}`);
    continue;
  }
  console.log('    ' + row.reachSpeed.map((item) => `${item.top.profile.id} ${item.margin > 0 ? '○' : '×'}${item.margin.toFixed(1)}（Display ${item.top.displayScore}）`).join(' / '));
}
