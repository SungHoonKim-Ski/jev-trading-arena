/**
 * 하루씩 그려지는 라인 차트 (SVG).
 * - x축은 전체 기간으로 고정해 "얼마나 남았는지" 보이게 한다.
 * - y축은 지금까지 나온 값으로만 넓어진다 (미래 고점·저점이 미리 드러나지 않도록).
 */
const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

function niceStep(range) {
  const raw = range / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
}

/**
 * @param {HTMLElement} container
 * @param {{ height: number, count: number, series: {name: string, color: string, values: (number|null)[]}[],
 *           markers?: {frame: number, side: 'buy'|'sell', price: number}[], refLine?: (frame:number) => number|null,
 *           formatY: (v:number) => string, dates: string[] }} opts
 */
export function createLiveChart(container, opts) {
  // 실제 표시 폭으로 그려야 글자가 축소되지 않는다
  const W = Math.max(300, Math.round(container.clientWidth || 900));
  const narrow = W < 520;
  const H = narrow ? Math.round(opts.height * 0.8) : opts.height;
  const PAD = { top: 16, right: narrow ? 64 : 110, bottom: 24, left: narrow ? 44 : 60 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'live-chart', role: 'img', 'aria-label': opts.series.map((s) => s.name).join(', ') });
  const grid = el('g');
  const lines = opts.series.map((s) => el('path', { class: 'series', stroke: s.color }));
  const ends = opts.series.map((s) => el('circle', { r: 4.5, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
  const endLabels = opts.series.map(() => el('text', { class: 'end-label' }));
  const ref = el('line', { class: 'ref-line', visibility: 'hidden' });
  const refLabel = el('text', { class: 'ref-label', visibility: 'hidden' });
  const markerLayer = el('g');
  const xLabels = el('g');
  svg.append(grid, ref, refLabel, ...lines, markerLayer, ...ends, ...endLabels, xLabels);
  container.replaceChildren(svg);

  const x = (i) => PAD.left + (i / Math.max(1, opts.count - 1)) * (W - PAD.left - PAD.right);
  let shownMarkers = 0;

  // x축 날짜 (전체 기간 고정)
  const ticksX = narrow ? 3 : 5;
  for (let k = 0; k < ticksX; k++) {
    const i = Math.round((k / (ticksX - 1)) * (opts.count - 1));
    xLabels.append(el('text', { x: x(i), y: H - 6, 'text-anchor': k === 0 ? 'start' : k === ticksX - 1 ? 'end' : 'middle', class: 'axis-text' }, opts.dates[i] ?? ''));
  }

  function domain(frame) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of opts.series) {
      for (let i = 0; i <= frame; i++) {
        const v = s.values[i];
        if (v == null) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const r = opts.refLine?.(frame);
    if (r != null) { lo = Math.min(lo, r); hi = Math.max(hi, r); }
    if (!Number.isFinite(lo)) return [0, 1];
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.02 || 1;
    return [lo - pad, hi + pad];
  }

  function render(frame) {
    const [lo, hi] = domain(frame);
    const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

    const step = niceStep(hi - lo);
    const ticks = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
    grid.replaceChildren(...ticks.flatMap((t) => [
      el('line', { x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t), class: 'grid-line' }),
      el('text', { x: PAD.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'axis-text' }, opts.formatY(t)),
    ]));

    const labelYs = [];
    opts.series.forEach((s, k) => {
      let d = '';
      let lastI = -1;
      for (let i = 0; i <= frame; i++) {
        const v = s.values[i];
        if (v == null) continue;
        d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        lastI = i;
      }
      lines[k].setAttribute('d', d);
      const visible = lastI >= 0;
      ends[k].setAttribute('visibility', visible ? 'visible' : 'hidden');
      endLabels[k].setAttribute('visibility', visible ? 'visible' : 'hidden');
      if (!visible) return;
      const cy = y(s.values[lastI]);
      ends[k].setAttribute('cx', x(lastI));
      ends[k].setAttribute('cy', cy);
      let ly = cy + 4;
      while (labelYs.some((o) => Math.abs(o - ly) < 14)) ly += 14;
      labelYs.push(ly);
      endLabels[k].setAttribute('x', x(lastI) + 10);
      endLabels[k].setAttribute('y', ly);
      endLabels[k].textContent = `${s.name} ${opts.formatY(s.values[lastI])}`;
    });

    const r = opts.refLine?.(frame);
    ref.setAttribute('visibility', r == null ? 'hidden' : 'visible');
    refLabel.setAttribute('visibility', r == null ? 'hidden' : 'visible');
    if (r != null) {
      ref.setAttribute('x1', PAD.left); ref.setAttribute('x2', x(frame));
      ref.setAttribute('y1', y(r)); ref.setAttribute('y2', y(r));
      refLabel.setAttribute('x', PAD.left + 4); refLabel.setAttribute('y', y(r) - 5);
      refLabel.textContent = `평균단가 ${opts.formatY(r)}`;
    }

    // 매수(▲, 가격 아래)·매도(▼, 가격 위) 표시. 새로 나타난 표시는 강조 애니메이션
    const visibleMarkers = (opts.markers ?? []).filter((m) => m.frame <= frame);
    markerLayer.replaceChildren(...visibleMarkers.map((m, idx) => {
      const mx = x(m.frame);
      const my = y(m.price);
      const buy = m.side === 'buy';
      const g = el('g', { class: `marker ${buy ? 'buy' : 'sell'}${idx >= shownMarkers ? ' fresh' : ''}` });
      const tip = buy ? `${mx},${my + 6} ${mx - 7},${my + 18} ${mx + 7},${my + 18}` : `${mx},${my - 6} ${mx - 7},${my - 18} ${mx + 7},${my - 18}`;
      g.append(el('polygon', { points: tip }), el('text', { x: mx, y: buy ? my + 31 : my - 23, 'text-anchor': 'middle' }, buy ? '매수' : '매도'));
      return g;
    }));
    shownMarkers = visibleMarkers.length;
  }

  return { render };
}
