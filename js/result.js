/** 結果ページ。診断の計算はすべて model.js / comment.js に任せ、ここは表示のみ。 */

import { loadDiagnosisData } from './data.js?v=a75fbeb4';
import { axisLookup, gameAxisKeys, personalityAxisKeys, runDiagnosis } from './model.js?v=fbba7c41';
import {
  determinePersonalityType,
  generateResultComment,
  axisSideLabel,
  hasMoveset,
  profileDisplayName,
  pickNotableAxes,
} from './comment.js?v=3e31696d';
import {
  buildAbsoluteUrl,
  buildDiagnosisShareText,
  buildResultPath,
  buildTweetUrl,
  readAnswersFromUrl,
} from './share.js?v=1b9d56b1';
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
} from './ui.js?v=5fc01f45';

function renderMainResult(result, type, comments) {
  const top = result.top[0];
  const profile = top.profile;
  qs('#topPokemon').textContent = profileDisplayName(profile);
  qs('#topPokemon').dataset.role = profile.officialRole ?? '';
  const provisional = profile.confidence === '低';
  qs('#confidenceNote').hidden = !provisional;
  qs('#confidenceNote').textContent = provisional ? '新登場のため、相性の評価は調整中です。' : '';
  // 順位は RankScore、表示は DisplayScore（Excel Match_140 と同じ使い分け）
  const closeMatch = result.top[1] && top.rankScore - result.top[1].rankScore < 1;
  qs('#closeMatchNote').hidden = !closeMatch;
  qs('#closeMatchNote').textContent = closeMatch ? '上位の候補は僅差です。気になる相棒から試してみてください。' : '';
  qs('#topScore').textContent = formatScore(top.displayScore);
  roleBadge(profile.officialRole, qs('#topRole'));
  const keywords = qs('#topKeywords');
  keywords.innerHTML = '';
  for (const word of profile.styleKeywords ?? []) keywords.append(createElement('li', { text: word }));
  keywords.hidden = !(profile.styleKeywords ?? []).length;
  qs('#typeName').textContent = type.name;
  qs('#typeTagline').textContent = type.tagline ?? '';

  // 技構成で型分けしていないポケモンでは、技構成の欄そのものを出さない
  const showMoveset = hasMoveset(profile, comments);
  qs('#movesetBlock').hidden = !showMoveset;
  qs('#profileScopeNote').hidden = showMoveset;
  qs('#topProfileName').textContent = profileDisplayName(profile) === 'ストライク'
    ? 'ハッサムのライセンス・ストライクで戦う型'
    : showMoveset ? `${profile.profileName}型` : '';

  qs('#typeLead').textContent = type.lead ?? '';
  qs('#typeBody').textContent = type.body ?? '';
  document.title = `${profileDisplayName(profile)}（相性${formatScore(top.displayScore)}）| あなたのOTPを見つけよう`;
}

function renderComment(comment) {
  const container = qs('#comment');
  container.innerHTML = '';
  for (const paragraph of [comment.matchText, comment.profileComment].filter(Boolean)) {
    container.append(createElement('p', { text: paragraph }));
  }
  const details = createElement('details', { className: 'comment-details' });
  details.append(createElement('summary', { className: 'details-summary', text: 'あなたのプレイの特徴を読む' }));
  for (const paragraph of [comment.summary, comment.grade].filter(Boolean)) {
    details.append(createElement('p', { text: paragraph }));
  }
  container.append(details);
}

/**
 * 候補に表示する相性。順位は RankScore で決まるため、2位以下の DisplayScore が1位を上回ることがある。
 * 「95点の2位より92点の1位を勧める」ように見えないよう、表示だけ1位の値で頭打ちにする（内部値は保持）。
 */
function shownScore(entry, cap) {
  return typeof cap === 'number' ? Math.min(entry.displayScore, cap) : entry.displayScore;
}

