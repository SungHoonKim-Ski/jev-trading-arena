/**
 * 재생용 타임라인 계산 (DOM 의존 없음).
 * 체결 내역으로 날마다 보유 수량·평균 단가·실현/평가 손익을 다시 계산하고,
 * 판단·체결 이벤트를 프레임(날짜) 인덱스에 배치한다.
 */

const SCORE_LABELS = ['강력매도', '매도', '중립', '매수', '강력매수'];

/** Jev 판단을 전략에 맞는 쉬운 문장으로 */
export function signalText(strategy, decision) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  if (strategy === 'noul') return `오를 확률 ${pct(decision.signal)}`;
  if (strategy === 'probability') return `강세 확률 ${pct(decision.signal)}`;
  if (strategy === 'score') {
    const score = decision.signal * 4;
    return `등급 ${SCORE_LABELS[Math.round(score)]} (${score.toFixed(1)}/4)`;
  }
  return `확신도 ${pct(decision.confidence)}`;
}

function alignCloses(dates, bars) {
  const byDate = new Map((bars ?? []).map((b) => [b.date, b.close]));
  let last = null;
  return dates.map((d) => {
    if (byDate.has(d)) last = byDate.get(d);
    return last;
  });
}

function emptyPosition() {
  return { shares: 0, avgCost: 0, realized: 0 };
}

/** 체결 한 건을 반영한 새 포지션 (매수 수수료는 원가에 포함, 매도 수수료는 실현손익에서 차감) */
function applyTrade(pos, trade) {
  if (trade.side === 'buy') {
    const shares = pos.shares + trade.shares;
    const avgCost = shares > 0 ? (pos.avgCost * pos.shares + trade.price * trade.shares + trade.fee) / shares : 0;
    return { ...pos, shares, avgCost };
  }
  const shares = Math.max(0, pos.shares - trade.shares);
  const realized = pos.realized + (trade.price - pos.avgCost) * trade.shares - trade.fee;
  return { shares, avgCost: shares > 1e-12 ? pos.avgCost : 0, realized };
}

export function buildTimeline(detail) {
  const initial = Number(detail.run.initial_capital);
  const symbols = Object.keys(detail.run.symbol_names ?? detail.prices ?? {});
  const dates = detail.equity.map((p) => p.date);
  const frameOf = new Map(dates.map((d, i) => [d, i]));
  const closes = Object.fromEntries(symbols.map((s) => [s, alignCloses(dates, detail.prices?.[s])]));

  const tradesByDate = new Map();
  for (const t of detail.trades) tradesByDate.set(t.date, [...(tradesByDate.get(t.date) ?? []), t]);

  let positions = Object.fromEntries(symbols.map((s) => [s, emptyPosition()]));
  const frames = detail.equity.map((p, i) => {
    for (const t of tradesByDate.get(p.date) ?? []) positions = { ...positions, [t.symbol]: applyTrade(positions[t.symbol] ?? emptyPosition(), t) };
    const view = Object.fromEntries(symbols.map((s) => {
      const pos = positions[s];
      const price = closes[s][i];
      const unrealized = price == null || pos.shares === 0 ? 0 : (price - pos.avgCost) * pos.shares;
      return [s, { ...pos, price, unrealized, unrealizedPct: pos.avgCost > 0 ? price / pos.avgCost - 1 : 0 }];
    }));
    const pnlPct = p.equity / initial - 1;
    const benchPct = p.benchmark / initial - 1;
    return { date: p.date, equity: p.equity, benchmark: p.benchmark, index: p.index, pnl: p.equity - initial, pnlPct, benchPct, vsBenchmark: pnlPct - benchPct, positions: view };
  });

  const events = [];
  for (const d of detail.decisions) {
    if (d.action === 'hold' || !frameOf.has(d.date)) continue;
    events.push({ frame: frameOf.get(d.date), type: 'decision', symbol: d.symbol, action: d.action, text: signalText(detail.run.strategy, d), targetWeight: d.targetWeight });
  }
  for (const t of detail.trades) {
    if (!frameOf.has(t.date)) continue;
    events.push({ frame: frameOf.get(t.date), type: 'trade', symbol: t.symbol, side: t.side, shares: t.shares, price: t.price });
  }
  // 같은 날에는 판단 → 체결 순
  events.sort((a, b) => a.frame - b.frame || (a.type === b.type ? 0 : a.type === 'decision' ? -1 : 1));

  const markers = Object.fromEntries(symbols.map((s) => [s, events.filter((e) => e.type === 'trade' && e.symbol === s).map((e) => ({ frame: e.frame, side: e.side, price: e.price }))]));
  return { dates, frames, events, markers, closes, symbols, initial };
}
