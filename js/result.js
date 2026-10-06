/** 結果ページ。診断の計算はすべて model.js / comment.js に任せ、ここは表示のみ。 */

import { loadDiagnosisData } from './data.js?v=1cdc5971';
import { axisLookup, gameAxisKeys, personalityAxisKeys, runDiagnosis } from './model.js?v=a4573a67';
import {
  determinePersonalityType,
  generateResultComment,
  axisSideLabel,
  buildCandidateItems,
  heroMessage,
  isReferenceResult,
  profileDisplayName,
  profileStyleLabel,
  pickNotableAxes,
} from './comment.js?v=e097a142';
import {
  buildAbsoluteUrl,
  buildDiagnosisShareText,
  buildSharePath,
  buildTweetUrl,
  readAnswersFromUrl,
} from './share.js?v=01a47b80';
import {
  applyAccentColor,
  copyText,
  createElement,
  formatScore,
  isDebugMode,
  qs,
  renderBipolarBars,
  roleBadge,
  withDebug,
} from './ui.js?v=283494cb';

function renderMainResult(result, type, comments, reference) {
  // 参考結果（回答の情報が極端に少ない）では、相性の数値・タイプの説明・相性ベースの一言を出さず、理由を案内する
  const message = reference ? [reference.note, reference.hint].filter(Boolean).join('') : heroMessage(result, comments);
  qs('#heroMessage').textContent = message;
  qs('#heroMessage').hidden = !message;
  const top = result.top[0];
  const profile = top.profile;
  qs('#resultLabel').textContent = reference ? reference.candidateLabel : 'あなたのOTPは';
  qs('#topPokemon').textContent = profileDisplayName(profile);
  // 長い名前（アローラキュウコン、メガリザードンX など）はスマホで1文字だけ折り返さないよう小さめに表示する
  qs('#topPokemon').classList.toggle('is-long', [...profileDisplayName(profile)].length >= 7);
  qs('#topPokemon').dataset.role = profile.officialRole ?? '';
  const provisional = profile.confidence === '低';
  qs('#confidenceNote').hidden = !provisional;
  qs('#confidenceNote').textContent = provisional ? '参戦後のデータがまだ少ないため、相性評価を調整中です。' : '';
  // 相性の数値は1位だけに出す（順位は RankScore、表示は DisplayScore。Excel Match_140 と同じ使い分け）
  qs('#topScore').textContent = reference ? '' : formatScore(top.displayScore);
  qs('#topScore').hidden = Boolean(reference);
  qs('#topScoreLabel').textContent = reference ? reference.scoreLabel : '相性 / 100';
  qs('.result-score').classList.toggle('is-reference', Boolean(reference));
  qs('#scoreNote').hidden = Boolean(reference);
  roleBadge(profile.officialRole, qs('#topRole'));
  const keywords = qs('#topKeywords');
  keywords.innerHTML = '';
  for (const word of profile.styleKeywords ?? []) keywords.append(createElement('li', { text: word }));
  keywords.hidden = !(profile.styleKeywords ?? []).length;
  qs('#typeBadgeLabel').textContent = reference ? '今回の結果' : 'あなたのタイプ';
  qs('#typeName').textContent = reference ? reference.typeLabel : type.name;
  qs('#typeTagline').textContent = reference ? '' : type.tagline ?? '';

  // 技構成で分けていないポケモンでは、戦い方の欄そのものを出さない
  const style = profileStyleLabel(profile, comments);
  qs('#movesetBlock').hidden = !style;
  qs('#topProfileName').textContent = style;
  qs('#movesetNote').hidden = Boolean(reference);

  qs('#typeCardTitle').textContent = reference ? '今回の結果について' : 'あなたはこんなタイプ';
  qs('#typeLead').textContent = reference ? reference.typeLabel : type.lead ?? '';
  qs('#typeBody').textContent = reference ? reference.typeNote : type.body ?? '';
  qs('#typeNote').hidden = Boolean(reference);
  document.title = reference
    ? `${profileDisplayName(profile)}（${reference.scoreLabel}）| あなたのOTPを見つけよう`
    : `${profileDisplayName(profile)}（相性${formatScore(top.displayScore)}）| あなたのOTPを見つけよう`;
}

function renderComment(comment, reference) {
  // 参考結果では「あなたと一致した傾向」を断定せず、ポケモン（戦い方）の紹介だけを出す
  qs('#reasonTitle').textContent = reference ? 'お試し候補について' : 'この相棒が合いそうな理由';
  const labels = reference ? [] : comment.sharedLabels ?? [];
  const tags = qs('#reasonTags');
  tags.innerHTML = '';
  for (const label of labels) tags.append(createElement('li', { text: label }));
  tags.hidden = !labels.length;
  const container = qs('#comment');
  container.innerHTML = '';
  for (const paragraph of [reference ? '' : comment.matchText, comment.profileComment].filter(Boolean)) {
    container.append(createElement('p', { text: paragraph }));
  }
  if (reference) return;
  const details = createElement('details', { className: 'comment-details' });
  details.append(createElement('summary', { className: 'details-summary', text: 'あなたのプレイの好みを読む' }));
  for (const paragraph of [comment.summary, comment.grade].filter(Boolean)) {
    details.append(createElement('p', { text: paragraph }));
  }
  container.append(details);
}

