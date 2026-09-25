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
    form.append(renderQuestion(index));
  }

  form.hidden = false;
  qs('#stepNav').hidden = false;
  qs('#keyboardHint').hidden = false;
  qs('#prevButton').disabled = state.step === 0;
  const isLastStep = state.step === totalSteps() - 1;
  qs('#nextButton').querySelector('.button-main').textContent = isLastStep ? '結果を見る ▶' : '次へ ▶';
  updateNextButton();
  renderProgress();
  renderDebugAnswers();
}

/** 1問ぶんのカードを組み立てる。 */
function renderQuestion(index) {
  const question = state.questions[index];
  const card = createElement('fieldset', { className: 'question-card is-entering' });
  const heading = createElement('legend', {
    className: 'question-index',
    text: `Q${String(index + 1).padStart(2, '0')} / ${state.questions.length}`,
  });
  if (question.section) {
    heading.append(createElement('span', { className: 'question-section', text: question.section }));
  }
  card.append(heading, createElement('p', { className: 'question-text', text: question.text }));

  const list = createElement('div', { className: 'choice-list' });
  state.model.answerScale.forEach((choice, choiceIndex) => {
    const selected = state.answers[index] === choice.value;
    const label = createElement('label', { className: `choice${selected ? ' is-selected' : ''}` });
    const input = createElement('input', {
      attrs: { type: 'radio', name: question.id, value: String(choice.value) },
    });
    input.checked = selected;
    input.addEventListener('change', () => selectAnswer(index, choice.value));
    label.append(
      input,
      createElement('span', { className: 'choice-key', text: String(choiceIndex + 1) }),
      createElement('span', { text: choice.label }),
    );
    list.append(label);
  });

  card.append(list);
  return card;
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
  const card = qsa('.question-card', qs('#questionForm'))[index - start];
  if (card) {
    qsa('.choice', card).forEach((choice) => {
      const input = choice.querySelector('input');
      input.checked = Number(input.value) === value;
      choice.classList.toggle('is-selected', input.checked);
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

/** キーボードでも回答できるようにする（PCでの確認と回答のしやすさのため）。 */
function handleKeydown(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const { start, end } = stepRange();

  const choiceIndex = Number(event.key) - 1;
  if (Number.isInteger(choiceIndex) && choiceIndex >= 0 && choiceIndex < state.model.answerScale.length) {
    // 1画面に複数問ある場合は、最初の未回答の質問に入力する
    let target = start;
    for (let index = start; index < end; index += 1) {
      if (typeof state.answers[index] !== 'number') {
        target = index;
        break;
      }
    }
    selectAnswer(target, state.model.answerScale[choiceIndex].value);
    event.preventDefault();
    return;
  }

  if (event.key === 'ArrowLeft' && state.step > 0) {
    goToStep(state.step - 1);
    event.preventDefault();
  }
  if ((event.key === 'ArrowRight' || event.key === 'Enter') && isStepComplete()) {
    if (state.step === totalSteps() - 1) finish();
    else goToStep(state.step + 1);
    event.preventDefault();
  }
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

  window.addEventListener('keydown', handleKeydown);
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
