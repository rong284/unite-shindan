/**
 * data/*.json の読み込み。
 *
 * パスは import.meta.url からの相対で解決するため、
 * GitHub Pages のサブディレクトリ（/repo-name/）でもそのまま動く。
 */

const DATA_DIR = '../data/';

/** data/ 以下のJSONを1つ読む。 */
export async function loadJson(fileName) {
  const url = new URL(DATA_DIR + fileName, import.meta.url);
  // Excel更新後の古いJSONがブラウザに残らないよう、毎回サーバーに更新を確認する（未更新なら304で軽い）
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`${fileName} の読み込みに失敗しました (${response.status})`);
  }
  return response.json();
}

/** 診断に必要なデータ一式。 */
export async function loadDiagnosisData() {
  const [model, questions, profiles, comments, personalityTypes, display] = await Promise.all([
    loadJson('model.json'),
    loadJson('questions.json'),
    loadJson('profiles.json'),
    loadJson('comments.json'),
    loadJson('personality-types.json'),
    loadJson('display.json'),
  ]);

  return {
    model,
    questions: questions.questions,
    profiles: profiles.profiles,
    comments,
    personalityTypes,
    display,
    meta: {
      questions: questions.meta,
      profiles: profiles.meta,
      model: model.meta,
    },
  };
}

/** 質問ページで使う最小セット（プロファイルは結果ページまで不要）。 */
export async function loadQuestionData() {
  const [model, questions, display] = await Promise.all([
    loadJson('model.json'),
    loadJson('questions.json'),
    loadJson('display.json'),
  ]);
  return { model, questions: questions.questions, display };
}

/** ランダム抽選ページ用。 */
export async function loadRandomData() {
  const [roster, display] = await Promise.all([loadJson('roster.json'), loadJson('display.json')]);
  return { roster, display };
}
