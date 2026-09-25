import { api } from '../api.js';
import { esc, meta, STRATEGY_FRIENDLY } from '../format.js';
import { pollGroup } from './runResults.js';

const NICK_KEY = 'jev-arena-nickname';
const PERIODS = [[3, '3개월'], [6, '6개월'], [12, '1년'], [24, '2년']];
const MARKET_CARDS = { KR: ['🇰🇷', '한국 주식'], US: ['🇺🇸', '미국 주식'], CRYPTO: ['🪙', '코인'] };
const EFFORT_DEFAULT = 'medium';

const state = {
  market: 'US',
  tickers: { KR: ['005930', '000660'], US: ['AAPL', 'NVDA'], CRYPTO: ['BTC', 'ETH'] },
  months: 12,
  strategy: 'noul',
};

const TICKER_PLACEHOLDER = { KR: '종목코드 6자리 (예: 005930)', US: '티커 (예: AAPL)' };

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const monthsAgo = (months) => {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
};

function readNick() {
  try { return localStorage.getItem(NICK_KEY) ?? ''; } catch { return ''; }
}
function saveNick(v) {
  try { localStorage.setItem(NICK_KEY, v); } catch { /* 저장 불가 환경은 무시 */ }
}
export const currentNickname = readNick;

function radios(name, entries, checked) {
  return entries.map(([key, label, desc]) => `
    <label class="check"><input type="radio" name="${name}" value="${esc(key)}" ${key === checked ? 'checked' : ''} />
      <div><b>${esc(label)}</b>${desc ? `<span>${esc(desc)}</span>` : ''}</div></label>`).join('');
}

function checks(name, entries, checkedKeys) {
  return entries.map(([key, label]) => `
    <label class="check compact"><input type="checkbox" name="${name}" value="${esc(key)}" ${checkedKeys.includes(key) ? 'checked' : ''} /><div><b>${esc(label)}</b></div></label>`).join('');
}

function advancedTemplate(m, market) {
  const intervals = market.intervals;
  const isCrypto = state.market === 'CRYPTO';
  return `
  <details class="advanced">
    <summary>고급 설정 <span class="hint">기간 직접 입력 · 자본 · effort · 매매 주기 · 체결 · 여러 조합 비교</span></summary>
    <div class="grid-2">
      <div class="field"><b>기간 직접 입력</b>
        <div class="row"><input type="date" name="startDate" value="${monthsAgo(state.months)}" max="${yesterday()}" /> ~ <input type="date" name="endDate" value="${yesterday()}" max="${yesterday()}" /></div></div>
      <label class="field">초기 자본 (${esc(market.currency)}) <input type="number" name="initialCapital" min="100" step="any" value="${market.defaultCapital}" /></label>
      <div class="field"><b>엔진</b><div class="seg" role="group" aria-label="엔진">
        <button type="button" data-engine="live" aria-pressed="${m.jevLive}" ${m.jevLive ? '' : 'disabled'}>Jev (${esc(m.model)})</button>
        <button type="button" data-engine="mock" aria-pressed="${!m.jevLive}">Mock</button></div></div>
      <div class="field"><b>체결 방식</b><div class="seg" role="group" aria-label="체결 방식">
        <button type="button" data-execution="open" aria-pressed="true">다음 날 시가</button>
        <button type="button" data-execution="vwap" aria-pressed="false">분봉 VWAP</button>
        ${isCrypto && m.ticksEnabled ? '<button type="button" data-execution="tick" aria-pressed="false">원본 틱</button>' : ''}</div></div>
    </div>
    <h3>effort <span class="hint">Jev에게 얼마나 공들여 물을지</span></h3>
    <div class="checks">${radios('effort', Object.entries(m.efforts).map(([k, v]) => [k, v.label, v.description]), EFFORT_DEFAULT)}</div>
    <h3>매매 주기</h3>
    <div class="checks">${radios('interval', intervals.map((i) => [String(i.days), i.label, isCrypto ? `${i.days}일마다 판단` : `${i.days}거래일마다 판단`]), String(intervals[1].days))}</div>
    <label class="compare-toggle"><input type="checkbox" name="compare" /> <b>여러 조합 한 번에 비교</b> <span class="hint">선택한 전략·effort·주기의 모든 조합을 실행하고 결과 표로 봅니다</span></label>
    <div class="compare-box" hidden>
      <div class="checks">${checks('strategies', Object.keys(m.strategies).map((k) => [k, STRATEGY_FRIENDLY[k]]), [state.strategy])}</div>
      <div class="checks">${checks('efforts', Object.entries(m.efforts).map(([k, v]) => [k, v.label]), [EFFORT_DEFAULT])}</div>
      <div class="checks">${checks('intervals', intervals.map((i) => [String(i.days), i.label]), [String(intervals[1].days)])}</div>
      <span id="combo-count" class="hint"></span>
    </div>
  </details>`;
}

