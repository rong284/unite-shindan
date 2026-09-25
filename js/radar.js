/**
 * ドット風のレーダーチャート（SVGを自前で組み立てる。ライブラリ不要）。
 *
 * 軸数は渡された配列の長さから決まるので、性格7軸でも15軸でもそのまま描ける。
 * 線と点は crispEdges で描き、頂点には四角いドットを置いてピクセルらしさを出す。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const START_ANGLE = -Math.PI / 2; // 真上から時計回りに配置する

function polarPoint(center, radius, index, count) {
  const angle = START_ANGLE + (index / count) * Math.PI * 2;
  return {
    x: center + radius * Math.cos(angle),
    y: center + radius * Math.sin(angle),
    angle,
  };
}

function polygonPoints(center, radius, count, values = null, maxValue = 100) {
  return Array.from({ length: count }, (unused, index) => {
    const ratio = values ? Math.max(0, Math.min(1, values[index] / maxValue)) : 1;
    const point = polarPoint(center, radius * ratio, index, count);
    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(' ');
}

function element(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

/**
 * レーダーチャートを描画する。
 * @param {HTMLElement} container 描画先
 * @param {{label:string, value:number}[]} axes 軸（順番どおりに時計回りで配置）
 * @param {{size?:number, rings?:number, maxValue?:number, showValues?:boolean}} options
 */
export function renderRadarChart(container, axes, options = {}) {
  const size = options.size ?? 240;
  const rings = options.rings ?? 4;
  const maxValue = options.maxValue ?? 100;
  const center = size / 2;
  const radius = size * 0.34; // ラベルを外側に置くぶん、図形は小さめにする
  const count = axes.length;

  container.innerHTML = '';
  if (!count) return;

  const svg = element('svg', {
    class: 'radar',
    viewBox: `0 0 ${size} ${size}`,
    role: 'img',
    'aria-label': axes.map((axis) => `${axis.label} ${Math.round(axis.value)}`).join('、'),
    'shape-rendering': 'crispEdges',
  });

  // 目盛りリング
  for (let ring = 1; ring <= rings; ring += 1) {
    svg.append(
      element('polygon', {
        class: 'radar-grid',
        points: polygonPoints(center, (radius * ring) / rings, count),
      }),
    );
  }

  // 中心から各軸への線
  axes.forEach((axis, index) => {
    const point = polarPoint(center, radius, index, count);
    svg.append(
      element('line', {
        class: 'radar-spoke',
        x1: center,
        y1: center,
        x2: point.x.toFixed(1),
        y2: point.y.toFixed(1),
      }),
    );
  });

  // スコアの多角形
  svg.append(
    element('polygon', {
      class: 'radar-shape',
      points: polygonPoints(
        center,
        radius,
        count,
        axes.map((axis) => axis.value),
        maxValue,
      ),
    }),
  );

  // 頂点のドットとラベル
  const dotSize = 6;
  axes.forEach((axis, index) => {
    const ratio = Math.max(0, Math.min(1, axis.value / maxValue));
    const point = polarPoint(center, radius * ratio, index, count);
    svg.append(
      element('rect', {
        class: 'radar-dot',
        x: (point.x - dotSize / 2).toFixed(1),
        y: (point.y - dotSize / 2).toFixed(1),
        width: dotSize,
        height: dotSize,
      }),
    );

    const labelPoint = polarPoint(center, radius + 22, index, count);
    const horizontal = Math.cos(labelPoint.angle);
    const anchor = Math.abs(horizontal) < 0.25 ? 'middle' : horizontal > 0 ? 'start' : 'end';
    const label = element('text', {
      class: 'radar-label',
      x: labelPoint.x.toFixed(1),
      y: labelPoint.y.toFixed(1),
      'text-anchor': anchor,
      'dominant-baseline': 'middle',
      'shape-rendering': 'auto',
    });
    label.textContent = axis.label;
    svg.append(label);

    if (options.showValues !== false) {
      const valuePoint = polarPoint(center, radius + 22, index, count);
      const value = element('text', {
        class: 'radar-value',
        x: valuePoint.x.toFixed(1),
        y: (valuePoint.y + 13).toFixed(1),
        'text-anchor': anchor,
        'dominant-baseline': 'middle',
        'shape-rendering': 'auto',
      });
      value.textContent = String(Math.round(axis.value));
      svg.append(value);
    }
  });

  container.append(svg);
}
