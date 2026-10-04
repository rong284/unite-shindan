/**
 * 診断エンジンのテスト。
 *
 *   node tests/run-tests.mjs
 *
 * 外部ライブラリは使わない。data/*.json と、Excelの Simulator / Match_140 の計算結果
 * （tools/export_excel.py が出力する tests/fixtures/excel_baseline.json）を突き合わせる。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  calculateFinalAxes,
  calculateMatch,
  calculatePersonality,
  calculatePreferences,
  gameAxisKeys,
  groupByPokemon,
  personalityAxisKeys,
  rankProfiles,
  runDiagnosis,
  translateToGameplay,
  applyTuning,
  responseStyle,
} from '../js/model.js';
import { createRng, samplePopulation, sameTraitsAllStyles } from '../tools/lib/population.mjs';
import {
  determinePersonalityType,
  generateResultComment,
  hasMoveset,
  profileDisplayName,
  politeProfileComment,
  applyDisplayLabels,
  heroMessage,
  isReferenceResult,
  profileStyleLabel,
  buildCandidateItems,
} from '../js/comment.js';
import { buildDiagnosisShareText, buildRandomShareText, decodeAnswers, encodeAnswers } from '../js/share.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));

const excelModel = read('data/model.json');
const questionsFile = read('data/questions.json');
const profilesFile = read('data/profiles.json');
const tuning = read('data/tuning.json');
// Percentile・RankBias の作り直し結果（tools/calibrate-model.mjs → tools/excel_patch.py で Excel へ書き戻したもの）
const calibrationOutput = read('excel-handoff/calibration.json');
const rosterFile = read('data/roster.json');
const comments = read('data/comments.json');
const personalityTypes = read('data/personality-types.json');
const display = read('data/display.json');
const baseline = read('tests/fixtures/excel_baseline.json');
const excelCases = read('tests/fixtures/excel_cases.json');

const questions = questionsFile.questions;
const excelProfiles = profilesFile.profiles;
// Excel そのままの計算（Excel Simulator との突き合わせ用）
const excelData = { questions, model: excelModel, profiles: excelProfiles };
// サイトで実際に使う計算（回答スタイル補正＋サイト側で作り直した Percentile / RankBias）
const { model, profiles } = applyDisplayLabels(
  applyTuning({ model: excelModel, profiles: excelProfiles }, tuning),
  read('data/comments.json'),
);
const data = { questions, model, profiles };
const population = (n, seed) => samplePopulation(questions, personalityAxisKeys(model), n, seed);

let passed = 0;
const failures = [];

const pending = [];

function test(name, fn) {
  const pass = () => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  };
  const fail = (error) => {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  };
  try {
    const outcome = fn();
    // 非同期のテストは最後にまとめて待つ
    if (outcome && typeof outcome.then === 'function') pending.push(outcome.then(pass, fail));
    else pass();
  } catch (error) {
    fail(error);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertClose(actual, expected, tolerance, message) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message}: 期待 ${expected}（±${tolerance}）に対して ${actual}`,
  );
}

const fill = (value) => questions.map(() => value);
const randomAnswers = (seedStart = 1) => {
  // 乱数は固定シードの線形合同法で作り、失敗を再現できるようにする
  let seed = seedStart;
  return questions.map(() => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return 1 + (Math.floor(seed / 65536) % 5);
  });
};

console.log('\n■ データ件数（Excelとの一致）');

test('JSONのポケモン数・プロファイル数・質問数がExcelと一致する', () => {
  assert(rosterFile.pokemon.length === baseline.counts.roster, 'ロスター件数が一致しない');
  assert(profiles.length === baseline.counts.profiles, 'プロファイル件数が一致しない');
  assert(questions.length === baseline.counts.questions, '質問数が一致しない');
  assert(model.personalityAxes.length === baseline.counts.personalityAxes, '性格軸数が一致しない');
  assert(model.gameAxes.length === baseline.counts.gameAxes, 'ゲーム軸数が一致しない');
});

test('ロスターのProfileCountとProfiles_140の件数が整合する', () => {
  const counts = new Map();
  for (const profile of profiles) {
    counts.set(profile.pokemon, (counts.get(profile.pokemon) ?? 0) + 1);
  }
  for (const entry of rosterFile.pokemon) {
    assert(
      counts.get(entry.name) === entry.profileCount,
      `${entry.name}: ProfileCount=${entry.profileCount} / 実際=${counts.get(entry.name)}`,
    );
  }
});

test('すべての軸にWeight・OverReqPenalty・PreferenceBlendがある', () => {
  for (const axis of gameAxisKeys(model)) {
    const config = model.matching[axis];
    assert(config, `${axis} のマッチング設定が無い`);
    assert(typeof config.weight === 'number', `${axis} のWeightが数値でない`);
    assert(typeof config.overReqPenalty === 'number', `${axis} のOverReqPenaltyが数値でない`);
    assert(typeof config.preferenceBlend === 'number', `${axis} のPreferenceBlendが数値でない`);
    assert(model.translation[axis], `${axis} の翻訳係数が無い`);
  }
});

console.log('\n■ 性格・ゲーム軸の計算');

test('全回答3なら性格7軸は50付近になる', () => {
  const personality = calculatePersonality(fill(3), questions, model);
  for (const axis of personalityAxisKeys(model)) {
    assertClose(personality[axis], 50, 0.001, `${axis} が50でない`);
  }
});

test('全回答1・5でも性格7軸が0〜100に収まる', () => {
  for (const value of [1, 5]) {
    const personality = calculatePersonality(fill(value), questions, model);
    for (const axis of personalityAxisKeys(model)) {
      assert(
        personality[axis] >= 0 && personality[axis] <= 100,
        `回答${value}: ${axis} が範囲外 (${personality[axis]})`,
      );
    }
  }
});

test('最終15軸が0〜100を超えない（極端な回答・ランダム回答）', () => {
  const cases = [fill(1), fill(3), fill(5), randomAnswers(7), randomAnswers(99)];
  for (const answers of cases) {
    const personality = calculatePersonality(answers, questions, model);
    const finalAxes = calculateFinalAxes(
      translateToGameplay(personality, model),
      calculatePreferences(answers, questions, model),
      model,
    );
    for (const axis of gameAxisKeys(model)) {
      assert(
        finalAxes[axis] >= 0 && finalAxes[axis] <= 100,
        `${axis} が範囲外 (${finalAxes[axis]})`,
      );
    }
  }
});

test('未回答（null）が混ざっても中立として計算でき、例外にならない', () => {
  const answers = fill(3).map((value, index) => (index % 3 === 0 ? null : value));
  const result = runDiagnosis(answers, data, { topCount: 3 });
  assert(result.top.length === 3, 'TOP3が出ていない');
  assert(result.answeredCount === answers.filter((v) => v !== null).length, '回答数の集計が違う');
});

console.log('\n■ マッチング');

test('RawMatch・DisplayScoreが0〜100、Percentileが0〜1に収まる（全プロファイル×複数回答パターン）', () => {
  const { displayMin } = model.matchModel;
  for (const answers of [fill(1), fill(3), fill(5), randomAnswers(3)]) {
    const result = runDiagnosis(answers, data, { topCount: 3 });
    for (const entry of result.ranked) {
      assert(entry.rawMatch >= 0 && entry.rawMatch <= 100, `${entry.profile.id} のRawMatchが範囲外 (${entry.rawMatch})`);
      assert(entry.percentile >= 0 && entry.percentile <= 1, `${entry.profile.id} のPercentileが範囲外 (${entry.percentile})`);
      assert(
        Number.isInteger(entry.displayScore) && entry.displayScore >= displayMin && entry.displayScore <= 100,
        `${entry.profile.id} のDisplayScoreが範囲外 (${entry.displayScore})`,
      );
    }
  }
});

test('順位は RankScore の降順で決まる（表示は DisplayScore）', () => {
  const result = runDiagnosis(randomAnswers(17), data);
  for (let i = 1; i < result.ranked.length; i += 1) {
    assert(result.ranked[i - 1].rankScore >= result.ranked[i].rankScore, `${i}位と${i + 1}位の並びが RankScore 順でない`);
  }
});

test('全プロファイルに Percentile の分位点（101個・昇順）がある', () => {
  for (const profile of profiles) {
    const quantiles = profile.percentile?.quantiles ?? [];
    assert(quantiles.length === 101, `${profile.id}: 分位点が ${quantiles.length} 個`);
    assert(quantiles.every((value, index) => index === 0 || value >= quantiles[index - 1]), `${profile.id}: 分位点が昇順でない`);
  }
});

test('全プロファイルが計算対象になる', () => {
  const result = runDiagnosis(fill(4), data, { topCount: 3 });
  assert(result.ranked.length === profiles.length, `計算件数 ${result.ranked.length}`);
  const ids = new Set(result.ranked.map((entry) => entry.profile.id));
  assert(ids.size === profiles.length, 'ProfileIDが重複している');
});

test('要求値がプレイヤーを上回るときだけOverReqPenaltyが効く', () => {
  const axis = gameAxisKeys(model).find((key) => model.matching[key].overReqPenalty > 0);
  assert(axis, 'OverReqPenaltyが設定された軸が無い');
  const penalty = model.matching[axis].overReqPenalty;
  const player = Object.fromEntries(gameAxisKeys(model).map((key) => [key, 50]));
  const makeProfile = (value) => ({
    id: 'test',
    pokemon: 'テスト',
    axes: Object.fromEntries(gameAxisKeys(model).map((key) => [key, key === axis ? value : 50])),
  });
  const over = calculateMatch(player, makeProfile(70), model).axisErrors[axis];
  const under = calculateMatch(player, makeProfile(30), model).axisErrors[axis];
  assertClose(over.penalty, 1 + penalty, 1e-9, '要求値超過時のペナルティ');
  assertClose(under.penalty, 1, 1e-9, '要求値以下のペナルティ');
  assert(over.error > under.error, '同じ差なら超過側の誤差が大きくなるべき');
});

test('同点でも順位処理が壊れない', () => {
  const player = Object.fromEntries(gameAxisKeys(model).map((key) => [key, 50]));
  const cloneAxes = () => Object.fromEntries(gameAxisKeys(model).map((key) => [key, 60]));
  const tied = [
    { id: 'A-1', pokemon: 'A', officialRole: 'アタック型', profileName: 'x', axes: cloneAxes() },
    { id: 'B-1', pokemon: 'B', officialRole: 'アタック型', profileName: 'y', axes: cloneAxes() },
    { id: 'C-1', pokemon: 'C', officialRole: 'アタック型', profileName: 'z', axes: cloneAxes() },
  ];
  const ranked = rankProfiles(player, tied, model);
  assert(ranked.length === 3, '件数が合わない');
  assert(
    ranked.every((entry) => entry.rank === 1),
    '同点なら同順位（rank=1）になるべき',
  );
  assert(
    JSON.stringify(ranked.map((entry) => entry.position)) === '[1,2,3]',
    'positionは重複しない通し番号になるべき',
  );
  // 何度計算しても同じ並びになる（安定ソート）
  const again = rankProfiles(player, tied, model);
  assert(
    JSON.stringify(ranked.map((e) => e.profile.id)) === JSON.stringify(again.map((e) => e.profile.id)),
    '同点時の並びが安定していない',
  );
});

test('おすすめTOP5が同じアーキタイプだけで埋まりすぎない（疑似回答1,000件）', () => {
  let allSame = 0;
  let fourOrMore = 0;
  const people = population(1000, 8080);
  for (const person of people) {
    const archetypes = runDiagnosis(person.answers, data).top.map((entry) => entry.profile.primaryArchetype);
    const counts = Object.values(archetypes.reduce((map, key) => ({ ...map, [key]: (map[key] ?? 0) + 1 }), {}));
    if (Math.max(...counts) === archetypes.length) allSame += 1;
    if (Math.max(...counts) >= 4) fourOrMore += 1;
  }
  assert(allSame / people.length < 0.03, `5体すべて同じアーキタイプ: ${(allSame / people.length * 100).toFixed(1)}%`);
  assert(fourOrMore / people.length < 0.12, `4体以上が同じアーキタイプ: ${(fourOrMore / people.length * 100).toFixed(1)}%`);
});

test('同一ポケモンの別型がTOP3を独占しない', () => {
  const answerSets = [fill(1), fill(2), fill(3), fill(4), fill(5), randomAnswers(11), randomAnswers(23), randomAnswers(57)];
  for (const answers of answerSets) {
    const result = runDiagnosis(answers, data, { topCount: 3 });
    const names = result.top.map((entry) => entry.profile.pokemon);
    assert(new Set(names).size === names.length, `TOP3にポケモンの重複: ${names.join(', ')}`);
    // 代表型は、そのポケモンの中で最も順位の高い（RankScore が大きい）型であること
    for (const entry of result.top) {
      for (const alternate of entry.alternates) {
        assert(
          entry.rankScore >= alternate.rankScore,
          `${entry.profile.pokemon}: 代表型より高い別型がある`,
        );
      }
    }
  }
});

test('型が複数あるポケモンは alternates にまとめられる', () => {
  const result = runDiagnosis(fill(4), data, { topCount: 3 });
  const grouped = groupByPokemon(result.ranked);
  assert(grouped.length === new Set(profiles.map((p) => p.pokemon)).size, 'ポケモン数が合わない');
  const total = grouped.reduce((sum, entry) => sum + 1 + entry.alternates.length, 0);
  assert(total === profiles.length, `畳み込み後の合計が ${total}（${profiles.length}であるべき）`);
});

console.log('\n■ Excel Simulator との突き合わせ');

test('Excelと同じ回答なら性格7軸が一致する', () => {
  assert(baseline.answers.length === questions.length, 'Excelの回答数が質問数と違う');
  const personality = calculatePersonality(baseline.answers, questions, excelModel);
  for (const axis of personalityAxisKeys(model)) {
    assertClose(personality[axis], baseline.personality[axis], 0.01, `${axis}`);
  }
});

test('Excelと同じ回答なら翻訳15軸・嗜好15軸・最終15軸が一致する', () => {
  const personality = calculatePersonality(baseline.answers, questions, excelModel);
  const translated = translateToGameplay(personality, excelModel);
  const preference = calculatePreferences(baseline.answers, questions, excelModel);
  const finalAxes = calculateFinalAxes(translated, preference, excelModel);
  for (const axis of gameAxisKeys(model)) {
    assertClose(translated[axis], baseline.translated[axis], 0.01, `翻訳 ${axis}`);
    assertClose(preference[axis], baseline.preference[axis], 0.01, `嗜好 ${axis}`);
    assertClose(finalAxes[axis], baseline.final[axis], 0.01, `最終 ${axis}`);
  }
});

test('Excelと同じ回答なら上位10件の順位とスコア（Raw / Percentile / Display / Rank）が一致する', () => {
  const result = runDiagnosis(baseline.answers, excelData, { topCount: 3 });
  assert(result.profileCount === baseline.profileCount, 'プロファイル件数が違う');
  baseline.top.forEach((expected, index) => {
    const actual = result.ranked[index];
    assert(
      actual.profile.id === expected.profileId,
      `${index + 1}位: Excel=${expected.profileId} / Web=${actual.profile.id}`,
    );
    // 各スコアと内訳が Excel Match_140 と一致すること
    for (const key of ['absoluteScore', 'specificityCorrection', 'rawMatch', 'percentile', 'displayScore', 'rankBias', 'rankScore']) {
      if (typeof expected[key] === 'number') {
        assertClose(actual[key], expected[key], 0.01, `${index + 1}位の${key}`);
      }
    }
  });
});

console.log('\n■ 回答スタイル補正');

test('Excel Simulator とサイトで、同じ回答なら7気質・15軸・Top10・Percentile・RankScore・DisplayScore が一致する（12パターン）', () => {
  // tests/fixtures/excel_cases.json は tools/export_excel_cases.py が Excel を再計算して作る（回答スタイル補正込み）
  assert(excelCases.cases.length >= 10, 'Excel の比較パターンが少ない');
  for (const excelCase of excelCases.cases) {
    const result = runDiagnosis(excelCase.answers, data);
    const label = excelCase.label;
    assertClose(responseStyle(excelCase.answers, model).scale, excelCase.responseScale, 1e-9, `${label}: 回答スタイル補正の倍率`);
    for (const [axis, value] of Object.entries(excelCase.personality)) assertClose(result.personality[axis], value, 1e-6, `${label}: ${axis}`);
    for (const [axis, value] of Object.entries(excelCase.final)) assertClose(result.finalAxes[axis], value, 1e-6, `${label}: ${axis}`);
    excelCase.top.forEach((expected, index) => {
      const actual = result.ranked[index];
      assert(actual.profile.id === expected.profileId, `${label}: ${index + 1}位が Excel=${expected.profileId} / サイト=${actual.profile.id}`);
      assertClose(actual.rawMatch, expected.rawMatch, 1e-6, `${label}: ${expected.profileId} RawMatch`);
      assertClose(actual.percentile, expected.percentile, 1e-9, `${label}: ${expected.profileId} Percentile`);
      assertClose(actual.rankBias, expected.rankBias, 1e-9, `${label}: ${expected.profileId} RankBias`);
      assertClose(actual.rankScore, expected.rankScore, 1e-6, `${label}: ${expected.profileId} RankScore`);
      assert(actual.displayScore === expected.displayScore, `${label}: ${expected.profileId} DisplayScore Excel=${expected.displayScore} / サイト=${actual.displayScore}`);
    });
  }
});

test('Percentile・RankBias の作り直し結果が Excel に書き戻されている（サイトは Excel の値だけを使う）', () => {
  for (const profile of excelProfiles) {
    const expected = calibrationOutput.percentiles[profile.id];
    assert(expected, `${profile.id}: excel-handoff/calibration.json に無い`);
    assertClose(profile.percentile.rawMean, expected.rawMean, 1e-9, `${profile.id} RawMean`);
    expected.quantiles.forEach((value, k) => assertClose(profile.percentile.quantiles[k], value, 1e-9, `${profile.id} Q${k}`));
    assertClose(profile.rankBias, calibrationOutput.rankBias[profile.id], 1e-9, `${profile.id} RankBias`);
  }
  assert(!fs.existsSync(path.join(ROOT, 'data', 'calibration.json')), 'data/calibration.json が残っている（サイトが Excel 以外の値を読むおそれ）');
});

test('全部3（情報ゼロ）の回答は補正されず、7軸すべて50のまま', () => {
  const style = responseStyle(fill(3), model);
  assert(style.extremity === 0 && style.scale === 1, `Extremity=${style.extremity} scale=${style.scale}`);
  for (const [axis, value] of Object.entries(calculatePersonality(fill(3), questions, model))) {
    assertClose(value, 50, 1e-9, axis);
  }
});

test('補正の倍率は上限・下限を超えず、回答の向き（正負）を変えない', () => {
  const { minScale, maxScale } = excelModel.responseStyle;
  for (const person of population(300, 99)) {
    const style = responseStyle(person.answers, model);
    assert(style.scale >= minScale - 1e-9 && style.scale <= maxScale + 1e-9, `scale=${style.scale}`);
    const raw = responseStyle(person.answers, { ...excelModel, responseStyle: { enabled: false } }).norms;
    style.norms.forEach((value, index) => {
      assert(Math.sign(value) === Math.sign(raw[index]) && Math.abs(value) <= 1, '向きが変わった／±1を超えた');
    });
  }
});

test('「ほぼ全部3」のような情報の少ない回答は強めすぎない（rampExtremity）', () => {
  const answers = fill(3).map((value, index) => ([0, 14, 1].includes(index) ? 4 : value));
  const style = responseStyle(answers, model);
  assert(style.scale < 1.25, `情報が少ないのに ${style.scale.toFixed(2)} 倍に強めている`);
});

test('同じ性格なら、2・3・4中心や1・5多用で答えても7軸が近くなる（補正なしより差が小さい）', () => {
  const rng = createRng(31337);
  let before = 0;
  let after = 0;
  let count = 0;
  for (let i = 0; i < 400; i += 1) {
    const { answersByStyle } = sameTraitsAllStyles(questions, personalityAxisKeys(model), rng);
    for (const style of ['midpoint', 'noExtreme', 'extreme']) {
      for (const [target, m] of [['before', { ...model, responseStyle: { enabled: false } }], ['after', model]]) {
        const ref = calculatePersonality(answersByStyle.normal, questions, m);
        const other = calculatePersonality(answersByStyle[style], questions, m);
        const diff = personalityAxisKeys(model).reduce((sum, axis) => sum + Math.abs(ref[axis] - other[axis]), 0) / 7;
        if (target === 'before') before += diff;
        else after += diff;
      }
      count += 1;
    }
  }
  assert(after < before * 0.85, `スタイル差が十分に縮んでいない（補正前 ${(before / count).toFixed(2)} → 補正後 ${(after / count).toFixed(2)}）`);
});

test('2・3・4しか使わない回答者でも、7軸がすべて45〜55に潰れる人は少ない', () => {
  const rng = createRng(2468);
  let collapsed = 0;
  const n = 400;
  for (let i = 0; i < n; i += 1) {
    const { answersByStyle } = sameTraitsAllStyles(questions, personalityAxisKeys(model), rng);
    const personality = calculatePersonality(answersByStyle.noExtreme, questions, model);
    if (Object.values(personality).every((value) => Math.abs(value - 50) <= 5)) collapsed += 1;
  }
  assert(collapsed / n < 0.02, `7軸すべて45〜55の人が ${(collapsed / n * 100).toFixed(1)}%`);
});

console.log('\n■ Shape・Specificity 補正');

test('中立の回答ではPlayerSignalが0になり、Shapeは効かない', () => {
  const result = runDiagnosis(fill(3), data);
  assertClose(result.playerSignal, 0, 1e-9, 'PlayerSignal');
  for (const entry of result.ranked) {
    assertClose(entry.hybridScore, entry.absoluteScore, 1e-9, `${entry.profile.id} のHybrid`);
  }
});

test('好みがはっきりした回答ではShapeが効き、形の近いプロファイルほどShapeScoreが高い', () => {
  const result = runDiagnosis(randomAnswers(42), data);
  assert(result.playerSignal > 0, 'PlayerSignalが0のまま');
  const player = result.finalAxes;
  const same = { id: 'same', pokemon: 'テスト', axes: { ...player } };
  const inverse = {
    id: 'inverse',
    pokemon: 'テスト',
    axes: Object.fromEntries(Object.entries(player).map(([axis, value]) => [axis, 100 - value])),
  };
  const context = { signal: 1, averageSpecificity: 0 };
  assertClose(calculateMatch(player, same, model, context).shapeScore, 100, 1e-6, '同じ形のShape');
  assertClose(calculateMatch(player, inverse, model, context).shapeScore, 0, 1e-6, '逆の形のShape');
});

test('Specificity補正は上限（specificityCap）を超えない', () => {
  const cap = model.matchModel.specificityCap;
  for (const entry of runDiagnosis(randomAnswers(9), data).ranked) {
    assert(Math.abs(entry.specificityCorrection) <= cap + 1e-9, `${entry.profile.id}: ${entry.specificityCorrection}`);
  }
});

test('疑似回答7,000件（回答スタイル混合）で、全ポケモンが一度はTOP3に出て、1位が偏らない', () => {
  const people = population(7000, 4040);
  const seen = new Set();
  const top1 = new Map();
  // 出にくいポケモンは Top3率 0.2% 前後。1,500件だと偶然0回になり得るため、Excel の監査と同じ7,000件で見る
  const samples = 7000;
  for (let i = 0; i < samples; i += 1) {
    const result = runDiagnosis(people[i].answers, data, { topCount: 3 });
    result.top.forEach((entry) => seen.add(entry.profile.pokemon));
    const first = result.top[0].profile.pokemon;
    top1.set(first, (top1.get(first) ?? 0) + 1);
  }
  const missing = rosterFile.pokemon.map((entry) => entry.name).filter((name) => !seen.has(name));
  assert(!missing.length, `TOP3に一度も出ないポケモン: ${missing.join(', ')}`);
  const [maxName, maxCount] = [...top1.entries()].sort((a, b) => b[1] - a[1])[0];
  assert(maxCount / samples < 0.06, `1位が特定ポケモンに偏っている: ${maxName} ${(maxCount / samples * 100).toFixed(1)}%`);
});

test('1位の表示相性が一部に固まらず広がる（目安: p10≈77 / 中央値≈92 / p90≈95）', () => {
  const scores = population(1000, 777).map((person) => runDiagnosis(person.answers, data, { topCount: 1 }).top[0].displayScore);
  scores.sort((a, b) => a - b);
  const at = (p) => scores[Math.floor(p * (scores.length - 1))];
  assert(at(0.1) >= 66 && at(0.1) <= 80, `p10 が ${at(0.1)}`);
  assert(at(0.5) >= 86 && at(0.5) <= 94, `中央値が ${at(0.5)}`);
  assert(at(0.9) >= 93, `p90 が ${at(0.9)}`);
});

test('性格の組み合わせ効果: 自分から動く×勝負に出るが両方高いほど Engage / Dive が上がる', () => {
  const base = Object.fromEntries(personalityAxisKeys(model).map((axis) => [axis, 50]));
  const both = translateToGameplay({ ...base, Initiative: 90, RiskTolerance: 90 }, model);
  const withoutInteraction = translateToGameplay({ ...base, Initiative: 90, RiskTolerance: 90 }, { ...model, interactions: [] });
  assert(both.Engage > withoutInteraction.Engage && both.Dive > withoutInteraction.Dive, '組み合わせ効果が効いていない');
  const one = translateToGameplay({ ...base, Initiative: 90, RiskTolerance: 50 }, model);
  const oneWithout = translateToGameplay({ ...base, Initiative: 90, RiskTolerance: 50 }, { ...model, interactions: [] });
  assertClose(one.Engage, oneWithout.Engage, 1e-9, '片方だけ高いときは組み合わせ効果なし');
});

test('ResultComment があるプロファイルは、その文章が結果コメントに入る', () => {
  const result = runDiagnosis(randomAnswers(5), data);
  const entry = result.top[0];
  const comment = generateResultComment(result, entry, { model, comments });
  if (entry.profile.resultComment) {
    const expected = politeProfileComment(entry.profile.resultComment);
    assert(comment.paragraphs.includes(expected), 'ResultComment が使われていない');
  }
  assert(profiles.every((profile) => profile.resultComment), 'ResultComment が空のプロファイルがある');
});

console.log('\n■ タイプ判定・コメント・シェアURL');

test('どんな回答でも性格タイプが決まり、コメントが生成される', () => {
  const answerSets = [fill(1), fill(3), fill(5), ...[1, 2, 3, 4, 5, 6, 7, 8].map((seed) => randomAnswers(seed * 13))];
  const seen = new Set();
  for (const answers of answerSets) {
    const result = runDiagnosis(answers, data, { topCount: display.result.topCount });
    const type = determinePersonalityType(result, personalityTypes, model);
    assert(type.name, 'タイプ名が空');
    seen.add(type.id);
    const comment = generateResultComment(result, result.top[0], { model, comments });
    assert(comment.paragraphs.length >= 2, 'コメントの段落が少なすぎる');
    for (const paragraph of comment.paragraphs) {
      assert(!paragraph.includes('{'), `テンプレートの置換漏れ: ${paragraph}`);
      assert(paragraph.trim().length > 0, '空の段落がある');
    }
  }
  assert(seen.size >= 2, `タイプが1種類しか出ていない (${[...seen].join(', ')})`);
});

test('性格タイプ定義の軸キーがすべて実在する', () => {
  const valid = new Set([
    ...gameAxisKeys(model),
    ...personalityAxisKeys(model).map((axis) => `P_${axis}`),
  ]);
  for (const type of personalityTypes.types) {
    assert(type.id && type.name, 'idまたはnameが無いタイプがある');
    for (const condition of type.require ?? []) {
      assert(valid.has(condition.axis), `${type.id}: 未知の軸 ${condition.axis}`);
    }
    for (const axis of Object.keys(type.weights ?? {})) {
      assert(valid.has(axis), `${type.id}: 未知の軸 ${axis}`);
    }
  }
});

test('性格タイプにテーマカラーが設定されている', () => {
  const isHex = (value) => typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value);
  assert(isHex(personalityTypes.fallback?.color), 'fallback に color が無い');
  for (const type of personalityTypes.types) {
    assert(isHex(type.color), `${type.id}: color が無効 (${type.color})`);
  }
});

test('判定結果にタイプのテーマカラーが含まれる', () => {
  const result = runDiagnosis(fill(5), data, { topCount: 3 });
  const type = determinePersonalityType(result, personalityTypes, model);
  assert(/^#[0-9a-f]{3,8}$/i.test(type.color ?? ''), `色が返っていない (${type.color})`);
});

test('コメント用の文章パーツが全15軸ぶんそろっている', () => {
  for (const axis of gameAxisKeys(model)) {
    const phrase = comments.gameAxisPhrases[axis];
    assert(phrase?.high && phrase?.low, `${axis} の文章パーツが不足`);
  }
  // テンプレートが「{高い側}より、{低い側}方が」とつなぐので、言い回し側に「より」を入れない
  for (const [axis, phrase] of Object.entries(comments.gameAxisPhrases)) {
    assert(!/より/.test(phrase.low) && !/より/.test(phrase.high), `${axis} の言い回しに「より」が入っている`);
  }
});

test('全プロファイルに固有の紹介文とキーワード（3つ）があり、紹介文が使い回されていない', () => {
  const seen = new Map();
  for (const profile of excelProfiles) {
    const words = profile.styleKeywords;
    assert(words.length === 3 && new Set(words).size === 3, `${profile.id}: キーワードが3つでない・重複している`);
    assert(!seen.has(profile.resultComment), `${profile.id}: ${seen.get(profile.resultComment)} と紹介文が同じ`);
    seen.set(profile.resultComment, profile.id);
    assert(!/窓/.test(profile.resultComment), `${profile.id}: 「窓」は使わない（短いチャンス・好機などに言い換える）`);
    if (hasMoveset(profile, comments)) {
      assert(profile.resultComment.includes(profile.profileName), `${profile.id}: 型分けしているのに紹介文に「${profile.profileName}」が無い`);
    }
  }
});

test('キーワードは Axes の語彙だけを使い、そのプロファイルの軸の向きと一致する（例: 操作難度60のカビゴンに「操作を極める」は付けない）', () => {
  // 境界は tools/export_excel.py の KEYWORD_MIN_DISTANCE と同じ
  const minDistance = 15;
  const lookup = new Map();
  for (const axis of excelModel.gameAxes) {
    if (axis.keywordLow) lookup.set(axis.keywordLow, { axis: axis.key, side: 'low' });
    if (axis.keywordHigh) lookup.set(axis.keywordHigh, { axis: axis.key, side: 'high' });
  }
  assert(lookup.size >= 15, 'Axes のキーワード列が読み込まれていない');
  for (const profile of profiles) {
    for (const word of profile.styleKeywords) {
      const entry = lookup.get(word);
      assert(entry, `${profile.id}: 語彙に無いキーワード「${word}」（表示ラベルへの置き換えで変わっていないかも確認）`);
      const value = profile.axes[entry.axis];
      const ok = entry.side === 'high' ? value >= 50 + minDistance : value <= 50 - minDistance;
      assert(ok, `${profile.id}: 「${word}」なのに ${entry.axis}=${value}`);
    }
  }
});

test('Excel の ResultComment は「です・ます」に揃い、同じ語句を繰り返さない', () => {
  for (const profile of profiles) {
    const text = politeProfileComment(profile.resultComment);
    for (const sentence of text.match(/[^。]+。/g) ?? []) {
      assert(/(です|ます)。$/.test(sentence), `${profile.id}: 文末が揃っていない「${sentence}」`);
    }
    const [first, ...rest] = text.split('。');
    const phrases = rest.join('。').match(/^(.+?)ことを楽しめる/)?.[1].split('ことと、') ?? [];
    for (const phrase of phrases) {
      assert(!first.includes(phrase.slice(0, -1)), `${profile.id}: 同じ語句を繰り返している「${phrase}」`);
    }
  }
});

test('性格タイプは偏らずに出る（疑似回答2,000件で全タイプが出て、最大でも8%未満）', () => {
  const people = population(2000, 4242);
  const counts = new Map();
  const samples = people.length;
  for (let i = 0; i < samples; i += 1) {
    const result = runDiagnosis(people[i].answers, data, { topCount: 1 });
    const type = determinePersonalityType(result, personalityTypes, model);
    counts.set(type.name, (counts.get(type.name) ?? 0) + 1);
  }
  const missing = personalityTypes.types.filter((type) => !counts.has(type.name)).map((type) => type.name);
  assert(!missing.length, `一度も出ないタイプ: ${missing.join(', ')}`);
  const [name, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  assert(count / samples < 0.08, `${name} が ${(count / samples * 100).toFixed(1)}% に偏っている`);
});

test('「なぜこのポケモン？」の軸は最大3つで重複せず、両者が同じ側にはっきり寄った軸だけを使う', () => {
  const { matchAxisPokemonMinDistance: pokemonMin, matchAxisPlayerMinDistance: playerMin } = comments.thresholds;
  const counts = new Map();
  for (let seed = 1; seed <= 200; seed += 1) {
    const result = runDiagnosis(randomAnswers(seed * 7), data);
    const comment = generateResultComment(result, result.top[0], { model, comments });
    const names = comment.sharedAxes.map((item) => item.axis);
    assert(names.length <= 3 && new Set(names).size === names.length, `軸が重複・超過: ${names.join(', ')}`);
    for (const item of comment.sharedAxes) {
      const high = item.pokemonValue > 50;
      assert(high === item.playerValue > 50 && item.playerValue !== 50, `${item.axis}: 反対側の軸を理由にしている`);
      assert(Math.abs(item.pokemonValue - 50) >= pokemonMin, `${item.axis}: ポケモン側の寄りが弱い（${item.pokemonValue}）`);
      assert(Math.abs(item.playerValue - 50) >= playerMin, `${item.axis}: プレイヤー側の寄りが弱い（${item.playerValue}）`);
    }
    assert(comment.matchText.trim(), '一致理由の文章が空');
    assert(!/\{\w+\}|、、|、。/.test(comment.matchText), `穴あきの文章: ${comment.matchText}`);
    counts.set(names.length, (counts.get(names.length) ?? 0) + 1);
  }
  for (const key of ['0', '1', '2', '3']) assert(comments.templates.matchReason[key]?.length, `matchReason の ${key} 個用の文型が無い`);
});

test('ポケモン側の寄りが弱い軸（例: カビゴン じたばた型の操作難度60）は理由に使わない', () => {
  const profile = profiles.find((entry) => entry.pokemon === 'カビゴン' && entry.profileName === 'じたばた');
  assert(profile && profile.axes.Execution < 70 && profile.axes.Execution > 50, '前提のデータが変わった');
  for (let seed = 1; seed <= 60; seed += 1) {
    const result = runDiagnosis(randomAnswers(seed * 5), data);
    const comment = generateResultComment(result, { profile, displayScore: 90 }, { model, comments });
    assert(!comment.sharedAxes.some((item) => item.axis === 'Execution'), '操作難度60で「操作を極める」を理由にした');
  }
});

test('15軸の表示ラベルが全軸・両側にあり、片側だけ否定的な言葉（依存など）を使わない', () => {
  for (const axis of model.gameAxes) {
    assert(axis.lowLabel && axis.highLabel, `${axis.key} のラベルが無い`);
    for (const word of ['依存', '苦手', '弱い', '下手']) {
      assert(!axis.lowLabel.includes(word) && !axis.highLabel.includes(word), `${axis.key}: 「${word}」を含む`);
    }
  }
  // 特徴キーワードも表示ラベルに置き換わっている（Excel の旧ラベルが残らない）
  const oldLabels = new Set(excelModel.gameAxes.flatMap((axis) => [axis.lowLabel, axis.highLabel]));
  const newLabels = new Set(model.gameAxes.flatMap((axis) => [axis.lowLabel, axis.highLabel]));
  for (const profile of profiles) {
    for (const word of profile.styleKeywords) {
      assert(!oldLabels.has(word) || newLabels.has(word), `${profile.id}: キーワード「${word}」が旧ラベルのまま`);
    }
  }
});

test('結果カードの一言: 僅差なら接戦、高相性なら「まずはこの1体」', () => {
  const heroes = comments.heroMessages;
  let sawClose = false;
  let sawHigh = false;
  for (const person of population(300, 606)) {
    const result = runDiagnosis(person.answers, data);
    const message = heroMessage(result, comments);
    const close = result.top[1] && result.top[0].rankScore - result.top[1].rankScore < 1;
    if (close) {
      sawClose = true;
      assert(message === heroes.close, '僅差なのに接戦の文になっていない');
    } else if (result.top[0].displayScore >= heroes.highMin) {
      sawHigh = true;
      assert(message === heroes.high, '高相性なのに高相性の文になっていない');
    } else {
      assert(message === heroes.default, 'それ以外の文になっていない');
    }
  }
  assert(sawClose && sawHigh, '接戦・高相性のどちらかの例が見つからなかった');
});

test('すべての性格タイプにキャッチコピーと説明文がある', () => {
  for (const type of personalityTypes.types) {
    assert(type.tagline && type.lead && type.body, `${type.name} の文言が不足`);
  }
  assert(personalityTypes.axisStats && Object.keys(personalityTypes.axisStats).length, 'axisStats が無い（tools/calibrate-types.mjs を実行）');
});

test('型分けしていないポケモンでは技構成の文言を出さない', () => {
  const generic = comments.genericProfileNames ?? ['共通プロファイル'];
  assert(generic.length > 0, 'genericProfileNames が空');
  const genericProfile = profiles.find((profile) => generic.includes(profile.profileName));
  const splitProfile = profiles.find((profile) => !generic.includes(profile.profileName));
  assert(genericProfile && splitProfile, '型分けあり／なしの両方のプロファイルが必要');
  assert(!hasMoveset(genericProfile, comments), '共通プロファイルは技構成扱いしない');
  assert(hasMoveset(splitProfile, comments), '型分けありは技構成として扱う');

  // 実際の診断結果でも、代表型が共通プロファイルならコメントにその名前が出ない
  for (const answers of [fill(1), fill(2), fill(3), fill(4), fill(5), randomAnswers(21), randomAnswers(42)]) {
    const result = runDiagnosis(answers, data, { topCount: 3 });
    const comment = generateResultComment(result, result.top[0], { model, comments });
    const text = comment.paragraphs.join('\n');
    for (const name of generic) {
      assert(!text.includes(name), `コメントに「${name}」が出ている`);
    }
  }
});

test('結果コメントに英語の専門用語（アーキタイプ名・ProfileLabel）が出ない', () => {
  const jargon = new Set();
  for (const profile of profiles) {
    if (profile.primaryArchetype) jargon.add(profile.primaryArchetype);
    if (profile.secondaryArchetype) jargon.add(profile.secondaryArchetype);
    if (profile.profileLabel) jargon.add(profile.profileLabel);
  }
  for (const answers of [fill(1), fill(3), fill(5), randomAnswers(8), randomAnswers(16)]) {
    const result = runDiagnosis(answers, data, { topCount: 3 });
    const comment = generateResultComment(result, result.top[0], { model, comments });
    const text = [...comment.paragraphs, comment.role, comment.grade].join('\n');
    for (const word of jargon) {
      assert(!text.includes(word), `コメントに専門用語「${word}」が出ている`);
    }
    assert(!/[A-Za-z]{4,}/.test(text), `コメントに英単語が混ざっている: ${text.match(/[A-Za-z]{4,}/)}`);
  }
});

test('回答の情報量が極端に少ないときだけ「参考結果」になり、2/3/4中心の回答者には影響しない', () => {
  const referenceOf = (answers) => isReferenceResult(runDiagnosis(answers, data, { topCount: 1 }), display);
  assert(referenceOf(fill(3)), '全部3が参考結果になっていない');
  const withOffNeutral = (count) => questions.map((question, index) => (index < count ? (index % 2 ? 2 : 4) : 3));
  assert(referenceOf(withOffNeutral(5)), '3以外が5問（2・4）だけなら参考結果');
  assert(!referenceOf(withOffNeutral(6)), '3以外が6問あれば通常の結果');
  assert(!referenceOf(fill(1)) && !referenceOf(fill(5)), '全部1・全部5は情報があるので通常の結果');
  // 回答スタイル別: 1〜5を使う人・2/3/4だけの人は参考結果にならない
  const rng = createRng(4646);
  let normal = 0;
  let noExtreme = 0;
  const samples = 1500;
  for (let i = 0; i < samples; i += 1) {
    const { answersByStyle } = sameTraitsAllStyles(questions, personalityAxisKeys(model), rng);
    normal += referenceOf(answersByStyle.normal);
    noExtreme += referenceOf(answersByStyle.noExtreme);
  }
  assert(normal === 0 && noExtreme === 0, `通常 ${normal}件 / 2/3/4のみ ${noExtreme}件が参考結果になった`);
  // 参考結果のシェア文には相性の数値を載せない
  const text = buildDiagnosisShareText(
    { pokemon: 'カビゴン', typeName: 'バランス感覚の万能型', tagline: 'x', score: 94, axisLines: ['a'], reference: true },
    display.share,
  );
  assert(text.includes('参考結果') && !/相性\s*\d/.test(text) && !text.includes('/100'), `参考結果のシェア文に数値が残っている: ${text}`);
});

console.log('\n■ 結果表示（表示層）');

test('結果表示: 戦い方は「〇〇寄り（わざ中心）」で表し、ユーザー向けに「型」と書かない', () => {
  for (const profile of profiles) {
    const label = profileStyleLabel(profile, comments);
    if (!hasMoveset(profile, comments)) {
      assert(label === '', `${profile.id}: 戦い方を分けていないのにラベルがある（${label}）`);
      continue;
    }
    assert(label && !label.includes('型'), `${profile.id}: 戦い方のラベルが不正（${label}）`);
    if (!comments.styleLabelOverrides?.[profile.id]) {
      assert(label.endsWith(`（${profile.profileName}中心）`), `${profile.id}: わざ名を「中心」として添えていない（${label}）`);
    }
  }
  assert(profileStyleLabel(profiles.find((p) => p.id === 'ブラッキー-1'), comments) === '支援寄り（ねがいごと中心）', 'ブラッキー ねがいごと の表示');
  assert(profileStyleLabel(profiles.find((p) => p.id === 'ハッサム-1'), comments).includes('ストライク'), 'ストライクの表示');
  const roleNames = /(アタック|バランス|スピード|ディフェンス|サポート)型/g;
  for (const page of ['index.html', 'result.html']) {
    const text = fs.readFileSync(path.join(ROOT, page), 'utf8').replace(roleNames, '');
    assert(!/型/.test(text.replace(/<[^>]+>/g, '')), `${page} にユーザー向けの「型」が残っている`);
  }
  assert(!profiles.some((profile) => /型です/.test(profile.resultComment)), '紹介文に「型です」が残っている');
  const broken = profiles.filter((profile) => /(アタック|バランス|スピード|ディフェンス|サポート)戦い方/.test(profile.resultComment));
  assert(!broken.length, `ロール名が「戦い方」に置き換わっている: ${broken.map((profile) => profile.id).join(', ')}`);
});

test('結果表示: 回答からゲームの実力を断定しない（「得意」「得意な勝ち方」を使わない）', () => {
  const texts = [
    JSON.stringify(comments.templates), JSON.stringify(comments.heroMessages), JSON.stringify(comments.gradeComments),
    JSON.stringify(comments.gameAxisPhrases), JSON.stringify(display.share), JSON.stringify(display.result),
    ...personalityTypes.types.flatMap((type) => [type.tagline, type.lead, type.body]),
    personalityTypes.fallback.body, ...profiles.map((profile) => profile.resultComment),
    fs.readFileSync(path.join(ROOT, 'result.html'), 'utf8'), fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'),
  ];
  for (const text of texts) assert(!/得意/.test(text), `「得意」が残っている: ${text.match(/.{0,20}得意.{0,20}/)?.[0]}`);
});

test('結果表示: 一致理由の言い回しは役割に依存しない（「後衛を狩る」等の役割固有の行動を作らない）', () => {
  const roleSpecific = /後衛|狩る|取り切り|野生|ゴール|得点|回復|シールド|妨害|設置/;
  for (const [axis, sides] of Object.entries(comments.gameAxisPhrases)) {
    for (const phrase of Object.values(sides)) assert(!roleSpecific.test(phrase), `${axis}: 役割固有の言い回し「${phrase}」`);
  }
  assert(comments.gameAxisPhrases.Dive.high === '深く踏み込んで勝負する', 'Dive の言い回し');
});

test('結果表示: 2〜5位の候補には相性の数値を出さず、「こちらもおすすめ」と1行説明を出す', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const result = runDiagnosis(randomAnswers(seed * 3), data, { topCount: 5 });
    const items = buildCandidateItems(result.top.slice(1), comments);
    assert(items.length === 4, '候補が4件でない');
    for (const item of items) {
      assert(!Object.values(item).some((value) => typeof value === 'number'), `候補に数値がある: ${JSON.stringify(item)}`);
      assert(item.label === 'こちらもおすすめ', `候補のラベル: ${item.label}`);
      assert(/(です|ます)。$/.test(item.summary) && [...item.summary].length <= 100, `1行説明が不正: ${item.summary}`);
      assert(!item.style.includes('型'), `候補の戦い方に「型」: ${item.style}`);
    }
  }
  const source = fs.readFileSync(path.join(ROOT, 'js', 'result.js'), 'utf8');
  assert(!/shownScore|scoreCap/.test(source), '候補の数値を順位に合わせて加工する処理が残っている');
});

test('結果表示: 相性スコアの下に「強さ・勝率・実力ではない」注記があり、スマホは OTP→理由→他候補→タイプ→7気質→シェア→詳細 の順', () => {
  const html = fs.readFileSync(path.join(ROOT, 'result.html'), 'utf8');
  const note = html.match(/id="scoreNote">([^<]+)</)?.[1] ?? '';
  assert(/プレイ嗜好の近さ/.test(note) && /強さ・勝率・実力/.test(note), `スコアの注記: ${note}`);
  assert(html.indexOf('id="topScore"') < html.indexOf('id="scoreNote"'), '注記がスコアの下にない');
  const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
  const orderOf = (selector) => Number(css.match(new RegExp(`\\.page-result ${selector.replace('.', '\\.')} \\{ order: (\\d+); \\}`))?.[1]);
  const sequence = ['#mainResult', '.reason-card', '.candidates-card', '.type-card', '.traits-card', '.share-card', '.detail-card'].map(orderOf);
  assert(sequence.every((value, index) => value === index + 1), `スマホの並び順: ${sequence.join(',')}`);
  assert(!fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('hero-lead'), 'トップの「約3分で〜」の一文が残っている');
});

test('参考結果: タイプ説明や傾向の断定を出さず、OTPはお試し候補、シェア文も参考結果専用', () => {
  const reference = display.result.referenceResult;
  assert(reference.typeLabel === '今回は傾向を絞りきれなかった参考結果', 'タイプ欄の表示');
  assert(reference.candidateLabel.includes('お試し候補'), 'OTPの見出し');
  const result = runDiagnosis(fill(3), data);
  assert(isReferenceResult(result, display), '全3が参考結果でない');
  const type = determinePersonalityType(result, personalityTypes, model);
  const text = buildDiagnosisShareText(
    { pokemon: 'ミュウツー（X）', typeName: type.name, tagline: type.tagline, score: 95, axisLines: ['a', 'b'], reference: true },
    display.share,
  );
  assert(text.includes('参考結果') && text.includes('お試し候補') && text.includes('ミュウツー（X）'), `参考結果のシェア文: ${text}`);
  assert(!text.includes(type.name) && !text.includes(type.tagline) && !/\d+\/100|相性 \d/.test(text), `参考結果のシェア文にタイプ・数値が残っている: ${text}`);
  const source = fs.readFileSync(path.join(ROOT, 'js', 'result.js'), 'utf8');
  assert(/reference \? '' : comment\.matchText/.test(source) && /reference \? reference\.typeNote/.test(source), '参考結果で一致理由・タイプ説明を差し替えていない');
});

test('シェア文: 通常は「」のキャッチコピーを載せず、「好みの傾向」を載せる', () => {
  const type = personalityTypes.types[0];
  const text = buildDiagnosisShareText(
    { pokemon: 'カビゴン', typeName: type.name, tagline: type.tagline, score: 94, axisLines: ['前線に立ち続ける', '長く戦う'] },
    display.share,
  );
  assert(!text.includes(type.tagline) && !text.includes(`「${type.tagline}」`), `キャッチコピーが残っている: ${text}`);
  assert(text.includes('好みの傾向：前線に立ち続ける / 長く戦う') && text.includes('相性 94/100') && text.includes(`タイプ：${type.name}`), `通常のシェア文: ${text}`);
});

test('Xのシェア文が最悪ケースでも280文字（全角は2文字換算・URLは23文字）に収まる', () => {
  // X の文字数カウント: 日本語などは2、半角英数は1、URLは長さに関係なく23
  const weight = (text) => [...text].reduce((sum, ch) => sum + (ch.codePointAt(0) <= 0x10ff ? 1 : 2), 0);
  const longest = (list) => list.reduce((a, b) => ([...b].length > [...a].length ? b : a), '');
  const labels = model.gameAxes.flatMap((axis) => [axis.lowLabel, axis.highLabel]).sort((a, b) => b.length - a.length);
  const longestType = personalityTypes.types.reduce((a, b) => (b.name.length + b.tagline.length > a.name.length + a.tagline.length ? b : a));
  const text = buildDiagnosisShareText(
    {
      pokemon: longest(profiles.map((profile) => profile.pokemon)),
      typeName: longestType.name,
      tagline: longestType.tagline,
      score: 100,
      axisLines: labels.slice(0, display.share.axisLineCount ?? 3),
    },
    display.share,
  );
  assert(weight(text) + 1 + 23 <= 280, `診断のシェア文が長すぎる（${weight(text) + 24}）:\n${text}`);
  const referenceText = buildDiagnosisShareText(
    { pokemon: longest(profiles.map((profile) => profile.pokemon)), typeName: longestType.name, tagline: longestType.tagline, score: 100, axisLines: [], reference: true },
    display.share,
  );
  assert(weight(referenceText) + 1 + 23 <= 280, `参考結果のシェア文が長すぎる（${weight(referenceText) + 24}）`);
  const randomText = buildRandomShareText(
    { pokemon: longest(profiles.map((profile) => profile.pokemon)), flavor: longest(display.random.flavors) },
    display.share,
  );
  assert(weight(randomText) + 1 + 23 <= 280, `抽選のシェア文が長すぎる（${weight(randomText) + 24}）`);
});

test('シェアURLの回答エンコードが往復する（短さも確認）', () => {
  for (const answers of [fill(1), fill(5), randomAnswers(5), randomAnswers(6)]) {
    const code = encodeAnswers(answers, model);
    assert(code.length <= 24, `URLパラメータが長すぎる (${code.length}文字)`);
    const decoded = decodeAnswers(code, model, answers.length);
    assert(JSON.stringify(decoded) === JSON.stringify(answers), 'デコード結果が一致しない');
  }
  assert(decodeAnswers('', model, 30) === null, '空文字はnullであるべき');
  assert(decodeAnswers('zzz!', model, 30) === null, '不正文字はnullであるべき');
});

console.log('\n■ ページとスクリプトの対応（GitHub Pages対応の確認）');

const PAGE_SCRIPTS = {
  'diagnosis.html': 'js/diagnosis.js',
  'result.html': 'js/result.js',
  'random.html': 'js/random.js',
};

test('各ページのスクリプトが参照するidがHTMLに存在する', () => {
  for (const [page, script] of Object.entries(PAGE_SCRIPTS)) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const source = fs.readFileSync(path.join(ROOT, script), 'utf8');
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
    const used = new Set([...source.matchAll(/qs\('#([\w-]+)'\)/g)].map((match) => match[1]));
    for (const id of used) {
      assert(ids.has(id), `${page} に #${id} が無い（${script} が参照）`);
    }
    assert(new RegExp(`src="\\./${script}(\\?v=[0-9a-f]+)?"`).test(html), `${page} が ${script} を読み込んでいない`);
    assert(/href="\.\/css\/style\.css(\?v=[0-9a-f]+)?"/.test(html), `${page} がCSSを読み込んでいない`);
  }
});

test('JS・CSSの版番号（?v=）が中身と一致している（キャッシュで古い版が混ざらない）', () => {
  const digest = (file) => createHash('sha1').update(fs.readFileSync(path.join(ROOT, file), 'utf8')).digest('hex').slice(0, 8);
  const sources = [...Object.keys(PAGE_SCRIPTS), 'index.html', ...fs.readdirSync(path.join(ROOT, 'js')).map((f) => `js/${f}`)];
  for (const file of new Set(sources)) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const base = file.endsWith('.html') ? '' : 'js/';
    for (const match of text.matchAll(/(?:from|import|src=|href=)\s*['"]\.\/([\w./-]+\.(?:js|css))(\?v=([0-9a-f]+))?['"]/g)) {
      const target = `${base}${match[1]}`;
      assert(match[3], `${file}: ${match[1]} に版番号が無い（python3 tools/stamp_assets.py を実行）`);
      assert(match[3] === digest(target), `${file}: ${match[1]} の版番号が古い（python3 tools/stamp_assets.py を実行）`);
    }
  }
});

test('HTMLの「全N体」がロスターのポケモン数と一致する（新ポケモン追加時の更新漏れ防止）', () => {
  const expected = `全${rosterFile.pokemon.length}体`;
  for (const page of ['index.html', 'diagnosis.html', 'result.html', 'random.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const stale = (html.match(/全\d+体/g) ?? []).filter((text) => text !== expected);
    assert(!stale.length, `${page} に ${stale.join(', ')} がある（${expected} にする: python3 tools/sync_roster_count.py）`);
  }
});

test('ルート絶対パスを使っていない（サブディレクトリ公開でも壊れない）', () => {
  const files = [
    ...Object.keys(PAGE_SCRIPTS),
    ...Object.values(PAGE_SCRIPTS),
    'js/model.js',
    'js/comment.js',
    'js/data.js',
    'js/share.js',
    'js/ui.js',
    'css/style.css',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const pattern of [/src="\//, /href="\/(?!\/)/, /'\/data\//, /"\/data\//, /'\/js\//]) {
      assert(!pattern.test(source), `${file} にルート絶対パスがある (${pattern})`);
    }
  }
});

test('ブラウザと同じ読み込み関数（js/data.js）で、補正と表示ラベルを重ねたデータが作れる', async () => {
  // fetch をファイル読み込みに差し替えて、結果ページと同じ loadDiagnosisData() を通す
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const file = fileURLToPath(url);
    return { ok: fs.existsSync(file), status: 404, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
  };
  try {
    const { loadDiagnosisData } = await import('../js/data.js');
    const loaded = await loadDiagnosisData();
    assert(loaded.model.responseStyle?.enabled, '回答スタイル補正が重なっていない');
    assert(loaded.model.gameAxes.find((axis) => axis.key === 'SelfSufficiency').lowLabel === comments.gameAxisLabels.SelfSufficiency.low, '表示ラベルが置き換わっていない');
    const sample = loaded.profiles[0];
    assert(JSON.stringify(sample.percentile) === JSON.stringify(excelProfiles[0].percentile), 'Excel の Percentile がそのまま使われていない');
    const result = runDiagnosis(fill(4), { questions: loaded.questions, model: loaded.model, profiles: loaded.profiles });
    assert(result.top.length === display.result.topCount, '読み込んだデータで診断できない');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('data/*.json がすべて存在し、JSONとして読める', () => {
  for (const file of [
    'model.json',
    'questions.json',
    'profiles.json',
    'roster.json',
    'archetypes.json',
    'comments.json',
    'personality-types.json',
    'display.json',
  ]) {
    const full = path.join(ROOT, 'data', file);
    assert(fs.existsSync(full), `data/${file} が無い`);
    JSON.parse(fs.readFileSync(full, 'utf8'));
  }
});

test('一致理由は、低い値同士なら低い側のラベル・言い回し（例: 安全に戦う）で説明する', () => {
  let checked = 0;
  for (let seed = 1; seed <= 60 && checked < 10; seed += 1) {
    const result = runDiagnosis(randomAnswers(seed * 11), data);
    const entry = result.top[0];
    const comment = generateResultComment(result, entry, { model, comments, personalityTypes });
    for (const item of comment.sharedAxes) {
      if (!(item.playerValue < 50 && item.pokemonValue < 50)) continue;
      const meta = model.gameAxes.find((axis) => axis.key === item.axis);
      assert(comment.sharedLabels.includes(meta.lowLabel), `${item.axis}: 低い同士の一致なのにタグが「${meta.lowLabel}」でない`);
      assert(!comment.sharedLabels.includes(meta.highLabel), `${item.axis}: 低い同士の一致を「${meta.highLabel}」としている`);
      assert(comment.matchText.includes(comments.gameAxisPhrases[item.axis].low), `${item.axis}: 本文が低い側の言い回しになっていない`);
      checked += 1;
    }
  }
  assert(checked > 0, '低い値同士の一致が1件も見つからなかった');
});

test('ストライクの表示と推薦理由がライセンス名と混同されない', () => {
  const profile = profiles.find((entry) => entry.id === 'ハッサム-1');
  assert(profileDisplayName(profile) === 'ストライク', '表示名がハッサムになっている');
  assert(profileDisplayName(profiles.find((entry) => entry.id === 'ハッサム-2')) === 'ハッサム', 'ハッサム自身の表示名が変わった');
  const result = runDiagnosis(fill(3), data);
  const comment = generateResultComment(result, { profile, matchScore: 80 }, { model, comments, personalityTypes });
  assert(comment.matchText.includes('ストライク') && !comment.matchText.includes('ハッサム'), '推薦理由の名前と表示が一致しない');
});

await Promise.all(pending);

console.log(
  `\n結果: ${passed} 件成功 / ${failures.length} 件失敗\n`,
);
if (failures.length) {
  process.exitCode = 1;
}