/** 2位以下の候補。相性の数値は出さず、戦い方と1行説明、「こちらもおすすめ」を添える。 */
function renderCandidates(container, entries, comments) {
  container.innerHTML = '';
  buildCandidateItems(entries, comments).forEach((item, index) => {
    const li = createElement('li', { className: 'rank-item rank-item-candidate' });
    li.append(
      createElement('span', { className: 'rank-number', text: String(index + 2) }),
      createElement('span', {
        className: 'rank-body',
        children: [
          createElement('span', {
            className: 'rank-head',
            children: [
              createElement('span', { className: 'rank-name', text: item.pokemon, attrs: { 'data-role': item.role } }),
              createElement('span', { className: 'rank-label', text: item.label }),
            ],
          }),
          createElement('span', {
            className: 'rank-meta',
            children: [
              item.role ? roleBadge(item.role) : null,
              item.style ? document.createTextNode(item.style) : null,
              // 戦い方の名前と混同しないよう、データ不足の印は小さなバッジで出す
              item.provisional
                ? createElement('span', { className: 'status-badge', text: '評価調整中', attrs: { title: '参戦後のデータがまだ少ないため、相性評価を調整中です。' } })
                : null,
            ].filter(Boolean),
          }),
          createElement('span', { className: 'rank-summary', text: item.summary }),
        ],
      }),
    );
    container.append(li);
  });
}

/** 「もっと診断の中身を見る」の上位の戦い方（順位だけ。数値は1位のカードにだけ出す）。 */
function renderProfileList(container, entries, comments) {
  container.innerHTML = '';
  entries.forEach((entry, index) => {
    const profile = entry.profile;
    const style = profileStyleLabel(profile, comments);
    container.append(
      createElement('li', {
        className: 'rank-item',
        children: [
          createElement('span', { className: 'rank-number', text: String(index + 1) }),
          createElement('span', {
            className: 'rank-body',
            children: [
              createElement('span', { className: 'rank-name', text: profileDisplayName(profile), attrs: { 'data-role': profile.officialRole ?? '' } }),
              createElement('span', {
                className: 'rank-meta',
                children: [roleBadge(profile.officialRole), style ? document.createTextNode(style) : null].filter(Boolean),
              }),
            ],
          }),
        ],
      }),
    );
  });
}

function renderAlternates(container, top, comments) {
  container.innerHTML = '';
  if (!top.alternates.length) {
    container.append(
      createElement('li', { text: `${profileDisplayName(top.profile)}は、わざ構成で戦い方を分けていないポケモンです。` }),
    );
    return;
  }
  for (const entry of top.alternates) {
    container.append(createElement('li', { text: profileStyleLabel(entry.profile, comments) }));
  }
}

/** シェア文に載せる「好みの傾向」。全体の中で特に寄っている軸の、寄っている側のラベル（例: 安全に戦う）。 */
function buildAxisLines(result, data, count) {
  return pickNotableAxes(result, data.model, data.personalityTypes?.axisStats)
    .slice(0, count)
    .map((item) => axisSideLabel(item.axis, item.side, data.model));
}

function setupShare(result, type, data, answers, reference) {
  const share = data.display.share ?? {};
  const top = result.top[0];
  const text = buildDiagnosisShareText(
    {
      pokemon: profileDisplayName(top.profile),
      typeName: type.name,
      tagline: type.tagline ?? '',
      score: formatScore(top.displayScore),
      axisLines: buildAxisLines(result, data, share.axisLineCount ?? 3),
      reference: Boolean(reference),
    },
    share,
  );
  // リンクカードに結果のポケモンの画像が出るシェア用ページを経由する（参考結果は共通カード）
  const rosterEntry = reference ? null : data.roster.find((entry) => entry.name === top.profile.pokemon);
  const absoluteUrl = buildAbsoluteUrl(buildSharePath(answers, data.model, rosterEntry?.no ?? null));
  qs('#shareButton').href = buildTweetUrl(text, absoluteUrl);
  qs('#sharePreview').textContent = `${text}\n${absoluteUrl}`;

  qs('#copyButton').addEventListener('click', async () => {
    const copied = await copyText(absoluteUrl);
    if (!copied) qs('#sharePreview').closest('details').open = true;
    qs('#copyStatus').textContent = copied ? '結果URLをコピーしました。' : 'コピーできませんでした。「シェア文を確認する」内のURLを選択してください。';
  });
}

