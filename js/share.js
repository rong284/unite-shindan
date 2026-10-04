/**
 * 回答のURLエンコードと、Xへのシェア。
 *
 * 30問ぶんの回答を5進数の1つの整数に詰めて36進数の文字列にするので、
 * URLパラメータは十数文字で済む（例: ?a=3k7f1c9x2b）。
 * 結果ページはこの回答から全スコアを再計算するため、結果の再現に追加データは要らない。
 */

const ANSWER_PARAM = 'a';
const POKEMON_PARAM = 'p';
const MODE_PARAM = 'm';
const SENTINEL = 1n; // 先頭の0埋めが消えないようにする番兵

/** 回答値（1〜5）→ 尺度上のインデックス。 */
function scaleValues(model) {
  return model.answerScale.map((item) => item.value);
}

/** 回答配列を短い文字列へ。未回答は中立値として扱う。 */
export function encodeAnswers(answers, model) {
  const values = scaleValues(model);
  const radix = BigInt(values.length);
  const neutral = model.neutralAnswer ?? values[Math.floor(values.length / 2)];
  let packed = SENTINEL;
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const answer = answers[index];
    const digit = Math.max(0, values.indexOf(values.includes(answer) ? answer : neutral));
    packed = packed * radix + BigInt(digit);
  }
  return packed.toString(36);
}

/** 文字列 → 回答配列。壊れた文字列の場合は null。 */
export function decodeAnswers(code, model, questionCount) {
  if (!code || !/^[0-9a-z]+$/i.test(code)) return null;
  const values = scaleValues(model);
  const radix = BigInt(values.length);
  // 桁数が多いと Number では精度が足りないため BigInt で読む
  let packed = parseBigInt36(code);
  const answers = [];
  for (let index = 0; index < questionCount; index += 1) {
    const digit = Number(packed % radix);
    if (digit >= values.length) return null;
    answers.push(values[digit]);
    packed /= radix;
  }
  return packed === SENTINEL ? answers : null;
}

function parseBigInt36(code) {
  let value = 0n;
  for (const character of code.toLowerCase()) {
    const digit = BigInt(parseInt(character, 36));
    value = value * 36n + digit;
  }
  return value;
}

/** 結果ページのURL（回答つき）。ページ内リンク用に相対パスで返す。 */
export function buildResultPath(answers, model) {
  return `result.html?${ANSWER_PARAM}=${encodeAnswers(answers, model)}`;
}

/** シェア用の絶対URL。 */
export function buildAbsoluteUrl(relativePath) {
  return new URL(relativePath, window.location.href).href;
}

/** URLから回答を復元する。 */
export function readAnswersFromUrl(model, questionCount, search = window.location.search) {
  const code = new URLSearchParams(search).get(ANSWER_PARAM);
  return code ? decodeAnswers(code, model, questionCount) : null;
}

/** ランダム結果のURL（ポケモン番号とモード）。 */
export function buildRandomPath(pokemonNo, mode) {
  const params = new URLSearchParams();
  params.set(POKEMON_PARAM, String(pokemonNo));
  if (mode && mode !== 'all') params.set(MODE_PARAM, mode);
  return `random.html?${params.toString()}`;
}

export function readRandomFromUrl(search = window.location.search) {
  const params = new URLSearchParams(search);
  const no = Number.parseInt(params.get(POKEMON_PARAM) ?? '', 10);
  return {
    pokemonNo: Number.isFinite(no) ? no : null,
    mode: params.get(MODE_PARAM) ?? 'all',
  };
}

function formatHashtags(hashtags = []) {
  return hashtags.map((tag) => `#${tag}`).join(' ');
}

function fillTemplate(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) =>
    values[key] !== undefined && values[key] !== null ? String(values[key]) : '',
  );
}

/**
 * X の文字数（日本語などは2、半角英数は1で数える。URL はここに含めない）。
 */
export function xTextWeight(text) {
  return [...text].reduce((sum, character) => sum + (character.codePointAt(0) <= 0x10ff ? 1 : 2), 0);
}

// X の上限 280 から、URL（23）と区切りの改行（1）を引いた本文の上限
const X_TEXT_LIMIT = 280 - 23 - 1;

/**
 * 診断結果のシェア文を作る。
 * 長いポケモン名・タイプ名が重なって X の上限を超える場合は、得意傾向を末尾から1つずつ省く。
 */
export function buildDiagnosisShareText({ pokemon, typeName, tagline = '', score, axisLines, reference = false }, shareConfig) {
  // 参考結果（回答の情報が少ない）では相性の数値を載せない
  const template = reference && shareConfig.diagnosisReferenceTemplate ? shareConfig.diagnosisReferenceTemplate : shareConfig.diagnosisTemplate;
  const build = (lines) =>
    fillTemplate(template, {
      pokemon,
      typeName,
      tagline,
      score,
      axisLines: lines.join(' / '),
      hashtags: formatHashtags(shareConfig.hashtags),
    });
  let lines = [...axisLines];
  let text = build(lines);
  while (xTextWeight(text) > X_TEXT_LIMIT && lines.length > 1) {
    lines = lines.slice(0, -1);
    text = build(lines);
  }
  return text;
}

/** ランダム結果のシェア文を作る。 */
export function buildRandomShareText({ pokemon, flavor }, shareConfig) {
  return fillTemplate(shareConfig.randomTemplate, {
    pokemon,
    flavor,
    hashtags: formatHashtags(shareConfig.hashtags),
  });
}

/** X の投稿画面URL。 */
export function buildTweetUrl(text, url) {
  const params = new URLSearchParams({ text });
  if (url) params.set('url', url);
  return `https://twitter.com/intent/tweet?${params.toString()}`;
}
