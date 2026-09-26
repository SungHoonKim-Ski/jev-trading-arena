import { api } from '../api.js';
import { esc, meta } from '../format.js';
import { pollGroup } from './runResults.js';

const NICK_KEY = 'jev-arena-nickname';
const PERIODS = [[3, '3개월'], [6, '6개월'], [12, '1년'], [24, '2년']];
const MARKET_CARDS = { KR: ['🇰🇷', '한국 주식'], US: ['🇺🇸', '미국 주식'], CRYPTO: ['🪙', '코인'] };
const EFFORT_DEFAULT = 'medium';

const state = {
  market: 'US',
  // 시장별로 고른 종목 하나 (단일 선택)
  ticker: { KR: '005930', US: 'AAPL', CRYPTO: 'BTC' },
  months: 12,
  threshold: null, // null이면 서버 기본값
};

const KIND_LABEL = { stock: '개별 종목', etf: 'ETF', coin: '코인' };

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
  // 코인은 원본 틱 체결이 기본 (주식은 틱 데이터가 없어 다음 날 시가)
  const tickDefault = isCrypto && m.ticksEnabled;
  return `
  <details class="advanced">
    <summary>고급 설정 <span class="hint">기간 직접 입력 · 자본 · 매도 규칙 · effort · 매매 주기 · 체결 · 여러 조합 비교</span></summary>
    <div class="grid-2">
      <div class="field"><b>기간 직접 입력</b>
        <div class="row"><input type="date" name="startDate" value="${monthsAgo(state.months)}" max="${yesterday()}" /> ~ <input type="date" name="endDate" value="${yesterday()}" max="${yesterday()}" /></div></div>
      <label class="field">초기 자본 (${esc(market.currency)}) <input type="number" name="initialCapital" min="100" step="any" value="${market.defaultCapital}" /></label>
      <div class="field"><b>엔진</b><div class="seg" role="group" aria-label="엔진">
        <button type="button" data-engine="live" aria-pressed="${m.jevLive}" ${m.jevLive ? '' : 'disabled'}>Jev (${esc(m.model)})</button>
        <button type="button" data-engine="mock" aria-pressed="${!m.jevLive}">Mock</button></div></div>
      <div class="field"><b>체결 방식</b><div class="seg" role="group" aria-label="체결 방식">
        <button type="button" data-execution="open" aria-pressed="${!tickDefault}">다음 날 시가</button>
        <button type="button" data-execution="vwap" aria-pressed="false">분봉 VWAP</button>
        ${tickDefault ? '<button type="button" data-execution="tick" aria-pressed="true">원본 틱 (기본)</button>' : ''}</div>
        ${tickDefault ? `<span class="hint">원본 틱: 체결일 0시부터 바이낸스의 실제 체결을 따라가며, 시장 거래량의 ${Math.round(m.tickParticipation * 100)}%만 내 주문이 가져간다고 보고 체결가를 계산합니다.</span>` : ''}</div>
    </div>
    <h3>매도 규칙</h3>
    <div class="checks">${radios('exitRule', Object.entries(m.exitRules).map(([k, v]) => [k, v.label, v.description]), 'opposite')}</div>
    <h3>effort <span class="hint">Jev에게 얼마나 공들여 물을지</span></h3>
    <div class="checks">${radios('effort', Object.entries(m.efforts).map(([k, v]) => [k, v.label, v.description]), EFFORT_DEFAULT)}</div>
    <h3>매매 주기</h3>
    <div class="checks">${radios('interval', intervals.map((i) => [String(i.days), i.label, isCrypto ? `${i.days}일마다 판단` : `${i.days}거래일마다 판단`]), String(intervals[1].days))}</div>
    <label class="compare-toggle"><input type="checkbox" name="compare" /> <b>여러 조합 한 번에 비교</b> <span class="hint">선택한 effort·매매 주기의 모든 조합을 실행하고 결과 표로 봅니다</span></label>
    <div class="compare-box" hidden>
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
    <p class="lead">종목과 기간, 그리고 얼마나 확실할 때 살지만 고르면 됩니다. 매수·매도가 하루씩 재생되고 랭킹에 기록됩니다.</p></div>
  ${m.jevLive ? '' : '<div class="notice" style="margin-bottom:16px">지금은 API 키가 없어 <b>Mock 엔진</b>으로 매매합니다. Jev와 같은 질문을 받아 규칙으로 답하는 대체 엔진이며, 실제 Jev 결과와 랭킹이 분리됩니다.</div>'}
  <form id="run-form" class="card simple-form" novalidate>
    <fieldset class="step"><legend class="step-label">1. 어떤 시장?</legend>
      <div class="market-cards">${Object.keys(m.markets).map((k) => `<label class="market-card choice"><input type="radio" name="market" value="${k}" ${k === state.market ? 'checked' : ''} />
        <span class="dot" aria-hidden="true"></span><span class="emoji" aria-hidden="true">${MARKET_CARDS[k][0]}</span>${esc(MARKET_CARDS[k][1])}</label>`).join('')}</div></fieldset>
    <fieldset class="step"><legend class="step-label">2. 무엇을? <span class="hint">하나를 고르세요</span></legend>
      ${assetGroups(m)}</fieldset>
    <fieldset class="step"><legend class="step-label">3. 언제부터? <span class="hint">어제까지</span></legend>
      <div class="chips">${PERIODS.map(([mo, l]) => `<label class="chip big choice"><input type="radio" name="months" value="${mo}" ${mo === state.months ? 'checked' : ''} /><span class="dot" aria-hidden="true"></span>${l}</label>`).join('')}</div></fieldset>
    <fieldset class="step"><legend class="step-label">4. Jev에게 "오를까?"를 물어서, 오를 확률이 몇 % 이상이면 살까?</legend>
      <p class="hint step-hint">내릴 확률이 같은 기준 이상이면 팝니다. 기준이 높을수록 거래가 드물어요.</p>
      <div class="chips">${m.thresholds.map((t) => `<label class="chip big choice"><input type="radio" name="threshold" value="${t}" ${t === (state.threshold ?? m.defaultThreshold) ? 'checked' : ''} /><span class="dot" aria-hidden="true"></span>${Math.round(t * 100)}%</label>`).join('')}</div></fieldset>
    <div class="start-bar">
      <label class="nick">닉네임 <input type="text" name="nickname" maxlength="20" required value="${esc(readNick())}" placeholder="랭킹에 표시될 이름" /></label>
      <button class="primary start" type="submit">▶ 매매 시작</button>
      <span id="form-error" class="error" role="alert"></span>
    </div>
    ${advancedTemplate(m, market)}
  </form>
  <div id="group-result"></div>`;
}

