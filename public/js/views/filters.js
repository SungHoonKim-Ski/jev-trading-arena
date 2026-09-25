import { esc, meta } from '../format.js';

/** 랭킹/통계 공용 필터 바 */
export function filterBar(fields, values) {
  const m = meta();
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
  const defs = {
    market: ['시장', [['', '전체'], ...Object.entries(m.markets).map(([k, v]) => [k, v.label])]],
    engine: ['엔진', [['', '전체'], ['live', 'Jev'], ['mock', 'Mock']]],
    execution: ['체결', [['', '전체'], ['open', '시가'], ['vwap', '분봉 VWAP'], ['tick', '원본 틱']]],
    strategy: ['전략', [['', '전체'], ...Object.entries(m.strategies).map(([k, v]) => [k, v.label])]],
    effort: ['effort', [['', '전체'], ...Object.entries(m.efforts).map(([k, v]) => [k, v.label])]],
    intervalDays: ['주기', [['', '전체'], ...m.intervals.map((i) => [i.days, `${i.label} (${i.days}일)`])]],
    threshold: ['기준', [['', '전체'], ...(m.thresholds ?? []).map((t) => [t, `${Math.round(t * 100)}%`])]],
    sort: ['정렬', [['total_return', '수익률'], ['excess_return', '보유 대비 초과수익'], ['sharpe', 'Sharpe'], ['cagr', 'CAGR'], ['mdd', 'MDD(낮은 낙폭)']]],
  };
  const selects = fields.filter((f) => defs[f]).map((f) => {
    const [label, options] = defs[f];
    return `<label>${esc(label)} <select name="${f}">${options.map(([v, l]) => opt(v, l, values[f])).join('')}</select></label>`;
  });
  const extra = [];
  if (fields.includes('period')) {
    extra.push(`<label>기간 <input type="date" name="startDate" value="${esc(values.startDate ?? '')}" /> ~ <input type="date" name="endDate" value="${esc(values.endDate ?? '')}" /></label>`);
  }
  if (fields.includes('bestPerUser')) {
    extra.push(`<label><input type="checkbox" name="bestPerUser" ${values.bestPerUser ? 'checked' : ''} /> 사용자별 최고 기록만</label>`);
  }
  return `<form class="filters">${[...selects, ...extra].join('')}</form>`;
}

export function readFilters(form) {
  const fd = new FormData(form);
  const out = {};
  for (const [k, v] of fd.entries()) out[k] = v === 'on' ? 'true' : String(v);
  return out;
}
