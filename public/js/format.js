const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** 모든 사용자/외부 데이터는 이 함수로 이스케이프 후 innerHTML에 넣는다 */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function pct(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return '–';
  const s = (v * 100).toFixed(digits);
  return `${v > 0 ? '+' : ''}${s}%`;
}
export const pctClass = (v) => (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
export const signed = (v, digits = 1) => `<span class="${pctClass(v)}">${pct(v, digits)}</span>`;
export const num = (v, digits = 2) => (v == null ? '–' : Number(v).toFixed(digits));

export function money(v, currency) {
  if (v == null) return '–';
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency, maximumFractionDigits: currency === 'KRW' ? 0 : 2 }).format(v);
}
export const usd = (v) => (v == null ? '–' : v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(3)}`);

export const STATUS_LABEL = { queued: '대기', running: '실행 중', done: '완료', failed: '실패' };
export const ACTION_LABEL = { buy: '매수', sell: '매도', hold: '유지' };

let META = null;
export const setMeta = (m) => { META = m; };
export const meta = () => META;
export const strategyLabel = (s) => META?.strategies[s]?.label ?? s;
/** 사용자에게 보여 주는 쉬운 전략 이름 */
export const STRATEGY_FRIENDLY = { choice: '단호하게', probability: '확률대로', noul: '오를까?', score: '등급으로' };
export const strategyFriendly = (s) => STRATEGY_FRIENDLY[s] ?? s;
/** 확신 임계값 표시 (도입 전 실행은 '이전 규칙') */
export const thresholdLabel = (t) => (t == null ? '이전 규칙' : `${Math.round(Number(t) * 100)}%`);
/** 3지선다·5단계 등 이전 질문 방식으로 한 실행 표시 */
export const legacyTag = (strategy) => (strategy && strategy !== 'noul' ? ` · 이전 방식(${STRATEGY_FRIENDLY[strategy] ?? strategy})` : '');
export const exitRuleLabel = (r) => META?.exitRules?.[r]?.label ?? (r ? r : '');
export const effortLabel = (e) => META?.efforts[e]?.label ?? e;
export const intervalLabel = (d) => META?.intervals.find((i) => i.days === Number(d))?.label ?? `${d}일`;
export const marketLabel = (m) => META?.markets[m]?.label ?? m;
export const engineBadge = (e) => (e === 'live' ? '<span class="badge live">Jev</span>' : '<span class="badge">Mock</span>');

let NAME_BY_SYMBOL = null;
/** 저장된 심볼(005930.KS, AAPL, BTCUSDT)을 한국어 프리셋 이름으로. 예전 기록의 영어 이름도 여기서 바꿔 보여 준다 */
export function assetName(symbol, fallback) {
  if (!NAME_BY_SYMBOL && META) {
    NAME_BY_SYMBOL = new Map([
      ...META.presets.KR.flatMap((p) => [[`${p.ticker}.KS`, p.name], [`${p.ticker}.KQ`, p.name]]),
      ...META.presets.US.map((p) => [p.ticker, p.name]),
      ...(META.cryptoAssets ?? []).map((a) => [a.symbol, a.name]),
    ]);
  }
  return NAME_BY_SYMBOL?.get(symbol) ?? fallback ?? symbol;
}

/** 실행의 종목 → 한국어 이름 맵 */
export function runNames(run) {
  const stored = run.symbol_names ?? {};
  return Object.fromEntries(Object.keys(stored).map((s) => [s, assetName(s, stored[s])]));
}

export function tickersText(run) {
  const names = runNames(run);
  const list = Object.keys(names).length ? Object.values(names) : run.tickers;
  return list.join(', ');
}
export function tickersShort(run) {
  const names = run.symbol_names ? Object.values(runNames(run)) : run.tickers;
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} 외 ${names.length - 2}` : names.join(', ');
}
