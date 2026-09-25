import { api } from '../api.js';
import { esc, meta } from '../format.js';

const INTERVAL_LABEL = { '1m': '1분봉', '5m': '5분봉', '60m': '60분봉' };

function coverageTable(rows) {
  if (rows.length === 0) return '<div class="empty">아직 수집된 분봉이 없습니다. 아래에서 종목을 수집하거나 VWAP 체결로 백테스트를 실행하세요.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>종목</th><th>간격</th><th class="num">분봉 수</th><th class="num">거래일 수</th><th>시작</th><th>마지막</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${esc(r.symbol)}</td><td>${esc(INTERVAL_LABEL[r.interval] ?? r.interval)}</td>
      <td class="num">${Number(r.bars).toLocaleString()}</td><td class="num">${esc(r.days)}</td><td>${esc(r.firstDate)}</td><td>${esc(r.lastDate)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function loadCoverage(root) {
  const out = root.querySelector('#coverage');
  try {
    out.innerHTML = coverageTable(await api('/api/data/coverage'));
  } catch (ex) {
    out.innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

export function render(root) {
  const specs = meta().intradaySpecs;
  root.innerHTML = `<h2>시세 데이터</h2>
    <p class="lead">무료 시세 소스(Yahoo)는 과거 틱 데이터를 주지 않고, 분봉도 최근 구간만 줍니다.
      그래서 서버가 주기적으로(기본 6시간) 분봉을 받아 DB에 <b>계속 누적</b>합니다. 오래 돌릴수록 VWAP 체결에 쓸 수 있는 기간이 늘어납니다.</p>
    <div class="card"><h3 style="margin-top:0">Yahoo 분봉 제공 한도</h3>
      <div class="chips">${specs.map((s) => `<span class="chip">${esc(INTERVAL_LABEL[s.interval])}: 최근 ${s.maxDays + 1}일</span>`).join('')}</div></div>
    <div class="card"><h3 style="margin-top:0">지금 수집</h3>
      <form id="collect-form" class="filters">
        <label>시장 <select name="market"><option value="KR">한국</option><option value="US">미국</option></select></label>
        <label>종목 <input type="text" name="tickers" placeholder="005930, 000660 또는 AAPL, NVDA" size="32" /></label>
        <button class="primary" type="submit">수집</button>
        <span id="collect-msg" class="hint" role="status"></span>
      </form></div>
    <div class="card"><h3 style="margin-top:0">DB에 저장된 분봉</h3><div id="coverage"></div></div>`;
  const form = root.querySelector('#collect-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = root.querySelector('#collect-msg');
    const button = form.querySelector('button');
    const tickers = String(form.tickers.value).split(/[\s,]+/).filter(Boolean);
    if (tickers.length === 0) { msg.textContent = '종목을 입력하세요'; return; }
    button.disabled = true;
    msg.textContent = '수집 중… (1분봉은 7일 단위로 나눠 받아 수십 초 걸릴 수 있습니다)';
    try {
      const results = await api('/api/data/collect', { method: 'POST', body: JSON.stringify({ market: form.market.value, tickers }) });
      msg.textContent = results.map((r) => `${r.symbol}: ${Object.entries(r.saved).map(([k, v]) => `${INTERVAL_LABEL[k]} +${v}`).join(', ')}${r.errors.length ? ' (일부 실패)' : ''}`).join(' · ');
      loadCoverage(root);
    } catch (ex) {
      msg.textContent = ex.message;
    } finally {
      button.disabled = false;
    }
  });
  loadCoverage(root);
}
