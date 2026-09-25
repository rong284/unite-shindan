/**
 * localStorage への保存。
 * 保存できない環境（プライベートブラウズ等）でも診断自体は動くよう、すべて try/catch で包む。
 */

const NAMESPACE = 'unite-diagnosis';
const VERSION = 1;
const KEYS = {
  progress: `${NAMESPACE}:progress:v${VERSION}`,
  result: `${NAMESPACE}:result:v${VERSION}`,
};

function readJson(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    return false;
  }
}

function remove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    /* 保存できない環境では何もしない */
  }
}

/** 回答途中の状態を保存する。 */
export function saveProgress(progress) {
  return writeJson(KEYS.progress, { ...progress, savedAt: Date.now() });
}

/** 回答途中の状態を読み出す（質問数が変わっている場合は破棄）。 */
export function loadProgress(expectedQuestionCount) {
  const progress = readJson(KEYS.progress);
  if (!progress || !Array.isArray(progress.answers)) return null;
  if (expectedQuestionCount && progress.answers.length !== expectedQuestionCount) return null;
  return progress;
}

export function clearProgress() {
  remove(KEYS.progress);
}

/** 診断結果（回答・スコア・おすすめ）を保存する。 */
export function saveResult(result) {
  return writeJson(KEYS.result, { ...result, savedAt: Date.now() });
}

export function loadResult() {
  return readJson(KEYS.result);
}

export function clearResult() {
  remove(KEYS.result);
}

/** 「最初から診断し直す」用。 */
export function clearAll() {
  clearProgress();
  clearResult();
}
