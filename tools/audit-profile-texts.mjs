/**
 * 紹介文（ResultComment）・キーワード（StyleKeywords）・15軸の食い違いを機械的に洗い出す（データは書き換えない）。
 *
 *   node tools/audit-profile-texts.mjs
 *
 * 紹介文の言い回しを「どの軸のどちら側を言っているか」に対応づけ（下の PHRASES）、
 *   矛盾   … 言っている側と反対側に、軸の値が 50 から OPPOSITE 以上寄っている
 *   根拠弱 … 言っている側にはあるが、50 から WEAK 未満しか寄っていない
 * を一覧にする。キーワード同士・キーワードと紹介文の食い違いも見る。
 * 言い回しの対応づけは機械的なので、出てきたものは「人が確認する候補」として扱う。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const profiles = read('data/profiles.json').profiles;
const model = read('data/model.json');

const OPPOSITE = 10;
const WEAK = 10;

// [正規表現, 軸, 側]。紹介文に出てきたら、その軸のその側を主張しているとみなす
const PHRASES = [
  [/遠くから|遠距離|長い射程|長い距離|射程の長さ|超射程|狙撃/, 'Poke', 'high'],
  [/近い距離|近距離|張り付|懐に|接近コンボ/, 'Poke', 'low'],
  [/長く戦|長い殴り合い|長い撃ち合い|粘り|粘る|息切れしにく|撃ち続け|削り続け|殴り続け|戦い続け|居座/, 'FightTempo', 'high'],
  [/一瞬で|瞬間火力|一気に仕留め|素早く仕留め|短い時間で勝負|単発火力|大きな一発/, 'FightTempo', 'low'],
  [/動きを止め|足を止め|足止め|閉じ込め|ねむり|こおり状態|減速|妨害|縛|行動不能|引き寄せ|押し流/, 'Control', 'high'],
  [/味方を回復|味方にシールド|味方を強化|回復で味方|味方を支え|シールドで味方|回復しながら.*支え/, 'Support', 'high'],
  [/味方を守|味方の盾|守り抜|味方を逃がす|狙われた味方/, 'Peel', 'high'],
  [/前線|最前線|前に立|前に出て/, 'Frontline', 'high'],
  [/味方の後ろ|後ろから|前に出過ぎず|前に出ず|前に出るより/, 'Frontline', 'low'],
  [/飛び込|踏み込|後衛を|後衛に|後衛まで|切り込|突っ込/, 'Dive', 'high'],
  [/動き回|駆け回|駆け込|マップを|走り抜け|出入り|位置を変え/, 'Mobility', 'high'],
  [/足は遅|移動わざがない|移動技がない|決めた位置|陣取|構えて/, 'Mobility', 'low'],
  [/一人で|一人でも|自分の力で/, 'SelfSufficiency', 'high'],
  [/味方と一緒|味方と合わせ|みんなで勝つ/, 'SelfSufficiency', 'low'],
  [/育つ|終盤に|レベルが上がる|習得後|進化後|メガシンカまで育て/, 'FarmScaling', 'high'],
  [/序盤から|早めに有利|早い段階/, 'FarmScaling', 'low'],
  [/取り切り|レックウザ|ラストヒット/, 'ObjectiveSecure', 'high'],
  [/ゴール|空いた場所|空いたところ/, 'ScoringSide', 'high'],
  [/操作を極め|操作を磨|腕を磨|コンボ|操作が楽し|細かい操作|使いこなし/, 'Execution', 'high'],
  [/操作は素直|操作はシンプル|扱いやす/, 'Execution', 'low'],
  [/先を読|読んで|先回り|考えて動|組み立て/, 'Decision', 'high'],
  [/自分から仕掛け|先頭に立って|戦いを始め|集団戦を始め|起点を作|きっかけを作/, 'Engage', 'high'],
  [/待って|出方を見/, 'Engage', 'low'],
];

// キーワード → 軸・側（Excel Axes のキーワード列）
const keywordAxis = new Map();
for (const axis of model.gameAxes) {
  if (axis.keywordLow) keywordAxis.set(axis.keywordLow, [axis.key, 'low']);
  if (axis.keywordHigh) keywordAxis.set(axis.keywordHigh, [axis.key, 'high']);
}

// 並ぶと読み手が矛盾と感じやすいキーワードの組み合わせ（値としては両立し得る）
const AWKWARD_PAIRS = [
  ['後ろから狙う', '前線を支える'],
  ['遠くから削る', '前線を支える'],
  ['後ろから狙う', '後衛まで踏み込む'],
  ['待って返す', '自分から仕掛ける'],
  ['陣取って戦う', '空いたゴールを狙う'],
  ['一瞬で倒し切る', '長く戦う'],
];

// 「飛び込むより」「妨害わざはない」「前線を味方に任せ」のように、否定・対比で使っている言い回しは主張とみなさない
const NEGATION = /^[^、。]{0,8}?(より|ない|任せ|解除|切り替え)/;
const negated = (text, match) => NEGATION.test(text.slice(match.index + match[0].length));

const signed = (value) => value - 50;
const findings = [];

for (const profile of profiles) {
  const notes = [];
  const text = profile.resultComment ?? '';
  const claims = new Map();
  for (const [pattern, axis, side] of PHRASES) {
    const global = new RegExp(pattern.source, 'g');
    const match = [...text.matchAll(global)].find((candidate) => !negated(text, candidate));
    if (!match) continue;
    const key = `${axis}:${side}`;
    if (claims.has(key)) continue;
    claims.set(key, match[0]);
    const lean = signed(profile.axes[axis]);
    const toward = side === 'high' ? lean : -lean;
    if (toward <= -OPPOSITE) notes.push(`矛盾: 紹介文「${match[0]}」→ ${axis}=${profile.axes[axis]}`);
    else if (toward < WEAK) notes.push(`根拠弱: 紹介文「${match[0]}」→ ${axis}=${profile.axes[axis]}`);
  }
  // 紹介文の中で同じ軸の両側を言っている
  for (const [key, phrase] of claims) {
    const [axis, side] = key.split(':');
    const other = claims.get(`${axis}:${side === 'high' ? 'low' : 'high'}`);
    if (other && side === 'high') notes.push(`紹介文内で両側: 「${phrase}」と「${other}」（${axis}=${profile.axes[axis]}）`);
  }
  // キーワードと紹介文の向きが逆
  for (const word of profile.styleKeywords ?? []) {
    const [axis, side] = keywordAxis.get(word) ?? [];
    if (!axis) {
      notes.push(`キーワード「${word}」が語彙に無い`);
      continue;
    }
    const opposite = claims.get(`${axis}:${side === 'high' ? 'low' : 'high'}`);
    if (opposite) notes.push(`キーワード「${word}」と紹介文「${opposite}」が逆向き（${axis}=${profile.axes[axis]}）`);
  }
  for (const [a, b] of AWKWARD_PAIRS) {
    if (profile.styleKeywords.includes(a) && profile.styleKeywords.includes(b)) {
      notes.push(`キーワードの並びが矛盾して見える: 「${a}」＋「${b}」`);
    }
  }
  if (notes.length) findings.push({ profile, notes });
}

console.log(`紹介文・キーワード・15軸の監査: ${profiles.length}件中 ${findings.length}件に確認候補`);
console.log(`（矛盾 = 反対側に${OPPOSITE}以上 / 根拠弱 = 主張側に${WEAK}未満）\n`);
for (const { profile, notes } of findings) {
  console.log(`■ ${profile.id}（${profile.officialRole}）キーワード: ${profile.styleKeywords.join('・')}`);
  console.log(`  ${profile.resultComment}`);
  for (const note of notes) console.log(`  - ${note}`);
}