function template(m) {
  const market = m.markets[state.market];
  return `
  <div class="hero"><h2>Jev에게 매매를 맡겨 보세요</h2>
    <p class="lead">종목과 기간, Jev에게 묻는 방식만 고르면 됩니다. 매수·매도가 하루씩 재생되고 랭킹에 기록됩니다.</p></div>
  ${m.jevLive ? '' : '<div class="notice" style="margin-bottom:16px">지금은 API 키가 없어 <b>Mock 엔진</b>으로 매매합니다. Jev와 같은 질문을 받아 규칙으로 답하는 대체 엔진이며, 실제 Jev 결과와 랭킹이 분리됩니다.</div>'}
  <form id="run-form" class="card simple-form" novalidate>
    <div class="step"><div class="step-label">1. 어떤 시장?</div>
      <div class="market-cards">${Object.keys(m.markets).map((k) => `<button type="button" class="market-card" data-market="${k}" aria-pressed="${k === state.market}">
        <span class="emoji" aria-hidden="true">${MARKET_CARDS[k][0]}</span>${esc(MARKET_CARDS[k][1])}</button>`).join('')}</div></div>
    <div class="step"><div class="step-label">2. 무엇을? <span class="hint">최대 5개</span></div>
      <div class="chips" id="preset-chips"></div>
      ${state.market === 'CRYPTO' ? '' : `<div class="row" style="margin-top:8px"><input type="text" id="ticker-input" placeholder="${esc(TICKER_PLACEHOLDER[state.market])}" /><button type="button" class="ghost" id="ticker-add">추가</button></div>`}</div>
    <div class="step"><div class="step-label">3. 언제부터? <span class="hint">어제까지</span></div>
      <div class="chips">${PERIODS.map(([mo, l]) => `<button type="button" class="chip big ${mo === state.months ? 'on' : ''}" data-months="${mo}" aria-pressed="${mo === state.months}">${l}</button>`).join('')}</div></div>
    <div class="step"><div class="step-label">4. Jev에게 어떻게 물을까?</div>
      <div class="strategy-cards">${Object.entries(m.strategies).map(([k, v]) => `<button type="button" class="strategy-card" data-strategy="${k}" aria-pressed="${k === state.strategy}">
        <b>${esc(STRATEGY_FRIENDLY[k])}</b><span>${esc(v.description)}</span></button>`).join('')}</div></div>
    <div class="start-bar">
      <label class="nick">닉네임 <input type="text" name="nickname" maxlength="20" required value="${esc(readNick())}" placeholder="랭킹에 표시될 이름" /></label>
      <button class="primary start" type="submit">▶ 매매 시작</button>
      <span id="form-error" class="error" role="alert"></span>
    </div>
    ${advancedTemplate(m, market)}
  </form>
  <div id="group-result"></div>`;
}

function renderChips(root, m) {
  const selected = state.tickers[state.market];
  const presets = m.presets[state.market];
  const known = new Set(presets.map((p) => p.ticker));
  const extra = selected.filter((t) => !known.has(t)).map((t) => ({ ticker: t, name: t }));
  root.querySelector('#preset-chips').innerHTML = [...presets, ...extra].map((p) =>
    `<button type="button" class="chip big ${selected.includes(p.ticker) ? 'on' : ''}" data-ticker="${esc(p.ticker)}" aria-pressed="${selected.includes(p.ticker)}">${esc(p.name)}</button>`).join('');
}

