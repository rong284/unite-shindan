/** ランダム抽選ページ。ポケモン単位で1体を選ぶ（型までは抽選しない）。 */

import { loadRandomData } from './data.js?v=a75fbeb4';
import { buildAbsoluteUrl, buildRandomPath, buildRandomShareText, buildTweetUrl, readRandomFromUrl } from './share.js?v=1b9d56b1';
import { createElement, qs, roleBadge, withDebug } from './ui.js?v=5fc01f45';

const ALL_MODE = 'all';

const state = {
  roster: null,
  display: null,
  modes: [],
  mode: ALL_MODE,
  current: null,
  spinning: false,
};

/** 抽選モードの一覧（全ポケモン＋ロール別）を作る。 */
function buildModes(roster) {
  const modes = [
    { key: ALL_MODE, label: '全ポケモン', pool: () => roster.pokemon },
  ];
  for (const role of roster.roles) {
    modes.push({
      key: role.key,
      label: role.key,
      pool: () => roster.pokemon.filter((entry) => entry.officialRole === role.key),
    });
  }
  return modes;
}

function currentMode() {
  return state.modes.find((mode) => mode.key === state.mode) ?? state.modes[0];
}

function renderModes() {
  const group = qs('#modeGroup');
  group.innerHTML = '';
  for (const mode of state.modes) {
    const button = createElement('button', {
      className: `chip-button${mode.key === state.mode ? ' is-active' : ''}`,
      text: mode.label,
      attrs: { type: 'button', 'aria-pressed': String(mode.key === state.mode), ...(mode.key === ALL_MODE ? {} : { 'data-role': mode.key }) },
    });
    button.addEventListener('click', () => {
      if (state.spinning) return;
      state.mode = mode.key;
      state.current = null;
      qs('#drawResult').hidden = true;
      qs('#shareButton').removeAttribute('href');
      const params = new URLSearchParams({ m: state.mode });
      window.history.replaceState(null, '', withDebug(`random.html?${params}`));
      renderModes();
    });
    group.append(button);
  }
  const pool = currentMode().pool();
  qs('#modeCount').textContent = `候補 ${pool.length}体`;
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function flavorFor(pokemon) {
  const flavors = state.display.random?.flavors ?? [];
  if (!flavors.length) return '';
  // 同じポケモンなら同じ一言になるようにしておく（シェアURLからの再表示用）
  const seed = [...pokemon.name].reduce((total, character) => total + character.codePointAt(0), pokemon.no ?? 0);
  return flavors[seed % flavors.length];
}

function renderResult(pokemon, { updateUrl = true, mode = state.mode } = {}) {
  state.current = pokemon;
  const card = qs('#drawResult');
  card.hidden = false;
  qs('#drawPokemon').textContent = pokemon.name;
  qs('#drawPokemon').dataset.role = pokemon.officialRole ?? '';
  roleBadge(pokemon.officialRole, qs('#drawRole'));
  const flavor = flavorFor(pokemon);
  qs('#drawFlavor').textContent = flavor;

  const share = state.display.share ?? {};
  const path = buildRandomPath(pokemon.no, mode);
  const url = buildAbsoluteUrl(path);
  const text = buildRandomShareText({ pokemon: pokemon.name, flavor }, share);
  qs('#shareButton').href = buildTweetUrl(text, url);

  if (updateUrl) {
    window.history.replaceState(null, '', withDebug(path));
  }
}

/** 抽選。少し「回している」演出を入れてから結果を出す。 */
function draw() {
  if (state.spinning) return;
  const mode = state.mode;
  const pool = currentMode().pool();
  if (!pool.length) return;
  const card = qs('#drawResult');
  card.hidden = false;
  card.classList.add('is-spinning');
  state.spinning = true;
  card.setAttribute('aria-busy', 'true');
  document.querySelectorAll('#modeGroup button, #drawButton, #redrawButton').forEach((button) => { button.disabled = true; });
  qs('#shareButton').hidden = true;
  qs('#drawRole').hidden = true;
  qs('#drawFlavor').textContent = '相棒を選んでいます…';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const duration = reducedMotion ? 0 : (state.display.random?.spinDurationMs ?? 700);
  const tick = window.setInterval(() => {
    const candidate = pickRandom(pool);
    qs('#drawPokemon').textContent = candidate.name;
    qs('#drawPokemon').dataset.role = candidate.officialRole ?? '';
  }, 70);

  window.setTimeout(() => {
    window.clearInterval(tick);
    card.classList.remove('is-spinning');
    state.spinning = false;
    document.querySelectorAll('#modeGroup button, #drawButton, #redrawButton').forEach((button) => { button.disabled = false; });
    qs('#shareButton').hidden = false;
    renderResult(pickRandom(pool), { mode });
    card.setAttribute('aria-busy', 'false');
    card.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'center' });
  }, duration);
}

async function main() {
  let data;
  try {
    data = await loadRandomData();
  } catch (error) {
    qs('#status').textContent = `データの読み込みに失敗しました: ${error.message}`;
    qs('#status').classList.add('notice-error');
    return;
  }

  state.roster = data.roster;
  state.display = data.display;
  // 共有URL（?p=番号&m=モード）から開かれた場合は、その結果を再表示する
  const fromUrl = readRandomFromUrl();
  state.modes = buildModes(data.roster);

  if (state.modes.some((mode) => mode.key === fromUrl.mode)) {
    state.mode = fromUrl.mode;
  }
  renderModes();

  qs('#status').hidden = true;
  qs('#randomRoot').hidden = false;

  if (fromUrl.pokemonNo) {
    const pokemon = data.roster.pokemon.find((entry) => entry.no === fromUrl.pokemonNo);
    if (pokemon) {
      if (state.mode !== ALL_MODE && pokemon.officialRole !== state.mode) {
        state.mode = pokemon.officialRole;
        renderModes();
      }
      renderResult(pokemon);
    }
  }

  qs('#drawButton').addEventListener('click', draw);
  qs('#redrawButton').addEventListener('click', draw);
}

main();
