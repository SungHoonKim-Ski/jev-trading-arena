import { api } from '../api.js';
import { esc, meta } from '../format.js';

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const INTERVAL_LABEL = { '1m': '1분봉', '5m': '5분봉', '60m': '60분봉' };

const gb = (b) => `${(b / 1e9).toFixed(2)}GB`;

function tickSection(info) {
  if (!info.enabled) return '<div class="empty">이 서버에서는 원본 틱 저장소를 쓸 수 없습니다 (로컬 서버 전용).</div>';
  const pct = info.maxBytes > 0 ? Math.min(100, (info.sizeBytes / info.maxBytes) * 100) : 0;
  const rows = info.coverage.length === 0 ? '<div class="empty">아직 수집된 틱이 없습니다.</div>'
    : `<div class="table-wrap"><table><thead><tr><th>코인</th><th class="num">일수</th><th class="num">체결 건수</th><th>시작</th><th>마지막</th></tr></thead>
      <tbody>${info.coverage.map((c) => `<tr><td>${esc(c.symbol)}</td><td class="num">${esc(c.days)}</td><td class="num">${Number(c.trades).toLocaleString()}</td>
      <td>${esc(c.firstDate)}</td><td>${esc(c.lastDate)}</td></tr>`).join('')}</tbody></table></div>`;
  return `<div class="row" style="margin-bottom:12px"><span>저장소 ${esc(gb(info.sizeBytes))} / 상한 ${esc(gb(info.maxBytes))}</span>
      <div class="progress" style="flex:1; max-width:320px"><div style="width:${pct}%"></div></div></div>${rows}`;
}

async function loadTicks(root) {
  const out = root.querySelector('#tick-coverage');
  try {
    out.innerHTML = tickSection(await api('/api/ticks/coverage'));
  } catch (ex) {
    out.innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

function bindTickForm(root) {
  const form = root.querySelector('#tick-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = root.querySelector('#tick-msg');
    const button = form.querySelector('button');
    const tickers = [...form.querySelectorAll('input[name="coin"]:checked')].map((c) => c.value);
    button.disabled = true;
    msg.textContent = '틱 파일을 받는 중… (코인·일자당 수 초, 비트코인은 하루 약 25MB)';
    try {
      const results = await api('/api/ticks/collect', { method: 'POST', body: JSON.stringify({ tickers, from: form.from.value, to: form.to.value }) });
      const failed = results.filter((r) => r.error);
      const added = results.filter((r) => !r.error && !r.cached).reduce((s, r) => s + r.trades, 0);
      msg.textContent = `새 체결 ${added.toLocaleString()}건 저장${failed.length ? ` · 실패 ${failed.length}건: ${failed[0].error}` : ''}`;
      loadTicks(root);
    } catch (ex) {
      msg.textContent = ex.message;
    } finally {
      button.disabled = false;
    }
  });
}

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
    <p class="lead">주식 시세 소스(Yahoo)는 과거 틱을 주지 않고 분봉도 최근 구간만 줍니다. 그래서 서버가 주기적으로(기본 6시간) 주식 분봉을 받아 DB에 <b>계속 누적</b>합니다.
      코인은 바이낸스가 1분봉 전체 이력과 원본 체결을 공개하므로, 체결일에 필요한 만큼 받아 쓰고 원본 틱은 따로 저장합니다.</p>
    <div class="card"><h3 style="margin-top:0">Yahoo 분봉 제공 한도</h3>
      <div class="chips">${specs.map((s) => `<span class="chip">${esc(INTERVAL_LABEL[s.interval])}: 최근 ${s.maxDays + 1}일</span>`).join('')}</div></div>
    <div class="card"><h3 style="margin-top:0">지금 수집</h3>
      <form id="collect-form" class="filters">
        <label>시장 <select name="market"><option value="KR">한국</option><option value="US">미국</option></select></label>
        <label>종목 <input type="text" name="tickers" placeholder="005930, 000660 또는 AAPL, NVDA" size="32" /></label>
        <button class="primary" type="submit">수집</button>
        <span id="collect-msg" class="hint" role="status"></span>
      </form></div>
    <div class="card"><h3 style="margin-top:0">DB에 저장된 분봉</h3><div id="coverage"></div></div>
    <div class="card"><h3 style="margin-top:0">코인 원본 틱 (바이낸스 체결 내역)</h3>
      <p class="hint">바이낸스가 공개하는 모든 체결을 로컬 DuckDB에 저장합니다. 매일 전날 5종을 자동 수집하고, 틱 체결 백테스트는 필요한 날을 자동으로 받습니다. 5종 하루 약 120MB라 용량 상한에 도달하면 수집을 멈춥니다.</p>
      ${meta().ticksEnabled ? `<form id="tick-form" class="filters">
        ${meta().cryptoAssets.map((a, i) => `<label><input type="checkbox" name="coin" value="${esc(a.ticker)}" ${i === 0 ? 'checked' : ''} /> ${esc(a.name)}</label>`).join('')}
        <label>기간 <input type="date" name="from" value="${yesterday()}" max="${yesterday()}" /> ~ <input type="date" name="to" value="${yesterday()}" max="${yesterday()}" /></label>
        <button class="primary" type="submit">틱 수집</button><span id="tick-msg" class="hint" role="status"></span>
        <span class="hint">한 번에 코인×일수 10개까지. 긴 기간은 <code>npm run ticks -- ALL 시작일 종료일</code></span>
      </form>` : ''}
      <div id="tick-coverage"></div></div>`;
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
  loadTicks(root);
  bindTickForm(root);
}
