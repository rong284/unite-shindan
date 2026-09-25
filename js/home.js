/** トップページ。保存済みの回答・結果があれば導線を追加で出す。 */

import { loadJson } from './data.js';
import { loadProgress, loadResult } from './storage.js';
import { qs, withDebug } from './ui.js';

async function main() {
  // ロスター件数（「100体・140型」の表示）はデータから作る
  try {
    const roster = await loadJson('roster.json');
    const profileCount = roster.pokemon.reduce((total, entry) => total + (entry.profileCount ?? 1), 0);
    qs('#rosterChip').textContent = `${roster.pokemon.length}体・${profileCount}型`;
  } catch (error) {
    qs('#rosterChip').remove();
  }

  const savedResult = loadResult();
  if (savedResult?.top?.length) {
    const button = qs('#lastResultButton');
    button.href = withDebug(savedResult.resultPath ?? './result.html');
    qs('#lastResultSummary').textContent =
      `${savedResult.top[0].pokemon}（相性 ${Math.round(savedResult.top[0].matchScore)}）`;
    button.classList.remove('is-hidden');
  }

  const progress = loadProgress();
  const answered = progress?.answers?.filter((value) => typeof value === 'number').length ?? 0;
  if (progress && answered > 0 && answered < progress.answers.length) {
    const button = qs('#resumeButton');
    button.href = withDebug('./diagnosis.html');
    qs('#resumeProgress').textContent = `${answered} / ${progress.answers.length} 問まで回答済み`;
    button.classList.remove('is-hidden');
  }
}

main();
