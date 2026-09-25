import { api, qs } from '../api.js';
import { esc, meta, pct, signed, num, usd, strategyLabel, effortLabel, intervalLabel } from '../format.js';
import { heatmap } from '../charts.js';
import { filterBar, readFilters } from './filters.js';

let filters = { engine: '' };
let metric = 'avg_excess';
const METRICS = { avg_excess: ['보유 대비 평균 초과수익', pct], avg_return: ['평균 수익률', pct], avg_sharpe: ['평균 Sharpe', (v) => num(v)] };

/** 서버의 (전략, effort, 주기) 그룹을 원하는 두 축으로 재집계 (실행 수 가중 평균) */
function pivot(rows, colOf, colValues) {
  const strategies = Object.keys(meta().strategies);
  return strategies.map((s) => colValues.map((c) => {
    const group = rows.filter((r) => r.strategy === s && String(colOf(r)) === String(c));
    const n = group.reduce((acc, r) => acc + r.runs, 0);
    if (n === 0) return null;
    const value = group.reduce((acc, r) => acc + r[metric] * r.runs, 0) / n;
    return { value, sub: `${n}회 실행`, title: `${strategyLabel(s)} · ${c}: ${METRICS[metric][0]} ${METRICS[metric][1](value)} (${n}회)` };
  }));
}

function headline(rows) {
  if (rows.length === 0) return '';
  const best = [...rows].sort((a, b) => b[metric] - a[metric])[0];
  return `<div class="tiles">
    <div class="tile"><div class="k">최고 조합 (${esc(METRICS[metric][0])})</div><div class="v">${esc(strategyLabel(best.strategy))}</div>
      <div class="s">${esc(effortLabel(best.effort))} · ${esc(intervalLabel(best.interval_days))} · ${esc(METRICS[metric][1](best[metric]))}</div></div>
    <div class="tile"><div class="k">집계된 실행</div><div class="v">${rows.reduce((a, r) => a + r.runs, 0)}회</div><div class="s">${rows.length}개 조합</div></div>
    <div class="tile"><div class="k">보유 전략을 이긴 비율 (최고 조합)</div><div class="v">${Math.round(best.beat_benchmark_rate * 100)}%</div><div class="s">동일비중 매수 후 보유 대비</div></div>
  </div>`;
}

function comboTable(rows) {
  return `<div class="table-wrap"><table><thead><tr><th>전략</th><th>effort</th><th>주기</th><th class="num">실행</th><th class="num">사용자</th>
    <th class="num">평균 수익률</th><th class="num">최고 수익률</th><th class="num">평균 초과수익</th><th class="num">보유 대비 승률</th>
    <th class="num">평균 Sharpe</th><th class="num">평균 MDD</th><th class="num">평균 거래</th><th class="num">평균 Jev 비용</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${esc(strategyLabel(r.strategy))}</td><td>${esc(effortLabel(r.effort))}</td><td>${esc(intervalLabel(r.interval_days))}</td>
      <td class="num">${r.runs}</td><td class="num">${r.users}</td><td class="num">${signed(r.avg_return)}</td><td class="num">${signed(r.best_return)}</td>
      <td class="num">${signed(r.avg_excess)}</td><td class="num">${Math.round(r.beat_benchmark_rate * 100)}%</td><td class="num">${num(r.avg_sharpe)}</td>
      <td class="num">${signed(r.avg_mdd)}</td><td class="num">${num(r.avg_trades, 1)}</td><td class="num">${usd(r.avg_cost_usd)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function load(root) {
  const out = root.querySelector('#stats-body');
  out.innerHTML = '<div class="empty">불러오는 중…</div>';
  try {
    const rows = await api(`/api/stats?${qs(filters)}`);
    if (rows.length === 0) { out.innerHTML = '<div class="empty">집계할 완료된 실행이 없습니다.</div>'; return; }
    const m = meta();
    const efforts = Object.keys(m.efforts);
    // 주식 5거래일과 코인 7일은 모두 '매주'로 묶어 비교한다
    const intervals = [...new Set(m.intervals.map((i) => i.label))];
    out.innerHTML = `${headline(rows)}
      <div class="grid-2">
        <div class="card"><h3 style="margin-top:0">전략 × effort</h3><div id="hm-effort"></div></div>
        <div class="card"><h3 style="margin-top:0">전략 × 매매 주기</h3><div id="hm-interval"></div></div>
      </div>
      <div class="card"><h3 style="margin-top:0">조합별 상세</h3>${comboTable(rows)}</div>`;
    const rowLabels = Object.values(m.strategies).map((s) => s.label);
    const fmt = METRICS[metric][1];
    const effortCells = pivot(rows, (r) => r.effort, efforts);
    const intervalCells = pivot(rows, (r) => intervalLabel(r.interval_days), intervals);
    const maxAbs = Math.max(0.0001, ...[...effortCells, ...intervalCells].flat().filter(Boolean).map((c) => Math.abs(c.value)));
    heatmap(out.querySelector('#hm-effort'), { rows: rowLabels, cols: efforts.map(effortLabel), cells: effortCells, format: fmt, maxAbs });
    heatmap(out.querySelector('#hm-interval'), { rows: rowLabels, cols: intervals, cells: intervalCells, format: fmt, maxAbs });
  } catch (ex) {
    out.innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

export function render(root) {
  root.innerHTML = `<h2>전략 분석</h2>
    <p class="lead">어떤 Jev 응답 방식·effort·매매 주기 조합이 수익을 잘 내는지 전체 실행 기록을 모아 비교합니다. 파란색은 매수 후 보유보다 나은 성과, 빨간색은 못한 성과입니다.</p>
    <div class="card">${filterBar(['market', 'engine', 'execution', 'effort', 'intervalDays', 'period'], filters)}
      <div class="filters"><label>지표 <select id="metric">${Object.entries(METRICS).map(([k, [l]]) => `<option value="${k}" ${k === metric ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>
    </div>
    <div id="stats-body"></div>`;
  root.querySelector('form.filters').addEventListener('change', (e) => { filters = readFilters(e.currentTarget); load(root); });
  root.querySelector('#metric').addEventListener('change', (e) => { metric = e.target.value; load(root); });
  load(root);
}
