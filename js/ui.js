/** 画面まわりの小さな共通処理。ページ固有のロジックは各ページのJSに置く。 */

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

/** 要素を1つ作る簡易ヘルパー。 */
export function createElement(tag, options = {}) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.html !== undefined) element.innerHTML = options.html;
  for (const [key, value] of Object.entries(options.attrs ?? {})) {
    element.setAttribute(key, value);
  }
  for (const child of options.children ?? []) {
    element.append(child);
  }
  return element;
}

/** スコアの表示用整形（0〜100の整数）。 */
export function formatScore(value) {
  return Math.round(value ?? 0);
}

/** 0〜100の軸スコアをバーで並べる。 */
export function renderAxisBars(container, axisOrder, values, axisMeta, options = {}) {
  const max = options.max ?? 100;
  container.innerHTML = '';
  for (const axis of axisOrder) {
    const value = values[axis];
    if (typeof value !== 'number') continue;
    const percent = Math.max(0, Math.min(100, (value / max) * 100));
    const row = createElement('div', { className: 'axis-row' });
    row.append(
      createElement('span', { className: 'axis-name', text: axisMeta[axis]?.nameJa ?? axis }),
      createElement('span', {
        className: 'axis-track',
        children: [
          createElement('span', {
            className: 'axis-fill',
            attrs: { style: `width:${percent}%` },
          }),
        ],
      }),
      createElement('span', { className: 'axis-value', text: formatScore(value) }),
    );
    container.append(row);
  }
}

/** ?debug=1 が付いているか。 */
export function isDebugMode(search = window.location.search) {
  return new URLSearchParams(search).get('debug') === '1';
}

/** 現在のクエリを引き継いだリンク先を作る（debug状態を保つ）。 */
export function withDebug(path, search = window.location.search) {
  if (!isDebugMode(search)) return path;
  return path.includes('?') ? `${path}&debug=1` : `${path}?debug=1`;
}

/** クリップボードへコピー（失敗しても例外を投げない）。 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    return false;
  }
}
