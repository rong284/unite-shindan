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

/**
 * ロール名をロール色のバッジにする（色は css の .role-badge[data-role] で定義）。
 * 既存の要素を渡すとその要素を書き換え、渡さなければ新しい span を返す。
 */
export function roleBadge(role, element = document.createElement('span')) {
  element.className = 'role-badge';
  element.textContent = role ?? '';
  element.dataset.role = role ?? '';
  element.hidden = !role;
  return element;
}

/** スコアの表示用整形（0〜100の整数）。 */
export function formatScore(value) {
  return Math.round(value ?? 0);
}

/**
 * 0〜100の軸を「0側ラベル ←→ 100側ラベル」の両端バーで並べる。
 * 真ん中（50）がどちらでもない位置で、端に近いほどその側の傾向が強い。
 * 寄っている側のラベルを強調する（差が threshold 未満なら両方控えめ）。
 */
export function renderBipolarBars(container, axisOrder, values, axisMeta, options = {}) {
  const threshold = options.threshold ?? 8;
  container.innerHTML = '';
  for (const axis of axisOrder) {
    const value = values[axis];
    if (typeof value !== 'number') continue;
    const meta = axisMeta[axis] ?? {};
    const percent = Math.max(0, Math.min(100, value));
    const lean = percent >= 50 + threshold ? 'high' : percent <= 50 - threshold ? 'low' : 'none';
    const row = createElement('div', { className: `bipolar-row lean-${lean}` });
    const label = `${meta.lowLabel ?? ''}〜${meta.highLabel ?? ''}: ${Math.round(percent)}`;
    row.append(
      createElement('span', { className: 'bipolar-label bipolar-low', text: meta.lowLabel || meta.nameJa || axis }),
      createElement('span', {
        className: 'bipolar-track',
        attrs: { role: 'img', 'aria-label': label },
        children: [createElement('span', { className: 'bipolar-marker', attrs: { style: `left:${percent}%` } })],
      }),
      createElement('span', { className: 'bipolar-label bipolar-high', text: meta.highLabel || meta.nameJa || axis }),
    );
    if (options.showCategory && meta.category && meta.category !== 'コア') {
      row.append(createElement('span', { className: 'bipolar-tag', text: meta.category }));
    }
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

/** #rrggbb の明るさ（0〜1）。文字色を白と黒のどちらにするか決めるのに使う。 */
function relativeLuminance(hexColor) {
  const hex = hexColor.replace('#', '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * ページ全体のアクセント色を差し替える（結果1位のロール色に揃える）。
 * アクセント上に載る文字色も明るさから自動で決める。
 */
export function applyAccentColor(color) {
  if (!color || !/^#[0-9a-f]{3,8}$/i.test(color)) return;
  const root = document.documentElement;
  root.style.setProperty('--accent', color);
  root.style.setProperty('--accent-ink', relativeLuminance(color) > 0.18 ? '#14100a' : '#ffffff');
}
