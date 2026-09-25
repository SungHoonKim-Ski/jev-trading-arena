import { api } from '../api.js';
import { esc, meta, pct, signed, num, money, usd, effortLabel, intervalLabel, marketLabel, engineBadge, tickersText, STATUS_LABEL, ACTION_LABEL, thresholdLabel, exitRuleLabel, legacyTag, runNames } from '../format.js';
import { lineChart } from '../charts.js';

const DECISION_ROWS = 200;
const EXECUTION_LABEL = { open: '시가 체결', vwap: '분봉 VWAP 체결', tick: '원본 틱 체결' };

function tiles(run, currency) {
  const t = (k, v, s = '') => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  return `<div class="tiles">
    ${t('총 수익률', signed(run.total_return), `최종 ${esc(money(run.final_equity, currency))}`)}
    ${t('그냥 보유보다', signed(run.excess_return), `그냥 보유했으면 ${esc(pct(run.benchmark_return))}`)}
    ${t('지수 수익률', signed(run.index_return), esc(meta().markets[run.market].indexName))}
    ${t('CAGR', signed(run.cagr), `변동성 ${esc(pct(run.volatility))}`)}
    ${t('최대 낙폭(MDD)', signed(run.mdd), `Sharpe ${esc(num(run.sharpe))}`)}
    ${t('거래 횟수', esc(run.trades ?? '–'), `수수료·세금 ${esc(money(run.fees, currency))}`)}
    ${run.execution === 'vwap' ? t('분봉 VWAP 체결', `${run.intraday_fills ?? 0} / ${run.trades ?? 0}`, '나머지는 분봉이 없어 일봉 평균가로 체결') : ''}
    ${run.execution === 'tick' ? t('원본 틱 체결', `${run.tick_fills ?? 0} / ${run.trades ?? 0}`, `1분봉 대체 ${run.intraday_fills ?? 0}건 · 일봉 대체 ${run.fallback_fills ?? 0}건`) : ''}
    ${t('Jev 호출', esc(run.jev_calls ?? '–'), `${esc((run.jev_input_tokens ?? 0).toLocaleString())} 토큰 · ${esc(usd(run.jev_cost_usd))}`)}
  </div>`;
}

function decisionsTable(decisions, names) {
  const rows = decisions.slice(-DECISION_ROWS).reverse();
  return `<div class="table-wrap scroll"><table><thead><tr><th>결정일</th><th>종목</th><th>판단</th><th class="num">목표 비중</th><th class="num">판단 확률</th><th class="num">신뢰도</th></tr></thead>
    <tbody>${rows.map((d) => `<tr><td>${esc(d.date)}</td><td>${esc(names[d.symbol] ?? d.symbol)}</td>
      <td class="${d.action === 'buy' ? 'pos' : d.action === 'sell' ? 'neg' : ''}">${esc(ACTION_LABEL[d.action])}</td>
      <td class="num">${d.targetWeight == null ? '유지' : `${Math.round(d.targetWeight * 100)}%`}</td>
      <td class="num">${num(d.signal)}</td><td class="num">${num(d.confidence)}</td></tr>`).join('')}</tbody></table></div>
    ${decisions.length > DECISION_ROWS ? `<p class="hint">최근 ${DECISION_ROWS}건만 표시 (전체 ${decisions.length}건)</p>` : ''}`;
}

function tradesTable(trades, names, currency) {
  if (trades.length === 0) return '<div class="empty">체결 내역이 없습니다.</div>';
  const rows = [...trades].reverse();
  return `<div class="table-wrap scroll"><table><thead><tr><th>체결일</th><th>종목</th><th>구분</th><th class="num">수량</th><th class="num">가격</th><th class="num">수수료·세금</th></tr></thead>
    <tbody>${rows.map((t) => `<tr><td>${esc(t.date)}</td><td>${esc(names[t.symbol] ?? t.symbol)}</td>
      <td class="${t.side === 'buy' ? 'pos' : 'neg'}">${t.side === 'buy' ? '매수' : '매도'}</td><td class="num">${esc(Number(t.shares).toLocaleString('ko-KR', { maximumFractionDigits: 8 }))}</td>
      <td class="num">${esc(money(t.price, currency))}</td><td class="num">${esc(money(t.fee, currency))}</td></tr>`).join('')}</tbody></table></div>`;
}

