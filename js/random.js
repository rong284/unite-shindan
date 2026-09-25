/** ランダム抽選ページ。ポケモン単位で1体を選ぶ（型までは抽選しない）。 */

import { loadRandomData } from './data.js';
import { loadResult } from './storage.js';
import { buildAbsoluteUrl, buildRandomPath, buildRandomShareText, buildTweetUrl, readRandomFromUrl } from './share.js';
import { createElement, qs, withDebug } from './ui.js';

const ALL_MODE = 'all';
const TOP_MODE = 'top';

const state = {
  roster: null,
  display: null,
  modes: [],
  mode: ALL_MODE,
  savedResult: null,
  current: null,
};

/** 抽選モードの一覧を作る。診断結果が保存されているときだけTOP10モードを足す。 */
function buildModes(roster, savedResult) {
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
  if (savedResult?.topPool?.length) {
    modes.push({
      key: TOP_MODE,
      label: '診断TOP10から',
      pool: () =>
        savedResult.topPool
          .map((entry) => roster.pokemon.find((pokemon) => pokemon.name === entry.pokemon))
          .filter(Boolean),
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
      attrs: { type: 'button' },
    });
    button.addEventListener('click', () => {
      state.mode = mode.key;
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

function renderResult(pokemon, { updateUrl = true } = {}) {
  state.current = pokemon;
  const card = qs('#drawResult');
  card.hidden = false;
  qs('#drawPokemon').textContent = pokemon.name;
  qs('#drawRole').textContent = pokemon.officialRole ?? '';
  const flavor = flavorFor(pokemon);
  qs('#drawFlavor').textContent = flavor;

  const share = state.display.share ?? {};
  const path = buildRandomPath(pokemon.no, state.mode);
  const url = buildAbsoluteUrl(path);
  const text = buildRandomShareText({ pokemon: pokemon.name, flavor }, share);
  qs('#shareButton').href = buildTweetUrl(text, url);

  if (updateUrl) {
    window.history.replaceState(null, '', withDebug(path));
  }
}

/** 抽選。少し「回している」演出を入れてから結果を出す。 */
function draw() {
  const pool = currentMode().pool();
  if (!pool.length) return;
  const card = qs('#drawResult');
  card.hidden = false;
  card.classList.add('is-spinning');

  const duration = state.display.random?.spinDurationMs ?? 700;
  const tick = window.setInterval(() => {
    qs('#drawPokemon').textContent = pickRandom(pool).name;
  }, 70);

  window.setTimeout(() => {
    window.clearInterval(tick);
    card.classList.remove('is-spinning');
    renderResult(pickRandom(pool));
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  state.savedResult = loadResult();
  state.modes = buildModes(data.roster, state.savedResult);

  // 共有URL（?p=番号&m=モード）から開かれた場合は、その結果を再表示する
  const fromUrl = readRandomFromUrl();
  if (state.modes.some((mode) => mode.key === fromUrl.mode)) {
    state.mode = fromUrl.mode;
  }
  renderModes();

  qs('#status').hidden = true;
  qs('#randomRoot').hidden = false;

  if (fromUrl.pokemonNo) {
    const pokemon = data.roster.pokemon.find((entry) => entry.no === fromUrl.pokemonNo);
    if (pokemon) renderResult(pokemon, { updateUrl: false });
  }

  qs('#drawButton').addEventListener('click', draw);
  qs('#redrawButton').addEventListener('click', draw);
}

main();