/** 대표 개별 종목·ETF(코인은 5종)를 종류별로 묶은 라디오 목록 */
function assetGroups(m) {
  const presets = m.presets[state.market];
  const kinds = [...new Set(presets.map((p) => p.kind))];
  return kinds.map((kind) => `<div class="asset-group"><div class="group-label">${esc(KIND_LABEL[kind] ?? kind)}</div>
    <div class="chips">${presets.filter((p) => p.kind === kind).map((p) => `<label class="chip big choice"><input type="radio" name="ticker" value="${esc(p.ticker)}" ${p.ticker === state.ticker[state.market] ? 'checked' : ''} />
      <span class="dot" aria-hidden="true"></span>${esc(p.name)}</label>`).join('')}</div></div>`).join('');
}

function formValues(form) {
  const fd = new FormData(form);
  const compare = fd.get('compare') === 'on';
  const all = (n) => fd.getAll(n).map(String);
  return {
    nickname: String(fd.get('nickname') ?? '').trim(),
    market: state.market,
    tickers: [String(fd.get('ticker') ?? state.ticker[state.market])],
    startDate: String(fd.get('startDate')),
    endDate: String(fd.get('endDate')),
    initialCapital: Number(fd.get('initialCapital')),
    engine: form.querySelector('[data-engine][aria-pressed="true"]')?.dataset.engine ?? 'mock',
    execution: form.querySelector('[data-execution][aria-pressed="true"]')?.dataset.execution,
    strategies: ['noul'], // Jev 질문은 '오를까?'(예/아니오) 하나
    efforts: compare ? all('efforts') : [String(fd.get('effort') ?? EFFORT_DEFAULT)],
    intervals: (compare ? all('intervals') : [String(fd.get('interval'))]).map(Number),
    threshold: Number(fd.get('threshold')),
    exitRule: String(fd.get('exitRule') ?? 'opposite'),
    compare,
  };
}

function updateCount(form) {
  const v = formValues(form);
  const n = v.efforts.length * v.intervals.length;
  const max = meta().maxRunsPerRequest;
  form.querySelector('#combo-count').textContent = `${n}개 조합 실행${n > max ? ` (최대 ${max}개)` : ''}`;
  form.querySelector('.start').textContent = v.compare ? `▶ ${n}개 조합 비교` : '▶ 매매 시작';
}

function pressOne(root, selector, target) {
  root.querySelectorAll(selector).forEach((x) => x.setAttribute('aria-pressed', String(x === target)));
}

function bindChoices(root, m, form, onOpenRun) {
  // 시장·기간·전략은 하나만 고르는 라디오 버튼
  form.querySelectorAll('input[name="market"]').forEach((r) => r.addEventListener('change', () => { state.market = r.value; render(root, onOpenRun); }));
  form.querySelectorAll('input[name="threshold"]').forEach((r) => r.addEventListener('change', () => { state.threshold = Number(r.value); }));
  form.querySelectorAll('input[name="months"]').forEach((r) => r.addEventListener('change', () => {
    state.months = Number(r.value);
    form.startDate.value = monthsAgo(state.months);
    form.endDate.value = yesterday();
  }));
  for (const attr of ['data-engine', 'data-execution']) root.querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener('click', () => pressOne(root, `[${attr}]`, b)));
  form.querySelectorAll('input[name="ticker"]').forEach((r) => r.addEventListener('change', () => { state.ticker[state.market] = r.value; }));
  form.compare.addEventListener('change', () => { form.querySelector('.compare-box').hidden = !form.compare.checked; updateCount(form); });
  form.addEventListener('change', () => updateCount(form));
  form.nickname.addEventListener('input', () => saveNick(form.nickname.value.trim()));
}

function bind(root, m, onOpenRun) {
  const form = root.querySelector('#run-form');
  const err = root.querySelector('#form-error');
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
