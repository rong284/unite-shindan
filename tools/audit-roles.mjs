/**
 * ロール別の出やすさの監査（データは書き換えない）。
 *
 *   node tools/audit-roles.mjs
 *
 * 1. OfficialRole ごとの ポケモン数・Profile数・Top1率・Top3率・1体あたりの率
 * 2. 原因の切り分け（その場で計算を変えて比べるだけ。data/*.json は変更しない）
 *      現行 / Percentileだけで順位 / RawMatchだけで順位 / RankBias=0
 * 3. 密集度: 各Profileに最も近い他Profileまでの距離（似た型が多いほど1位を分け合う）
 * 4. スピード型: ユーザー15軸の分布と、各スピード型Profileの軸の値・届く人の割合・誤差の内訳
 *
 * 疑似回答者は tools/calibrate-model.mjs の監査と同じ母集団（tuning.calibration.auditSeed）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyTuning,
  calculateMatch,
  gameAxisKeys,
  matchingConfig,
  personalityAxisKeys,
  runDiagnosis,
} from '../js/model.js';
import { samplePopulation } from './lib/population.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));

const tuning = read('data/tuning.json');
const { model, profiles } = applyTuning(
  { model: read('data/model.json'), profiles: read('data/profiles.json').profiles },
  tuning,
);
const questions = read('data/questions.json').questions;
const roster = read('data/roster.json');
const data = { questions, model, profiles };
const axes = gameAxisKeys(model);
const ROLES = roster.roles.map((role) => role.key);
const SPEED = 'スピード型';

const samples = tuning.calibration?.auditSamples ?? 7000;
const people = samplePopulation(questions, personalityAxisKeys(model), samples, tuning.calibration?.auditSeed ?? 20261003);

const pct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
const pad = (text, width) => {
  const visible = [...String(text)].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0xff ? 2 : 1), 0);
  return String(text) + ' '.repeat(Math.max(0, width - visible));
};

// --- 診断を1回だけ回して、順位の付け替えに必要な値を持っておく --------------------
const runs = people.map((person) => {
  const result = runDiagnosis(person.answers, data, { topCount: 3 });
  return {
    finalAxes: result.finalAxes,
    top3: result.top.map((entry) => entry.profile),
    scored: result.ranked.map((entry) => ({
      profile: entry.profile,
      percentile: entry.percentile,
      rawMatch: entry.rawMatch,
      rankBias: entry.rankBias,
      rankScore: entry.rankScore,
    })),
  };
});

// 1位のポケモン（同じポケモンの別型はまとめる）を、指定の点数で選び直す
function topRoleBy(scoreOf) {
  const counts = Object.fromEntries(ROLES.map((role) => [role, 0]));
  for (const run of runs) {
    let best = null;
    let bestScore = -Infinity;
    for (const entry of run.scored) {
      const score = scoreOf(entry);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    counts[best.profile.officialRole] += 1;
  }
  return counts;
}

// --- 1. ロール別の出現率 --------------------------------------------------------
const pokemonCount = Object.fromEntries(roster.roles.map((role) => [role.key, role.count]));
const profileCount = Object.fromEntries(ROLES.map((role) => [role, profiles.filter((p) => p.officialRole === role).length]));
const top1 = Object.fromEntries(ROLES.map((role) => [role, 0]));
const top3Any = Object.fromEntries(ROLES.map((role) => [role, 0]));
const top3Slots = Object.fromEntries(ROLES.map((role) => [role, 0]));
for (const run of runs) {
  top1[run.top3[0].officialRole] += 1;
  const roles = run.top3.map((profile) => profile.officialRole);
  for (const role of roles) top3Slots[role] += 1;
  for (const role of new Set(roles)) top3Any[role] += 1;
}

console.log(`\n■ 1. ロール別（疑似回答 ${samples}人・回答スタイル混合・現行の計算）`);
console.log('  Top1率 = そのロールが1位の人の割合 / Top3率 = TOP3の枠に占める割合 / 含有率 = TOP3に1体以上入る人の割合');
console.log(`  ${pad('ロール', 14)}${pad('体数', 6)}${pad('型数', 6)}${pad('体数比', 8)}${pad('Top1率', 9)}${pad('Top3率', 9)}${pad('含有率', 9)}${pad('1体あたりTop1', 15)}${pad('1体あたりTop3', 15)}${'Top1/体数比'}`);
for (const role of ROLES) {
  const share = pokemonCount[role] / roster.pokemon.length;
  const t1 = top1[role] / samples;
  const t3 = top3Slots[role] / (samples * 3);
  console.log(
    `  ${pad(role, 14)}${pad(pokemonCount[role], 6)}${pad(profileCount[role], 6)}${pad(pct(share, 0), 8)}${pad(pct(t1), 9)}${pad(pct(t3), 9)}${pad(pct(top3Any[role] / samples), 9)}` +
      `${pad(pct(t1 / pokemonCount[role], 2), 15)}${pad(pct(t3 / pokemonCount[role], 2), 15)}${(t1 / share).toFixed(2)}倍`,
  );
}

// --- 2. 原因の切り分け ----------------------------------------------------------
const weight = model.matchModel?.rankPercentileWeight ?? 0.8;
const variants = {
  現行: (entry) => entry.rankScore,
  'Percentileだけ': (entry) => entry.percentile,
  'RawMatchだけ': (entry) => entry.rawMatch,
  'RankBias=0': (entry) => weight * entry.percentile * 100 + (1 - weight) * entry.rawMatch,
};
console.log(`\n■ 2. 原因の切り分け（1位のロール割合。RankScore = ${weight}×Percentile×100 + ${(1 - weight).toFixed(1)}×RawMatch + RankBias）`);
console.log(`  ${pad('順位の付け方', 18)}${ROLES.map((role) => pad(role, 14)).join('')}`);
for (const [name, scoreOf] of Object.entries(variants)) {
  const counts = topRoleBy(scoreOf);
  console.log(`  ${pad(name, 18)}${ROLES.map((role) => pad(pct(counts[role] / samples), 14)).join('')}`);
}

// RawMatch の水準（ロール別の平均・上位1%）。Percentile は型ごとに揃えてあるので、差が出るのは RawMatch 側
console.log('\n  RawMatch の水準（全員に対する平均 / その型に最も合う上位1%の平均）');
const rawByProfile = new Map(profiles.map((profile) => [profile.id, []]));
for (const run of runs) for (const entry of run.scored) rawByProfile.get(entry.profile.id).push(entry.rawMatch);
for (const role of ROLES) {
  const ids = profiles.filter((p) => p.officialRole === role).map((p) => p.id);
  let mean = 0;
  let topMean = 0;
  for (const id of ids) {
    const values = rawByProfile.get(id).sort((a, b) => a - b);
    mean += values.reduce((sum, value) => sum + value, 0) / values.length;
    const top = values.slice(Math.floor(values.length * 0.99));
    topMean += top.reduce((sum, value) => sum + value, 0) / top.length;
  }
  console.log(`  ${pad(role, 14)} 平均 ${(mean / ids.length).toFixed(1)} / 上位1% ${(topMean / ids.length).toFixed(1)}`);
}

// --- 3. 密集度 ------------------------------------------------------------------
const weightOf = Object.fromEntries(axes.map((axis) => [axis, matchingConfig(model, axis).weight]));
const weightTotal = axes.reduce((sum, axis) => sum + weightOf[axis], 0);
const distance = (a, b) =>
  Math.sqrt(axes.reduce((sum, axis) => sum + weightOf[axis] * (a.axes[axis] - b.axes[axis]) ** 2, 0) / weightTotal);
console.log('\n■ 3. 密集度（各型から最も近い「別ポケモンの型」までの重み付き距離。小さいほど似た型と1位を分け合う）');
for (const role of ROLES) {
  const own = profiles.filter((p) => p.officialRole === role);
  const nearest = own.map((profile) => {
    let best = Infinity;
    let neighbor = null;
    for (const other of profiles) {
      if (other.pokemon === profile.pokemon) continue;
      const d = distance(profile, other);
      if (d < best) {
        best = d;
        neighbor = other;
      }
    }
    return { profile, best, neighbor };
  });
  const values = nearest.map((item) => item.best).sort((a, b) => a - b);
  const otherRole = nearest.filter((item) => item.neighbor.officialRole !== role).length;
  const within10 = own.map((profile) => profiles.filter((o) => o.pokemon !== profile.pokemon && distance(profile, o) < 10).length);
  console.log(
    `  ${pad(role, 14)} 最近傍距離 中央値 ${quantile(values, 0.5).toFixed(1)}（最小 ${values[0].toFixed(1)}）` +
      ` / 距離10未満の型 平均 ${(within10.reduce((s, v) => s + v, 0) / own.length).toFixed(1)}件 / 最近傍が他ロール ${otherRole}/${own.length}`,
  );
}

// --- 4. スピード型の切り分け ------------------------------------------------------
console.log('\n■ 4. スピード型: ユーザー15軸の分布と、スピード型Profileの値');
const userValues = Object.fromEntries(axes.map((axis) => [axis, runs.map((run) => run.finalAxes[axis]).sort((a, b) => a - b)]));
const speedProfiles = profiles.filter((p) => p.officialRole === SPEED);
const speedMean = Object.fromEntries(axes.map((axis) => [axis, speedProfiles.reduce((s, p) => s + p.axes[axis], 0) / speedProfiles.length]));
const allMean = Object.fromEntries(axes.map((axis) => [axis, profiles.reduce((s, p) => s + p.axes[axis], 0) / profiles.length]));
console.log(`  ${pad('軸', 18)}${pad('Weight', 8)}${pad('OverReq', 9)}${pad('ユーザー p1/p5/p50/p95/p99', 30)}${pad('スピード型平均', 16)}${pad('全型平均', 10)}スピード型平均以上のユーザー`);
for (const axis of axes) {
  const values = userValues[axis];
  const { weight: w, overReqPenalty } = matchingConfig(model, axis);
  const q = [0.01, 0.05, 0.5, 0.95, 0.99].map((p) => quantile(values, p).toFixed(0)).join('/');
  const reach = values.filter((value) => (speedMean[axis] >= 50 ? value >= speedMean[axis] : value <= speedMean[axis])).length / values.length;
  console.log(
    `  ${pad(axis, 18)}${pad(w, 8)}${pad(overReqPenalty, 9)}${pad(q, 30)}${pad(speedMean[axis].toFixed(0), 16)}${pad(allMean[axis].toFixed(0), 10)}${pct(reach)}`,
  );
}

// 各型について、その型に最も合う上位1%のユーザーとの誤差を軸別に分解する
function errorBreakdown(profile) {
  const ranked = runs
    .map((run) => ({ run, raw: run.scored.find((entry) => entry.profile.id === profile.id).rawMatch }))
    .sort((a, b) => b.raw - a.raw)
    .slice(0, Math.max(1, Math.floor(samples * 0.01)));
  const totals = Object.fromEntries(axes.map((axis) => [axis, { error: 0, over: 0 }]));
  let sumError = 0;
  let rmse = 0;
  for (const { run } of ranked) {
    const match = calculateMatch(run.finalAxes, profile, model);
    rmse += match.rmse;
    for (const axis of axes) {
      const detail = match.axisErrors[axis];
      totals[axis].error += detail.error;
      if (detail.overRequirement) totals[axis].over += detail.error - detail.error / detail.penalty;
      sumError += detail.error;
    }
  }
  const overShare = axes.reduce((sum, axis) => sum + totals[axis].over, 0) / sumError;
  const worst = axes
    .map((axis) => ({ axis, share: totals[axis].error / sumError, value: profile.axes[axis] }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 3);
  return { rmse: rmse / ranked.length, overShare, worst };
}

console.log('\n  その型に最も合う上位1%のユーザーとの誤差（RMSE）と、誤差の大きい軸（型の値 / 誤差に占める割合）');
console.log('  OverReq分 = 型の値がユーザーを上回っているために上乗せされた誤差の割合');
const summary = {};
for (const role of ROLES) {
  const list = profiles.filter((p) => p.officialRole === role).map((profile) => ({ profile, ...errorBreakdown(profile) }));
  summary[role] = list;
  const meanRmse = list.reduce((s, item) => s + item.rmse, 0) / list.length;
  const meanOver = list.reduce((s, item) => s + item.overShare, 0) / list.length;
  console.log(`  [${role}] 平均RMSE ${meanRmse.toFixed(1)} / OverReq分 ${pct(meanOver, 0)}`);
}
console.log('\n  スピード型の各Profile');
for (const item of summary[SPEED].sort((a, b) => b.rmse - a.rmse)) {
  const worst = item.worst.map((w) => `${w.axis}=${w.value}（${pct(w.share, 0)}）`).join(' ');
  console.log(`  ${pad(item.profile.id, 22)} RMSE ${item.rmse.toFixed(1)} / OverReq分 ${pct(item.overShare, 0)} / ${worst}`);
}

// ユーザー側の値を、スピード型の値まで届かせたらどうなるか（軸レンジ不足の確認）
console.log('\n  参考: スピード型の各Profileの値を、ユーザー分布の p1〜p99 に収めた場合の上位1%RMSE（型の尖りの影響）');
for (const profile of speedProfiles) {
  const clipped = {
    ...profile,
    axes: Object.fromEntries(
      axes.map((axis) => [axis, Math.min(quantile(userValues[axis], 0.99), Math.max(quantile(userValues[axis], 0.01), profile.axes[axis]))]),
    ),
  };
  const original = errorBreakdown(profile).rmse;
  const after = errorBreakdown(clipped).rmse;
  console.log(`  ${pad(profile.id, 22)} ${original.toFixed(1)} → ${after.toFixed(1)}`);
}

// --- 5. スピード型が合う人を、誰が1位で持っていくか ---------------------------------
console.log('\n■ 5. スピード型Profileの Percentile が上位1%の人で、実際に1位になったロール・型');
const percentileRank = (run, id) => run.scored.find((entry) => entry.profile.id === id).percentile;
const stolen = new Map();
let fans = 0;
let kept = 0;
for (const profile of speedProfiles) {
  const users = runs.filter((run) => percentileRank(run, profile.id) >= 0.99);
  for (const run of users) {
    fans += 1;
    const winner = run.top3[0];
    if (winner.officialRole === SPEED) kept += 1;
    const key = `${winner.officialRole} ${winner.id}`;
    stolen.set(key, (stolen.get(key) ?? 0) + 1);
  }
}
console.log(`  延べ ${fans}人のうち、スピード型が1位: ${pct(kept / fans)}`);
for (const [key, count] of [...stolen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${pad(key, 34)} ${pct(count / fans)}`);
}

// --- 6. ユーザー側の軸の結びつき（スピード型の「踏み込む × 前線に立たない」が同時に出るか） --
console.log('\n■ 6. ユーザー15軸の相関（スピード型の特徴の組み合わせ）');
const corr = (a, b) => {
  const xs = runs.map((run) => run.finalAxes[a]);
  const ys = runs.map((run) => run.finalAxes[b]);
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
};
for (const [a, b] of [['Dive', 'Frontline'], ['Mobility', 'Frontline'], ['Dive', 'Peel'], ['Dive', 'Mobility'], ['Dive', 'Poke'], ['Mobility', 'ScoringSide'], ['Peel', 'Frontline'], ['Support', 'Peel']]) {
  console.log(`  ${pad(`${a} × ${b}`, 28)} r = ${corr(a, b).toFixed(2)}`);
}
const both = (conds) => runs.filter((run) => conds.every(([axis, op, v]) => (op === '>=' ? run.finalAxes[axis] >= v : run.finalAxes[axis] <= v))).length / runs.length;
console.log(`  Dive≥70 の人: ${pct(both([['Dive', '>=', 70]]))} / そのうち Frontline≤35: ${pct(both([['Dive', '>=', 70], ['Frontline', '<=', 35]]) / both([['Dive', '>=', 70]]))}`);
console.log(`  Dive≥70 かつ Mobility≥70 かつ Frontline≤40: ${pct(both([['Dive', '>=', 70], ['Mobility', '>=', 70], ['Frontline', '<=', 40]]), 2)}`);
console.log(`  Frontline≥65 の人: ${pct(both([['Frontline', '>=', 65]]))} / Peel≥65: ${pct(both([['Peel', '>=', 65]]))} / Support≥65: ${pct(both([['Support', '>=', 65]]))}`);