function monthlyTable(equity, currency) {
  const byMonth = new Map();
  for (const p of equity) byMonth.set(p.date.slice(0, 7), p);
  return `<div class="table-wrap"><table><thead><tr><th>월말</th><th class="num">Jev 전략</th><th class="num">매수 후 보유</th><th class="num">지수</th></tr></thead>
    <tbody>${[...byMonth.values()].map((p) => `<tr><td>${esc(p.date)}</td><td class="num">${esc(money(p.equity, currency))}</td>
      <td class="num">${esc(money(p.benchmark, currency))}</td><td class="num">${esc(money(p.index, currency))}</td></tr>`).join('')}</tbody></table></div>`;
}

export async function render(root, runId, { onBack }) {
  root.innerHTML = '<div class="empty">불러오는 중…</div>';
  let detail;
  try {
    detail = await api(`/api/runs/${runId}`);
  } catch (ex) {
    root.innerHTML = `<p class="error">${esc(ex.message)}</p>`;
    return;
  }
  const { run, equity, trades, decisions } = detail;
  const currency = meta().markets[run.market].currency;
  const names = runNames(run);
  const header = `<a href="#" class="back">← 돌아가기</a>
    <h2>${engineBadge(run.engine)} ${esc(run.nickname)}의 매매 기록</h2>
    <p class="lead">${esc(marketLabel(run.market))} · ${esc(tickersText(run))} · ${esc(run.start_date)} ~ ${esc(run.end_date)} ·
      effort ${esc(effortLabel(run.effort))} · ${esc(intervalLabel(run.interval_days))} 판단 · 확신 기준 ${esc(thresholdLabel(run.threshold))}${esc(legacyTag(run.strategy))}${run.exit_rule ? `(${esc(exitRuleLabel(run.exit_rule))})` : ''} · ${EXECUTION_LABEL[run.execution] ?? '시가 체결'} · 초기 자본 ${esc(money(run.initial_capital, currency))}${run.model ? ` · 모델 ${esc(run.model)}` : ''}</p>`;

  if (run.status !== 'done') {
    root.innerHTML = `${header}<div class="card">상태: <b>${esc(STATUS_LABEL[run.status])}</b>${run.error ? `<p class="error">${esc(run.error)}</p>` : ''}
      ${run.status === 'running' || run.status === 'queued' ? `<div class="progress" style="margin-top:8px"><div style="width:${run.progress * 100}%"></div></div>` : ''}</div>`;
    root.querySelector('.back').addEventListener('click', (e) => { e.preventDefault(); onBack(); });
    if (run.status === 'running' || run.status === 'queued') setTimeout(() => { if (root.isConnected && location.hash === `#run/${runId}`) render(root, runId, { onBack }); }, 1500);
    return;
  }

  root.innerHTML = `${header}${tiles(run, currency)}
    <div class="card"><h3 style="margin-top:0">자산 추이</h3><div id="equity-chart"></div>
      <details><summary>월말 수치 표 보기</summary>${monthlyTable(equity, currency)}</details></div>
    <div class="grid-2">
      <div class="card"><h3 style="margin-top:0">Jev 결정 로그</h3>${decisionsTable(decisions, names)}</div>
      <div class="card"><h3 style="margin-top:0">체결 내역 (${trades.length}건)</h3>${tradesTable(trades, names, currency)}</div>
    </div>`;
  root.querySelector('.back').addEventListener('click', (e) => { e.preventDefault(); onBack(); });
  const hasIndex = equity.some((p) => p.index != null);
  lineChart(root.querySelector('#equity-chart'), {
    dates: equity.map((p) => p.date),
    series: [
      { name: 'Jev 전략', color: 'var(--series-1)', values: equity.map((p) => p.equity) },
      { name: '매수 후 보유', color: 'var(--series-2)', values: equity.map((p) => p.benchmark) },
      ...(hasIndex ? [{ name: meta().markets[run.market].indexName, color: 'var(--series-3)', values: equity.map((p) => p.index) }] : []),
    ],
    formatY: (v) => new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }).format(v),
    formatTip: (v) => (v == null ? '–' : `${money(v, currency)} (${pct(v / run.initial_capital - 1)})`),
  });
}
