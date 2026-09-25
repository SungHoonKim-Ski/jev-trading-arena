import { api } from '../api.js';
import { esc, meta } from '../format.js';
import { pollGroup } from './runResults.js';

const NICK_KEY = 'jev-arena-nickname';

const state = {
  market: 'US',
  tickers: { KR: ['005930', '000660'], US: ['AAPL', 'NVDA'] },
};

const today = () => new Date().toISOString().slice(0, 10);
const shiftMonths = (months) => {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
};
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function readNick() {
  try { return localStorage.getItem(NICK_KEY) ?? ''; } catch { return ''; }
}
function saveNick(v) {
  try { localStorage.setItem(NICK_KEY, v); } catch { /* 저장 불가 환경은 무시 */ }
}
export const currentNickname = readNick;

function checks(name, entries, checkedKeys) {
  return entries.map(([key, label, desc]) => `
    <label class="check"><input type="checkbox" name="${name}" value="${esc(key)}" ${checkedKeys.includes(key) ? 'checked' : ''} />
      <div><b>${esc(label)}</b><span>${esc(desc)}</span></div></label>`).join('');
}

function template(m) {
  const cap = m.markets[state.market].defaultCapital;
  return `
  <h2>백테스트 실행</h2>
  <p class="lead">기간·종목을 정하고, Jev 응답 방식(전략)·effort·매매 주기 조합을 골라 동시에 돌려 보세요. 결과는 랭킹에 기록됩니다.</p>
  ${m.jevLive ? '' : `<div class="notice" style="margin-bottom:16px">TYPESAFE_API_KEY가 설정되지 않아 <b>Mock 엔진</b>만 사용할 수 있습니다. Mock은 Jev와 같은 입력을 보고 규칙으로 답하는 대체 엔진이며, 실제 Jev 결과와 랭킹이 분리됩니다.</div>`}
  <form id="run-form" class="card" novalidate>
    <div class="grid-2">
      <label class="field">닉네임 <input type="text" name="nickname" maxlength="20" required value="${esc(readNick())}" placeholder="랭킹에 표시될 이름" /></label>
      <div class="field"><b>시장</b>
        <div class="seg" role="group" aria-label="시장">
          ${Object.entries(m.markets).map(([k, v]) => `<button type="button" data-market="${k}" aria-pressed="${k === state.market}">${esc(v.label)} (${esc(v.currency)})</button>`).join('')}
        </div>
      </div>
      <div class="field" style="grid-column: 1 / -1"><b>종목 <span class="hint">최대 5개 · 동일 비중 슬롯으로 운용</span></b>
        <div class="chips" id="preset-chips"></div>
        <div class="row"><input type="text" id="ticker-input" placeholder="${state.market === 'KR' ? '종목코드 6자리 (예: 005930)' : '티커 (예: AAPL)'}" /><button type="button" class="ghost" id="ticker-add">추가</button></div>
      </div>
      <div class="field"><b>기간(기한)</b>
        <div class="row"><input type="date" name="startDate" value="${shiftMonths(12)}" max="${today()}" /> ~ <input type="date" name="endDate" value="${yesterday()}" max="${yesterday()}" /></div>
        <div class="chips">${[[6, '6개월'], [12, '1년'], [24, '2년'], [36, '3년'], [60, '5년']].map(([mo, l]) => `<button type="button" class="chip" data-months="${mo}">최근 ${l}</button>`).join('')}</div>
      </div>
      <label class="field">초기 자본 (${esc(m.markets[state.market].currency)}) <input type="number" name="initialCapital" min="100" step="any" value="${cap}" /></label>
      <div class="field"><b>엔진</b>
        <div class="seg" role="group" aria-label="엔진">
          <button type="button" data-engine="live" aria-pressed="${m.jevLive}" ${m.jevLive ? '' : 'disabled'}>Jev (${esc(m.model)})</button>
          <button type="button" data-engine="mock" aria-pressed="${!m.jevLive}">Mock</button>
        </div>
      </div>
      <div class="field"><b>체결 방식</b>
        <div class="seg" role="group" aria-label="체결 방식">
          <button type="button" data-execution="open" aria-pressed="true">다음 날 시가</button>
          <button type="button" data-execution="vwap" aria-pressed="false">다음 날 분봉 VWAP</button>
        </div>
        <span class="hint">VWAP은 DB에 수집된 가장 촘촘한 분봉(1분→5분→60분)으로 계산하고, 분봉이 없는 날은 일봉 평균가로 대체합니다.</span>
      </div>
    </div>
    <h3>전략 · Jev 응답 방식</h3>
    <div class="checks">${checks('strategies', Object.entries(m.strategies).map(([k, v]) => [k, v.label, v.description]), ['probability', 'noul'])}</div>
    <h3>Jev effort</h3>
    <div class="checks">${checks('efforts', Object.entries(m.efforts).map(([k, v]) => [k, v.label, v.description]), ['low', 'high'])}</div>
    <h3>매매(구매) 주기</h3>
    <div class="checks">${checks('intervals', m.intervals.map((i) => [String(i.days), i.label, `${i.days}거래일마다 종가로 판단 → 다음 거래일 체결`]), ['5'])}</div>
    <div class="submit-bar">
      <button class="primary" type="submit">실행</button>
      <span id="combo-count" class="hint"></span>
      <span id="form-error" class="error" role="alert"></span>
    </div>
  </form>
  <div id="group-result"></div>`;
}

