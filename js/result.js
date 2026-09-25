/** 結果ページ。診断の計算はすべて model.js / comment.js に任せ、ここは表示と保存のみ。 */

import { loadDiagnosisData } from './data.js';
import { axisLookup, gameAxisKeys, personalityAxisKeys, runDiagnosis } from './model.js';
import { determinePersonalityType, generateResultComment, generateSurpriseComment } from './comment.js';
import { loadProgress, loadResult, saveResult } from './storage.js';
import {
  buildAbsoluteUrl,
  buildDiagnosisShareText,
  buildResultPath,
  buildTweetUrl,
  readAnswersFromUrl,
} from './share.js';
import { copyText, createElement, formatScore, isDebugMode, qs, renderAxisBars, withDebug } from './ui.js';

/** URL → 保存済み結果 → 回答途中データ の順で回答を探す。 */
function resolveAnswers(model, questionCount) {
  const fromUrl = readAnswersFromUrl(model, questionCount);
  if (fromUrl) return { answers: fromUrl, source: 'url' };

  const saved = loadResult();
  if (saved?.answers?.length === questionCount) return { answers: saved.answers, source: 'storage' };

  const progress = loadProgress(questionCount);
  if (progress?.answers?.every((value) => typeof value === 'number')) {
    return { answers: progress.answers, source: 'progress' };
  }
  return { answers: null, source: 'none' };
}

function renderMainResult(result, type) {
  const top = result.top[0];
  const profile = top.profile;
  qs('#topPokemon').textContent = profile.pokemon;
  qs('#topScore').textContent = formatScore(top.matchScore);
  qs('#topRole').textContent = [profile.officialRole, profile.profileLabel].filter(Boolean).join(' ・ ');
  qs('#typeName').textContent = type.name;
  qs('#typeTagline').textContent = type.tagline ?? '';
  qs('#topProfileName').textContent = profile.profileName;
  document.title = `${profile.pokemon}（相性${formatScore(top.matchScore)}）| ユナイトポケモン診断`;
}

function renderComment(comment) {
  const container = qs('#comment');
  container.innerHTML = '';
  for (const paragraph of comment.paragraphs) {
    container.append(createElement('p', { text: paragraph }));
  }
}

function renderRankList(container, entries, { showRole = true } = {}) {
  container.innerHTML = '';
  entries.forEach((entry, index) => {
    const profile = entry.profile;
    const item = createElement('li', { className: 'rank-item' });
    item.append(
      createElement('span', { className: 'rank-number', text: String(index + 1) }),
      createElement('span', {
        className: 'rank-body',
        children: [
          createElement('span', { className: 'rank-name', text: profile.pokemon }),
          createElement('span', {
            className: 'rank-meta',
            text: [showRole ? profile.officialRole : null, profile.profileName].filter(Boolean).join(' / '),
          }),
        ],
      }),
      createElement('span', { className: 'rank-score', text: formatScore(entry.matchScore) }),
    );
    container.append(item);
  });
}

function renderSurprise(result, data) {
  const surprise = result.surprise;
  if (!surprise || data.display.surprise?.enabled === false) return;
  qs('#surpriseCard').hidden = false;
  qs('#surprisePokemon').textContent = surprise.profile.pokemon;
  qs('#surpriseScore').textContent = `相性 ${formatScore(surprise.matchScore)}`;
  qs('#surpriseProfile').textContent =
    `${surprise.profile.officialRole} / ${surprise.profile.profileName}`;
  qs('#surpriseComment').textContent = generateSurpriseComment(result, surprise, data);
}

function renderAlternates(container, top) {
  container.innerHTML = '';
  if (!top.alternates.length) {
    container.append(
      createElement('li', { text: `${top.profile.pokemon}は型分けしていない（単一プロファイルの）ポケモンです。` }),
    );
    return;
  }
  for (const entry of top.alternates) {
    container.append(
      createElement('li', {
        text: `${entry.profile.profileName}（相性 ${formatScore(entry.matchScore)}）`,
      }),
    );
  }
}

/** シェア文に載せる「性格軸 スコア」の行。 */
function buildAxisLines(result, model, count) {
  const axes = axisLookup(model);
  return personalityAxisKeys(model)
    .map((axis) => ({ axis, value: result.personality[axis] }))
    .sort((a, b) => b.value - a.value)
    .slice(0, count)
    .map((entry) => `${axes[entry.axis].nameJa} ${formatScore(entry.value)}`);
}