function formValues(form) {
  const fd = new FormData(form);
  const compare = fd.get('compare') === 'on';
  const all = (n) => fd.getAll(n).map(String);
  return {
    nickname: String(fd.get('nickname') ?? '').trim(),
    market: state.market,
    tickers: state.tickers[state.market],
    startDate: String(fd.get('startDate')),
    endDate: String(fd.get('endDate')),
    initialCapital: Number(fd.get('initialCapital')),
    engine: form.querySelector('[data-engine][aria-pressed="true"]')?.dataset.engine ?? 'mock',
    execution: form.querySelector('[data-execution][aria-pressed="true"]')?.dataset.execution ?? 'open',
    strategies: compare ? all('strategies') : [state.strategy],
    efforts: compare ? all('efforts') : [String(fd.get('effort') ?? EFFORT_DEFAULT)],
    intervals: (compare ? all('intervals') : [String(fd.get('interval'))]).map(Number),
    compare,
  };
}

function updateCount(form) {
  const v = formValues(form);
  const n = v.strategies.length * v.efforts.length * v.intervals.length;
  const max = meta().maxRunsPerRequest;
  form.querySelector('#combo-count').textContent = `${n}개 조합 실행${n > max ? ` (최대 ${max}개)` : ''}`;
  form.querySelector('.start').textContent = v.compare ? `▶ ${n}개 조합 비교` : '▶ 매매 시작';
}

function toggleTicker(t) {
  const list = state.tickers[state.market];
  state.tickers[state.market] = list.includes(t) ? list.filter((x) => x !== t) : list.length >= 5 ? list : [...list, t];
}

function pressOne(root, selector, target) {
  root.querySelectorAll(selector).forEach((x) => x.setAttribute('aria-pressed', String(x === target)));
}

function bindChoices(root, m, form, onOpenRun) {
  root.querySelectorAll('[data-market]').forEach((b) => b.addEventListener('click', () => { state.market = b.dataset.market; render(root, onOpenRun); }));
  root.querySelectorAll('[data-strategy]').forEach((b) => b.addEventListener('click', () => { state.strategy = b.dataset.strategy; pressOne(root, '[data-strategy]', b); }));
  root.querySelectorAll('[data-months]').forEach((b) => b.addEventListener('click', () => {
    state.months = Number(b.dataset.months);
    root.querySelectorAll('[data-months]').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
    form.startDate.value = monthsAgo(state.months);
    form.endDate.value = yesterday();
  }));
  for (const attr of ['data-engine', 'data-execution']) root.querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener('click', () => pressOne(root, `[${attr}]`, b)));
  root.querySelector('#preset-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-ticker]');
    if (!chip) return;
    toggleTicker(chip.dataset.ticker);
    renderChips(root, m);
  });
  const addTicker = () => {
    const input = root.querySelector('#ticker-input');
    const t = input.value.trim().toUpperCase();
    if (t && !state.tickers[state.market].includes(t)) toggleTicker(t);
    input.value = '';
    renderChips(root, m);
  };
  root.querySelector('#ticker-add')?.addEventListener('click', addTicker);
  root.querySelector('#ticker-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTicker(); } });
  form.compare.addEventListener('change', () => { form.querySelector('.compare-box').hidden = !form.compare.checked; updateCount(form); });
  form.addEventListener('change', () => updateCount(form));
  form.nickname.addEventListener('input', () => saveNick(form.nickname.value.trim()));
}

function bind(root, m, onOpenRun) {
  const form = root.querySelector('#run-form');
  const err = root.querySelector('#form-error');
  renderChips(root, m);
  bindChoices(root, m, form, onOpenRun);
  updateCount(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const { compare, ...values } = formValues(form);
    if (!values.nickname) { err.textContent = '닉네임을 입력하세요'; form.nickname.focus(); return; }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const { groupId, runIds } = await api('/api/runs', { method: 'POST', body: JSON.stringify(values) });
      saveNick(values.nickname);
      if (!compare && runIds.length === 1) location.hash = `#play/${runIds[0]}`;
      else pollGroup(root.querySelector('#group-result'), groupId, onOpenRun);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      button.disabled = false;
    }
  });
}

export function render(root, onOpenRun) {
  const m = meta();
  root.innerHTML = template(m);
  bind(root, m, onOpenRun);
}