function renderDebug(result, type, data) {
  if (!isDebugMode()) return;
  const panel = qs('#debugPanel');
  panel.hidden = false;
  const axes = axisLookup(data.model);
  const container = qs('#debugContent');
  container.innerHTML = '';

  const table = (caption, rows, headers) => {
    const element = createElement('table', { className: 'debug-table' });
    element.append(createElement('caption', { text: caption, className: 'small-text' }));
    const head = createElement('tr');
    headers.forEach((header) => head.append(createElement('th', { text: header })));
    element.append(head);
    rows.forEach((row) => {
      const tr = createElement('tr');
      row.forEach((cell) => tr.append(createElement('td', { text: String(cell) })));
      element.append(tr);
    });
    return element;
  };

  const round = (value) => (typeof value === 'number' ? value.toFixed(2) : value);

  container.append(
    table(
      '性格7軸',
      personalityAxisKeys(data.model).map((axis) => [
        axes[axis].nameJa,
        round(result.personality[axis]),
        round(result.normalizedPersonality[axis]),
      ]),
      ['軸', 'Score', 'Norm'],
    ),
    table(
      '15ゲーム軸（翻訳前 / 嗜好 / Blend / 最終）',
      gameAxisKeys(data.model).map((axis) => [
        axes[axis].nameJa,
        round(result.translated[axis]),
        round(result.preference[axis]),
        data.model.matching[axis]?.preferenceBlend ?? 0,
        round(result.finalAxes[axis]),
      ]),
      ['軸', '翻訳', '嗜好', 'Blend', '最終'],
    ),
    table(
      `1位（${result.top[0].profile.id}）の軸別誤差 / ΣWeight=${round(result.top[0].weightSum)}`,
      gameAxisKeys(data.model).map((axis) => {
        const detail = result.top[0].axisErrors[axis] ?? {};
        return [
          axes[axis].nameJa,
          round(detail.pokemonValue),
          round(detail.playerValue),
          round(detail.weight),
          round(detail.penalty),
          round(detail.error),
        ];
      }),
      ['軸', 'ポケモン', 'プレイヤー', 'Weight', 'Penalty', '誤差'],
    ),
    createElement('p', {
      className: 'small-text',
      text: `タイプ判定: ${type.name}（score=${round(type.score)} / 次点: ${(type.runnerUps ?? [])
        .map((item) => `${item.name} ${round(item.score)}`)
        .join(', ')}）`,
    }),
    createElement('p', {
      className: 'small-text',
      text: `PlayerSignal=${round(result.playerSignal)}（Shapeの重み ${round(
        (data.model.matchModel?.baseShapeWeight ?? 0) * result.playerSignal,
      )}）`,
    }),
  );

  const scroll = createElement('div', { className: 'debug-scroll' });
  scroll.append(
    table(
      `全${result.profileCount}プロファイル（RankScore順）`,
      result.ranked.map((entry) => [
        entry.position,
        entry.profile.pokemon,
        entry.profile.profileName,
        round(entry.rankScore),
        entry.displayScore,
        round(entry.percentile),
        round(entry.rawMatch),
        round(entry.absoluteScore),
        round(entry.shapeScore),
        round(entry.specificityCorrection),
        round(entry.rankBias),
      ]),
      ['#', 'ポケモン', '型', 'Rank', 'Disp', 'Pct', 'Raw', 'Abs', 'Shape', 'Spec', 'Bias'],
    ),
  );
  container.append(scroll);
}

async function main() {
  let data;
  try {
    data = await loadDiagnosisData();
  } catch (error) {
    qs('#status').textContent = `データの読み込みに失敗しました: ${error.message}`;
    qs('#status').classList.add('notice-error');
    return;
  }

  const answers = readAnswersFromUrl(data.model, data.questions.length);
  if (!answers) {
    qs('#status').innerHTML =
      '診断の回答が見つかりませんでした。<br><a href="./diagnosis.html">診断をはじめる</a>';
    return;
  }

  const result = runDiagnosis(
    answers,
    { questions: data.questions, model: data.model, profiles: data.profiles },
    { topCount: data.display.result?.topCount ?? 5 },
  );
  const type = determinePersonalityType(result, data.personalityTypes, data.model);
  const comment = generateResultComment(result, result.top[0], data);
  const axes = axisLookup(data.model);

  const reference = isReferenceResult(result, data.display) ? data.display.result.referenceResult : null;
  renderMainResult(result, type, data.comments, reference);
  // キャラ名と同じロール色を、見出し・グラフ・ボタンにも使用する。
  applyAccentColor(getComputedStyle(qs('#topPokemon')).getPropertyValue('--role').trim());
  renderComment(comment, reference);
  // 1位は上に大きく出しているので、ここでは2位以降（他の相棒候補）を並べる
  qs('#candidatesTitle').textContent = reference ? 'ほかのお試し候補' : '他にも相性が良さそうな相棒候補';
  renderCandidates(qs('#rankList'), result.top.slice(1), data.comments);
  renderBipolarBars(qs('#personalityAxes'), personalityAxisKeys(data.model), result.personality, axes);
  renderBipolarBars(qs('#gameAxes'), gameAxisKeys(data.model), result.finalAxes, axes);
  renderProfileList(qs('#profileList'), result.ranked.slice(0, data.display.result?.detailProfileCount ?? 6), data.comments);
  renderAlternates(qs('#alternateList'), result.top[0], data.comments);

  setupShare(result, type, data, answers, reference);
  renderDebug(result, type, data);

  qs('#randomLink').href = withDebug('./random.html');
  qs('#restartLink').href = withDebug('./diagnosis.html');

  qs('#status').hidden = true;
  qs('#resultRoot').hidden = false;
}

main();
