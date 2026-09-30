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
} from '../js/model.js';
import {
  determinePersonalityType,
  generateResultComment,
  hasMoveset,
  profileDisplayName,
  politeProfileComment,
} from '../js/comment.js';
import { buildDiagnosisShareText, buildRandomShareText, decodeAnswers, encodeAnswers } from '../js/share.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));

const model = read('data/model.json');
const questionsFile = read('data/questions.json');
const profilesFile = read('data/profiles.json');
const rosterFile = read('data/roster.json');
const comments = read('data/comments.json');
const personalityTypes = read('data/personality-types.json');
const display = read('data/display.json');
const baseline = read('tests/fixtures/excel_baseline.json');

const questions = questionsFile.questions;
const profiles = profilesFile.profiles;
const data = { questions, model, profiles };

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error.message}`);
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
  const personality = calculatePersonality(baseline.answers, questions, model);
  for (const axis of personalityAxisKeys(model)) {
    assertClose(personality[axis], baseline.personality[axis], 0.01, `${axis}`);
  }
});

test('Excelと同じ回答なら翻訳15軸・嗜好15軸・最終15軸が一致する', () => {
  const personality = calculatePersonality(baseline.answers, questions, model);
  const translated = translateToGameplay(personality, model);
  const preference = calculatePreferences(baseline.answers, questions, model);
  const finalAxes = calculateFinalAxes(translated, preference, model);
  for (const axis of gameAxisKeys(model)) {
    assertClose(translated[axis], baseline.translated[axis], 0.01, `翻訳 ${axis}`);
    assertClose(preference[axis], baseline.preference[axis], 0.01, `嗜好 ${axis}`);
    assertClose(finalAxes[axis], baseline.final[axis], 0.01, `最終 ${axis}`);
  }
});

test('Excelと同じ回答なら上位10件の順位とスコア（Raw / Percentile / Display / Rank）が一致する', () => {
  const result = runDiagnosis(baseline.answers, data, { topCount: 3 });
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

test('疑似回答7,000件で、全ポケモンが一度はTOP3に出る（Excel Calibration_Audit と同じ件数）', () => {
  // Excel Calibration_Audit と同じ対称分布（1〜5 = 10/20/40/20/10%）
  let seed = 2026;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = () => {
    const x = next();
    return x < 0.1 ? 1 : x < 0.3 ? 2 : x < 0.7 ? 3 : x < 0.9 ? 4 : 5;
  };
  const seen = new Set();
  const top1 = new Map();
  // 出にくいポケモンは Top3率 0.2% 前後。1,500件だと偶然0回になり得るため、Excel の監査と同じ7,000件で見る
  const samples = 7000;
  for (let i = 0; i < samples; i += 1) {
    const result = runDiagnosis(questions.map(pick), data, { topCount: 3 });
    result.top.forEach((entry) => seen.add(entry.profile.pokemon));
    const first = result.top[0].profile.pokemon;
    top1.set(first, (top1.get(first) ?? 0) + 1);
  }
  const missing = rosterFile.pokemon.map((entry) => entry.name).filter((name) => !seen.has(name));
  assert(!missing.length, `TOP3に一度も出ないポケモン: ${missing.join(', ')}`);
  const [maxName, maxCount] = [...top1.entries()].sort((a, b) => b[1] - a[1])[0];
  assert(maxCount / samples < 0.08, `1位が特定ポケモンに偏っている: ${maxName} ${(maxCount / samples * 100).toFixed(1)}%`);
});

test('1位の表示相性が一部に固まらず広がる（Excel Calibration_Audit: p10≈73 / 中央値≈91 / p90≈95）', () => {
  let seed = 777;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = () => {
    const x = next();
    return x < 0.1 ? 1 : x < 0.3 ? 2 : x < 0.7 ? 3 : x < 0.9 ? 4 : 5;
  };
  const scores = [];
  for (let i = 0; i < 1000; i += 1) scores.push(runDiagnosis(questions.map(pick), data, { topCount: 1 }).top[0].displayScore);
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
  let seed = 4242;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = () => {
    const x = next();
    return x < 0.1 ? 1 : x < 0.3 ? 2 : x < 0.7 ? 3 : x < 0.9 ? 4 : 5;
  };
  const counts = new Map();
  const samples = 2000;
  for (let i = 0; i < samples; i += 1) {
    const result = runDiagnosis(questions.map(pick), data, { topCount: 1 });
    const type = determinePersonalityType(result, personalityTypes, model);
    counts.set(type.name, (counts.get(type.name) ?? 0) + 1);
  }
  const missing = personalityTypes.types.filter((type) => !counts.has(type.name)).map((type) => type.name);
  assert(!missing.length, `一度も出ないタイプ: ${missing.join(', ')}`);
  const [name, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  assert(count / samples < 0.08, `${name} が ${(count / samples * 100).toFixed(1)}% に偏っている`);
});

test('「なぜこのポケモン？」の3軸が重複しない', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const result = runDiagnosis(randomAnswers(seed * 7), data);
    const comment = generateResultComment(result, result.top[0], { model, comments });
    const names = comment.sharedAxes.map((item) => item.axis);
    assert(names.length === 3 && new Set(names).size === 3, `軸が重複・不足: ${names.join(', ')}`);
  }
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

test('一致理由は、低い値同士なら低い側のラベル（例: 安全ライン）で説明する', () => {
  let checked = 0;
  for (let seed = 1; seed <= 60 && checked < 10; seed += 1) {
    const result = runDiagnosis(randomAnswers(seed * 11), data);
    const entry = result.top[0];
    const comment = generateResultComment(result, entry, { model, comments, personalityTypes });
    for (const item of comment.sharedAxes) {
      if (!(item.playerValue < 50 && item.pokemonValue < 50)) continue;
      const meta = model.gameAxes.find((axis) => axis.key === item.axis);
      assert(comment.matchText.includes(meta.lowLabel), `${item.axis}: 低い同士の一致なのに「${meta.lowLabel}」で説明していない`);
      assert(!comment.matchText.includes(`「${meta.highLabel}」`), `${item.axis}: 低い同士の一致を「${meta.highLabel}」と説明している`);
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

console.log(
  `\n結果: ${passed} 件成功 / ${failures.length} 件失敗\n`,
);
if (failures.length) {
  process.exitCode = 1;
}
