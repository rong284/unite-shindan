/**
 * 診断エンジンのテスト。
 *
 *   node tests/run-tests.mjs
 *
 * 外部ライブラリは使わない。data/*.json と、Excelの Simulator / Match_140 の計算結果
 * （tools/export_excel.py が出力する tests/fixtures/excel_baseline.json）を突き合わせる。
 */

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
import { determinePersonalityType, generateResultComment } from '../js/comment.js';
import { decodeAnswers, encodeAnswers } from '../js/share.js';

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

test('MatchScoreが0〜100に収まる（全プロファイル×複数回答パターン）', () => {
  for (const answers of [fill(1), fill(3), fill(5), randomAnswers(3)]) {
    const result = runDiagnosis(answers, data, { topCount: 3 });
    for (const entry of result.ranked) {
      assert(
        entry.matchScore >= 0 && entry.matchScore <= 100,
        `${entry.profile.id} のMatchScoreが範囲外 (${entry.matchScore})`,
      );
    }
  }
});

test('全140プロファイルが計算対象になる', () => {
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
    // 代表型は、そのポケモンの中で最も相性が高い型であること
    for (const entry of result.top) {
      for (const alternate of entry.alternates) {
        assert(
          entry.matchScore >= alternate.matchScore,
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

test('Excelと同じ回答ならMatchScoreと上位10件が一致する', () => {
  const result = runDiagnosis(baseline.answers, data, { topCount: 3 });
  assert(result.profileCount === baseline.profileCount, 'プロファイル件数が違う');
  baseline.top.forEach((expected, index) => {
    const actual = result.ranked[index];
    assert(
      actual.profile.id === expected.profileId,
      `${index + 1}位: Excel=${expected.profileId} / Web=${actual.profile.id}`,
    );
    assertClose(actual.matchScore, expected.matchScore, 0.01, `${index + 1}位のMatchScore`);
  });
});

console.log('\n■ タイプ判定・コメント・シェアURL');

test('どんな回答でも性格タイプが決まり、コメントが生成される', () => {
  const answerSets = [fill(1), fill(3), fill(5), ...[1, 2, 3, 4, 5, 6, 7, 8].map((seed) => randomAnswers(seed * 13))];
  const seen = new Set();
  for (const answers of answerSets) {
    const result = runDiagnosis(answers, data, {
      topCount: display.result.topCount,
      surprise: display.surprise,
    });
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

test('コメント用の文章パーツが全15軸ぶんそろっている', () => {
  for (const axis of gameAxisKeys(model)) {
    const phrase = comments.gameAxisPhrases[axis];
    assert(phrase?.high && phrase?.low, `${axis} の文章パーツが不足`);
  }
  for (const axis of personalityAxisKeys(model)) {
    const phrase = comments.personalityPhrases[axis];
    assert(phrase?.high && phrase?.low, `P_${axis} の文章パーツが不足`);
  }
});

test('「意外な適性」は上位3体と別のポケモンになる', () => {
  for (const answers of [fill(2), fill(4), randomAnswers(31), randomAnswers(77)]) {
    const result = runDiagnosis(answers, data, {
      topCount: display.result.topCount,
      surprise: display.surprise,
    });
    if (!result.surprise) continue;
    const displayed = result.top.map((entry) => entry.profile.pokemon);
    assert(
      !displayed.includes(result.surprise.profile.pokemon),
      `意外な適性がTOP3と重複: ${result.surprise.profile.pokemon}`,
    );
  }
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
  'index.html': 'js/home.js',
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
    assert(html.includes(`src="./${script}"`), `${page} が ${script} を読み込んでいない`);
    assert(html.includes('href="./css/style.css"'), `${page} がCSSを読み込んでいない`);
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
    'js/storage.js',
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

console.log(
  `\n結果: ${passed} 件成功 / ${failures.length} 件失敗\n`,
);
if (failures.length) {
  process.exitCode = 1;
}
