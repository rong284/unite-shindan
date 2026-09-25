/** 診断ページ。質問の表示・回答の保存・結果ページへの受け渡しを担当する。 */

import { loadQuestionData } from './data.js';
import { clearAll, loadProgress, saveProgress } from './storage.js';
import { buildResultPath } from './share.js';
import { createElement, isDebugMode, qs, qsa, withDebug } from './ui.js';

const state = {
  questions: [],
  model: null,
  display: null,
  answers: [],
  step: 0,
  stepSize: 3,
};

function totalSteps() {
  return Math.max(1, Math.ceil(state.questions.length / state.stepSize));
}

function stepRange(step = state.step) {
  const start = step * state.stepSize;
  return { start, end: Math.min(start + state.stepSize, state.questions.length) };
}

function answeredCount() {
  return state.answers.filter((value) => typeof value === 'number').length;
}

function isStepComplete(step = state.step) {
  const { start, end } = stepRange(step);
  for (let index = start; index < end; index += 1) {
    if (typeof state.answers[index] !== 'number') return false;
  }
  return true;
}

/** 最初の未回答が含まれるステップ（再開時の表示位置）。 */
function firstIncompleteStep() {
  for (let step = 0; step < totalSteps(); step += 1) {
    if (!isStepComplete(step)) return step;
  }
  return totalSteps() - 1;
}

function renderProgress() {
  const answered = answeredCount();
  const total = state.questions.length;
  qs('#progress').hidden = false;
  qs('#progressFill').style.width = `${total ? (answered / total) * 100 : 0}%`;
  qs('#progressCount').textContent = `${answered} / ${total}`;
}

function renderStep() {
  const form = qs('#questionForm');
  const { start, end } = stepRange();
  form.innerHTML = '';

  for (let index = start; index < end; index += 1) {
    const question = state.questions[index];
    const block = createElement('fieldset', { className: 'question' });
    block.append(
      createElement('legend', { className: 'question-index', text: `Q${index + 1} / ${state.questions.length}` }),
      createElement('p', { className: 'question-text', text: question.text }),
    );

    const list = createElement('div', { className: 'choice-list' });
    for (const choice of state.model.answerScale) {
      const selected = state.answers[index] === choice.value;
      const label = createElement('label', {
        className: `choice${selected ? ' is-selected' : ''}`,
      });
      const input = createElement('input', {
        attrs: { type: 'radio', name: question.id, value: String(choice.value) },
      });
      input.checked = selected;
      input.addEventListener('change', () => selectAnswer(index, choice.value));
      label.append(input, createElement('span', { text: choice.label }));
      list.append(label);
    }
    block.append(list);
    form.append(block);
  }

  form.hidden = false;
  qs('#stepNav').hidden = false;
  qs('#prevButton').disabled = state.step === 0;
  const isLastStep = state.step === totalSteps() - 1;
  qs('#nextButton').querySelector('.button-main').textContent = isLastStep ? '結果を見る' : '次へ →';
  updateNextButton();
  renderProgress();
  renderDebugAnswers();
}

function updateNextButton() {
  const nextButton = qs('#nextButton');
  const complete = isStepComplete();
  nextButton.disabled = !complete;
  nextButton.style.opacity = complete ? '1' : '0.5';
}

function selectAnswer(index, value) {
  const wasComplete = isStepComplete(); // 回答の修正で勝手に進まないようにする
  state.answers[index] = value;
  saveProgress({ answers: state.answers, step: state.step });

  // 選択状態の見た目を更新
  const { start } = stepRange();
  const blocks = qsa('.question', qs('#questionForm'));
  const block = blocks[index - start];
  if (block) {
    qsa('.choice', block).forEach((choice) => {
      choice.classList.toggle('is-selected', choice.querySelector('input').checked);
    });
  }

  renderProgress();
  updateNextButton();
  renderDebugAnswers();

  const justCompleted = !wasComplete && isStepComplete();
  if (state.display?.diagnosis?.autoAdvance && justCompleted && state.step < totalSteps() - 1) {
    window.setTimeout(() => {
      if (isStepComplete()) goToStep(state.step + 1);
    }, state.display.diagnosis.autoAdvanceDelayMs ?? 200);
  }
}

function goToStep(step) {
  state.step = Math.max(0, Math.min(totalSteps() - 1, step));
  saveProgress({ answers: state.answers, step: state.step });
  renderStep();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function finish() {
  saveProgress({ answers: state.answers, step: state.step, completed: true });
  window.location.href = withDebug(buildResultPath(state.answers, state.model));
}

/* --- デバッグ機能（?debug=1 のときだけ） --- */

function renderDebugAnswers() {
  if (!isDebugMode()) return;
  qs('#debugAnswers').textContent = `回答: [${state.answers.map((value) => value ?? '-').join(', ')}]`;
}

function fillAnswers(mode) {
  const values = state.model.answerScale.map((item) => item.value);
  state.answers = state.questions.map(() =>
    mode === 'random' ? values[Math.floor(Math.random() * values.length)] : Number(mode),
  );
  saveProgress({ answers: state.answers, step: state.step });
  renderStep();
}

function setupDebug() {
  if (!isDebugMode()) return;
  const panel = qs('#debugPanel');
  panel.hidden = false;
  qsa('[data-fill]', panel).forEach((button) => {
    button.addEventListener('click', () => fillAnswers(button.dataset.fill));
  });
  qs('#debugFinish').addEventListener('click', finish);
}

async function main() {
  try {
    const data = await loadQuestionData();
    state.questions = data.questions;
    state.model = data.model;
    state.display = data.display;
    state.stepSize = Math.max(1, data.display?.diagnosis?.questionsPerStep ?? 3);
    state.answers = new Array(state.questions.length).fill(null);

    // 途中まで回答していれば復元する（質問数が変わっている場合は破棄される）
    const progress = loadProgress(state.questions.length);
    if (progress) {
      state.answers = progress.answers.map((value) =>
        state.model.answerScale.some((item) => item.value === value) ? value : null,
      );
      state.step = Math.min(progress.step ?? 0, totalSteps() - 1);
      if (isStepComplete(state.step)) state.step = firstIncompleteStep();
    }

    qs('#status').hidden = true;
    renderStep();
    setupDebug();
  } catch (error) {
    qs('#status').textContent = `データの読み込みに失敗しました: ${error.message}`;
    qs('#status').classList.add('notice-error');
    return;
  }

  qs('#prevButton').addEventListener('click', () => goToStep(state.step - 1));
  qs('#nextButton').addEventListener('click', () => {
    if (!isStepComplete()) return;
    if (state.step === totalSteps() - 1) {
      finish();
    } else {
      goToStep(state.step + 1);
    }
  });
  qs('#restartButton').addEventListener('click', () => {
    clearAll();
    state.answers = new Array(state.questions.length).fill(null);
    goToStep(0);
  });
}

main();
