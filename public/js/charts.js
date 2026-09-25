import { esc } from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 900;
const H = 320;
const PAD = { top: 12, right: 110, bottom: 28, left: 64 };

function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

/**
 * 시계열 라인 차트 (단일 y축). 범례 + 끝점 직접 라벨 + 크로스헤어 툴팁.
 * series: [{ name, color(css var), values: number|null[] }]
 */
export function lineChart(container, { dates, series, formatY, formatTip }) {
  container.innerHTML = '';
  container.classList.add('chart');
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  container.append(legend);

  const all = series.flatMap((s) => s.values.filter((v) => v != null));
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const x = (i) => PAD.left + (i / Math.max(1, dates.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v) => PAD.top + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PAD.top - PAD.bottom);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': series.map((s) => s.name).join(', ') + ' 추이' });
  for (const t of ticks) {
    svg.append(el('line', { x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t), class: t === yMin ? 'axis-line' : 'grid-line' }));
    svg.append(el('text', { x: PAD.left - 8, y: y(t) + 4, 'text-anchor': 'end' }, formatY(t)));
  }
  const xCount = Math.min(6, dates.length);
  for (let k = 0; k < xCount; k++) {
    const i = Math.round((k / Math.max(1, xCount - 1)) * (dates.length - 1));
    svg.append(el('text', { x: x(i), y: H - 8, 'text-anchor': k === 0 ? 'start' : k === xCount - 1 ? 'end' : 'middle' }, dates[i]));
  }

  const labelYs = [];
  for (const s of series) {
    let d = '';
    s.values.forEach((v, i) => { if (v != null) d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
    svg.append(el('path', { d, class: 'series', stroke: s.color }));
    const lastIdx = s.values.findLastIndex((v) => v != null);
    if (lastIdx >= 0 && series.length <= 4) {
      let ly = y(s.values[lastIdx]) + 4;
      while (labelYs.some((o) => Math.abs(o - ly) < 13)) ly += 13;
      labelYs.push(ly);
      svg.append(el('text', { x: x(lastIdx) + 8, y: ly, style: 'fill: var(--text-2)' }, s.name));
    }
  }

  const cross = el('line', { y1: PAD.top, y2: H - PAD.bottom, class: 'crosshair', visibility: 'hidden' });
  const dots = series.map((s) => el('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }));
  svg.append(cross, ...dots);
  const hit = el('rect', { x: PAD.left, y: PAD.top, width: W - PAD.left - PAD.right, height: H - PAD.top - PAD.bottom, fill: 'transparent' });
  svg.append(hit);
  container.append(svg);

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  container.append(tip);

  const hide = () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); };
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(dates.length - 1, Math.round(((px - PAD.left) / (W - PAD.left - PAD.right)) * (dates.length - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    series.forEach((s, k) => {
      const v = s.values[i];
      dots[k].setAttribute('visibility', v == null ? 'hidden' : 'visible');
      if (v != null) { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(v)); }
    });
    tip.innerHTML = `<div class="t">${esc(dates[i])}</div>` + series.map((s) =>
      `<div class="r"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><b>${esc(formatTip(s.values[i]))}</b></div>`).join('');
    tip.style.display = 'block';
    const left = (x(i) / W) * rect.width;
    tip.style.left = `${Math.min(left + 12, rect.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${legend.offsetHeight + 8}px`;
  });
}

/**
 * 발산형 히트맵 (음수=빨강, 0=중립 회색, 양수=파랑). 값은 항상 텍스트로 함께 표시.
 * cells[row][col] = { value, sub, title } | null
 */
export function heatmap(container, { rows, cols, cells, format, maxAbs }) {
  const scale = maxAbs || Math.max(0.0001, ...cells.flat().filter(Boolean).map((c) => Math.abs(c.value)));
  const color = (v) => {
    const t = Math.min(1, Math.abs(v) / scale);
    const pole = v >= 0 ? 'var(--div-pos)' : 'var(--div-neg)';
    return `color-mix(in oklab, ${pole} ${Math.round(t * 70)}%, var(--div-mid))`;
  };
  const html = [
    `<div class="heat" style="grid-template-columns: minmax(110px, auto) repeat(${cols.length}, minmax(90px, 1fr))">`,
    '<div></div>',
    ...cols.map((c) => `<div class="hdr">${esc(c)}</div>`),
    ...rows.flatMap((r, ri) => [
      `<div class="rowhdr">${esc(r)}</div>`,
      ...cols.map((_, ci) => {
        const c = cells[ri][ci];
        if (!c) return '<div class="cell" style="background: var(--surface-2); color: var(--muted)">–</div>';
        return `<div class="cell" style="background:${color(c.value)}" title="${esc(c.title ?? '')}">${esc(format(c.value))}<small>${esc(c.sub ?? '')}</small></div>`;
      }),
    ]),
    '</div>',
    `<div class="scale"><span>${esc(format(-scale))}</span><span class="bar"></span><span>${esc(format(scale))}</span></div>`,
  ];
  container.innerHTML = html.join('');
}