function renderRankList(container, entries, comments, { showRole = true, startNumber = 1, scoreCap = null } = {}) {
  container.innerHTML = '';
  entries.forEach((entry, index) => {
    const profile = entry.profile;
    const item = createElement('li', { className: 'rank-item' });
    item.append(
      createElement('span', { className: 'rank-number', text: String(index + startNumber) }),
      createElement('span', {
        className: 'rank-body',
        children: [
          createElement('span', {
            className: 'rank-name', text: profileDisplayName(profile),
            attrs: { 'data-role': profile.officialRole ?? '' },
          }),
          createElement('span', {
            className: 'rank-meta',
            children: [
              showRole && profile.officialRole ? roleBadge(profile.officialRole) : null,
              hasMoveset(profile, comments) ? document.createTextNode(profileDisplayName(profile) === 'ストライク' ? 'ハッサムのライセンス' : `${profile.profileName}型`) : null,
            ].filter(Boolean),
          }),
        ],
      }),
      createElement('span', { className: 'rank-score', text: formatScore(shownScore(entry, scoreCap)) }),
    );
    if (profile.confidence === '低') {
      item.querySelector('.rank-body').append(createElement('span', { className: 'rank-meta', text: '相性の評価は調整中' }));
    }
    container.append(item);
  });
}

function renderAlternates(container, top, scoreCap) {
  container.innerHTML = '';
  if (!top.alternates.length) {
    container.append(
      createElement('li', { text: `${top.profile.pokemon}は、技による型分けをしていないポケモンです。` }),
    );
    return;
  }
  for (const entry of top.alternates) {
    container.append(
      createElement('li', {
        text: `${entry.profile.profileName}型（相性 ${formatScore(shownScore(entry, scoreCap))}）`,
      }),
    );
  }
}

/** シェア文に載せる「得意傾向」。全体の中で特に寄っている軸の、寄っている側のラベル（例: 安全ライン）。 */
function buildAxisLines(result, data, count) {
  return pickNotableAxes(result, data.model, data.personalityTypes?.axisStats)
    .slice(0, count)
    .map((item) => axisSideLabel(item.axis, item.side, data.model));
}

function setupShare(result, type, data, resultPath) {
  const share = data.display.share ?? {};
  const top = result.top[0];
  const text = buildDiagnosisShareText(
    {
      pokemon: profileDisplayName(top.profile),
      typeName: type.name,
      tagline: type.tagline ?? '',
      score: formatScore(top.displayScore),
      axisLines: buildAxisLines(result, data, share.axisLineCount ?? 3),
    },
    share,
  );
  const absoluteUrl = buildAbsoluteUrl(resultPath);
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

  renderMainResult(result, type, data.comments);
  // キャラ名と同じロール色を、見出し・グラフ・ボタンにも使用する。
  applyAccentColor(getComputedStyle(qs('#topPokemon')).getPropertyValue('--role').trim());
  renderComment(comment);
  // 1位は上に大きく出しているので、ここでは2位以降（他の相棒候補）を並べる
  const scoreCap = result.top[0].displayScore;
  renderRankList(qs('#rankList'), result.top.slice(1), data.comments, { startNumber: 2, scoreCap });
  renderBipolarBars(qs('#personalityAxes'), personalityAxisKeys(data.model), result.personality, axes);
  renderBipolarBars(qs('#gameAxes'), gameAxisKeys(data.model), result.finalAxes, axes, { showCategory: true });
  renderRankList(
    qs('#profileList'),
    result.ranked.slice(0, data.display.result?.detailProfileCount ?? 6),
    data.comments,
    { scoreCap },
  );
  renderAlternates(qs('#alternateList'), result.top[0], scoreCap);

  const resultPath = buildResultPath(answers, data.model);
  setupShare(result, type, data, resultPath);
  renderDebug(result, type, data);

  qs('#randomLink').href = withDebug('./random.html');
  qs('#restartLink').href = withDebug('./diagnosis.html');

  qs('#status').hidden = true;
  qs('#resultRoot').hidden = false;
}

main();