function setupShare(result, type, data, resultPath) {
  const share = data.display.share ?? {};
  const top = result.top[0];
  const text = buildDiagnosisShareText(
    {
      pokemon: top.profile.pokemon,
      typeName: type.name,
      score: formatScore(top.matchScore),
      axisLines: buildAxisLines(result, data.model, share.axisLineCount ?? 3),
    },
    share,
  );
  const absoluteUrl = buildAbsoluteUrl(resultPath);
  qs('#shareButton').href = buildTweetUrl(text, absoluteUrl);
  qs('#sharePreview').textContent = `${text}\n${absoluteUrl}`;

  qs('#copyButton').addEventListener('click', async () => {
    const copied = await copyText(absoluteUrl);
    qs('#copyStatus').textContent = copied ? 'コピーしました！' : 'コピーできませんでした（URLを長押しで選択してください）';
  });
}

/** 保存する結果は、再表示とランダム抽選に必要な最小限にする。 */
function persistResult(result, type, resultPath) {
  saveResult({
    answers: result.answers,
    resultPath,
    typeName: type.name,
    typeId: type.id,
    personality: result.personality,
    finalAxes: result.finalAxes,
    top: result.top.slice(0, 10).map((entry) => ({
      pokemon: entry.profile.pokemon,
      profileId: entry.profile.id,
      profileName: entry.profile.profileName,
      officialRole: entry.profile.officialRole,
      matchScore: entry.matchScore,
    })),
    topPool: result.ranked
      .reduce((list, entry) => {
        if (!list.some((item) => item.pokemon === entry.profile.pokemon)) {
          list.push({
            pokemon: entry.profile.pokemon,
            profileName: entry.profile.profileName,
            officialRole: entry.profile.officialRole,
            matchScore: entry.matchScore,
          });
        }
        return list;
      }, [])
      .slice(0, 10),
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
  );

  const scroll = createElement('div', { className: 'debug-scroll' });
  scroll.append(
    table(
      `全${result.profileCount}プロファイルのMatchScore`,
      result.ranked.map((entry) => [
        entry.position,
        entry.profile.pokemon,
        entry.profile.profileName,
        round(entry.matchScore),
        round(entry.rmse),
      ]),
      ['#', 'ポケモン', '型', 'Match', 'RMSE'],
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

  const { answers, source } = resolveAnswers(data.model, data.questions.length);
  if (!answers) {
    qs('#status').innerHTML =
      '診断の回答が見つかりませんでした。<br><a href="./diagnosis.html">診断をはじめる</a>';
    return;
  }

  const result = runDiagnosis(
    answers,
    { questions: data.questions, model: data.model, profiles: data.profiles },
    { topCount: data.display.result?.topCount ?? 3, surprise: data.display.surprise },
  );
  const type = determinePersonalityType(result, data.personalityTypes, data.model);
  const comment = generateResultComment(result, result.top[0], data);
  const axes = axisLookup(data.model);

  renderMainResult(result, type);
  renderComment(comment);
  renderRankList(qs('#rankList'), result.top);
  renderSurprise(result, data);
  renderAxisBars(qs('#personalityAxes'), personalityAxisKeys(data.model), result.personality, axes, {
    max: data.display.result?.personalityBarMax ?? 100,
  });
  renderAxisBars(qs('#gameAxes'), gameAxisKeys(data.model), result.finalAxes, axes);
  renderRankList(
    qs('#profileList'),
    result.ranked.slice(0, data.display.result?.detailProfileCount ?? 6),
  );
  renderAlternates(qs('#alternateList'), result.top[0]);

  const resultPath = buildResultPath(answers, data.model);
  setupShare(result, type, data, resultPath);
  persistResult(result, type, resultPath);
  renderDebug(result, type, data);

  qs('#randomLink').href = withDebug('./random.html?m=top');
  qs('#restartLink').href = withDebug('./diagnosis.html');

  // URLに回答が無い状態で開かれた場合は、シェアできるURLに差し替えておく
  if (source !== 'url') {
    window.history.replaceState(null, '', withDebug(resultPath));
  }

  qs('#status').hidden = true;
  qs('#resultRoot').hidden = false;
}

main();