function renderChips(root, m) {
  const selected = state.tickers[state.market];
  const presets = m.presets[state.market];
  const known = new Set(presets.map((p) => p.ticker));
  const extra = selected.filter((t) => !known.has(t)).map((t) => ({ ticker: t, name: t }));
  root.querySelector('#preset-chips').innerHTML = [...presets, ...extra].map((p) =>
    `<button type="button" class="chip ${selected.includes(p.ticker) ? 'on' : ''}" data-ticker="${esc(p.ticker)}" aria-pressed="${selected.includes(p.ticker)}">${esc(p.name)}${p.name !== p.ticker ? ` <span class="hint">${esc(p.ticker)}</span>` : ''}</button>`).join('');
}

function formValues(form) {
  const fd = new FormData(form);
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
    strategies: all('strategies'),
    efforts: all('efforts'),
    intervals: all('intervals').map(Number),
  };
}

function updateCount(form) {
  const v = formValues(form);
  const n = v.strategies.length * v.efforts.length * v.intervals.length;
  const max = meta().maxRunsPerRequest;
  form.querySelector('#combo-count').textContent = `${n}개 조합 실행${n > max ? ` (최대 ${max}개)` : ''}`;
}

function toggleTicker(t) {
  const list = state.tickers[state.market];
  state.tickers[state.market] = list.includes(t) ? list.filter((x) => x !== t) : list.length >= 5 ? list : [...list, t];
}

function bind(root, m, onOpenRun) {
  const form = root.querySelector('#run-form');
  const err = root.querySelector('#form-error');
  renderChips(root, m);
  updateCount(form);
  form.addEventListener('change', () => updateCount(form));
  form.nickname.addEventListener('input', () => saveNick(form.nickname.value.trim()));
  root.querySelectorAll('[data-market]').forEach((b) => b.addEventListener('click', () => {
    state.market = b.dataset.market;
    render(root, onOpenRun);
  }));
  for (const attr of ['data-engine', 'data-execution']) {
    root.querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener('click', () => {
      root.querySelectorAll(`[${attr}]`).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
  }
  root.querySelector('#preset-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-ticker]');
    if (!chip) return;
    toggleTicker(chip.dataset.ticker);
    renderChips(root, m);
  });
  const addTicker = () => {
    const input = root.querySelector('#ticker-input');
    const t = input.value.trim().toUpperCase();
    if (!t) return;
    if (!state.tickers[state.market].includes(t)) toggleTicker(t);
    input.value = '';
    renderChips(root, m);
  };
  root.querySelector('#ticker-add').addEventListener('click', addTicker);
  root.querySelector('#ticker-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTicker(); } });
  root.querySelectorAll('[data-months]').forEach((b) => b.addEventListener('click', () => {
    form.startDate.value = shiftMonths(Number(b.dataset.months));
    form.endDate.value = yesterday();
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const values = formValues(form);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const { groupId } = await api('/api/runs', { method: 'POST', body: JSON.stringify(values) });
      saveNick(values.nickname);
      pollGroup(root.querySelector('#group-result'), groupId, onOpenRun);
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
