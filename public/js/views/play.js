import { api, qs } from '../api.js';
import { esc, meta, money, pct, marketLabel, intervalLabel, tickersText, thresholdLabel, exitRuleLabel, legacyTag, runNames } from '../format.js';
import { buildTimeline } from '../replay/timeline.js';
import { createLiveChart } from '../replay/liveChart.js';

const MS_PER_DAY_AT_1X = 200;
const SPEEDS = [1, 4, 16];
const FEED_LIMIT = 40;
const POLL_MS = 1500;

let session = null; // 현재 재생 상태 (다른 화면으로 가면 정지)

export function stop() {
  if (session) cancelAnimationFrame(session.raf);
  session = null;
}

const signedMoney = (v, c) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v), c)}`;
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

function shell(run) {
  const engine = run.engine === 'live' ? 'Jev' : 'Mock Jev';
  return `
  <a href="#" class="back">← 돌아가기</a>
  <div class="play-head">
    <div>
      <h2>${esc(run.nickname)}의 매매 <span class="badge ${run.engine === 'live' ? 'live' : ''}">${esc(engine)}</span></h2>
      <p class="lead">${esc(marketLabel(run.market))} · ${esc(tickersText(run))} · ${esc(run.start_date)} ~ ${esc(run.end_date)} · ${esc(intervalLabel(run.interval_days))} 판단 · 확신 기준 ${esc(thresholdLabel(run.threshold))}${esc(legacyTag(run.strategy))}${run.exit_rule ? ` · ${esc(exitRuleLabel(run.exit_rule))}` : ''}</p>
    </div>
    <div class="controls" role="group" aria-label="재생 조작">
      <button type="button" class="ctl" data-act="toggle" aria-label="일시정지">⏸</button>
      ${SPEEDS.map((s) => `<button type="button" class="ctl speed" data-speed="${s}">${s}x</button>`).join('')}
      <button type="button" class="ctl" data-act="end">⏭ 결과</button>
      <button type="button" class="ctl" data-act="restart" aria-label="처음부터">↺</button>
    </div>
  </div>
  <div class="scoreboard">
    <div class="score main"><div class="k">평가손익</div><div class="v" id="pnl">–</div><div class="s" id="pnl-pct">–</div></div>
    <div class="score"><div class="k">그냥 들고 있었다면</div><div class="v" id="bench">–</div><div class="s" id="vs">–</div></div>
    <div class="score"><div class="k">오늘</div><div class="v" id="today">–</div>
      <div class="progress"><div id="prog" style="width:0%"></div></div></div>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <div class="play-grid">
    <div class="card"><div class="tabs-row" id="sym-tabs"></div><div id="price-chart"></div></div>
    <div class="card feed-card"><h3>매매 일지</h3><ol id="feed" class="feed"></ol></div>
  </div>
  <div class="play-bottom">
    <div class="card"><h3 style="margin-top:0">보유 현황</h3><div id="positions"></div></div>
    <div class="card"><h3 style="margin-top:0">자산 레이스</h3><div id="race"></div></div>
  </div>
  <div id="result"></div>
  <p><a href="#run/${run.id}">상세 기록 (결정 로그·체결 내역 표) →</a></p>`;
}

function positionsHtml(t, frame, names, currency) {
  const rows = t.symbols.map((s) => {
    const p = t.frames[frame].positions[s];
    const held = p.shares > 0;
    return `<tr><td>${esc(names[s] ?? s)}</td>
      <td class="num">${held ? esc(Number(p.shares).toLocaleString('ko-KR', { maximumFractionDigits: 6 })) : '–'}</td>
      <td class="num">${held ? esc(money(p.avgCost, currency)) : '–'}</td>
      <td class="num">${p.price == null ? '–' : esc(money(p.price, currency))}</td>
      <td class="num ${cls(p.unrealized)}">${held ? `${esc(signedMoney(p.unrealized, currency))} (${esc(pct(p.unrealizedPct))})` : '관망'}</td>
      <td class="num ${cls(p.realized)}">${p.realized ? esc(signedMoney(p.realized, currency)) : '–'}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr><th>종목</th><th class="num">보유</th><th class="num">평균단가</th><th class="num">현재가</th><th class="num">평가손익</th><th class="num">실현손익</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function feedItem(e, t, names, currency, engineName) {
  const name = esc(names[e.symbol] ?? e.symbol);
  const date = esc(t.dates[e.frame]);
  if (e.type === 'decision') {
    const verb = e.action === 'buy' ? '사자' : '팔자';
    return `<li class="decision"><span class="when">${date}</span>💬 ${esc(engineName)} · ${name}: ${esc(e.text)} → <b class="${e.action === 'buy' ? 'pos' : 'neg'}">${verb}</b></li>`;
  }
  const buy = e.side === 'buy';
  return `<li class="trade ${buy ? 'buy' : 'sell'}"><span class="when">${date}</span><b>${buy ? '▲ 매수' : '▼ 매도'}</b> ${name} ${esc(Number(e.shares).toLocaleString('ko-KR', { maximumFractionDigits: 6 }))} @ ${esc(money(e.price, currency))}</li>`;
}

function showToast(root, text, kind) {
  const toast = root.querySelector('#toast');
  toast.textContent = text;
  toast.className = `toast show ${kind}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 1600);
}

async function rankOf(run) {
  try {
    const rows = await api(`/api/leaderboard?${qs({ market: run.market, engine: run.engine, limit: 200 })}`);
    const hit = rows.find((r) => r.id === run.id);
    return hit ? { rank: hit.rank, total: rows.length } : null;
  } catch {
    return null;
  }
}

async function showResult(root, run, t) {
  const last = t.frames.at(-1);
  const won = last.vsBenchmark >= 0;
  const out = root.querySelector('#result');
  out.innerHTML = `<div class="card result-card ${won ? 'won' : 'lost'}">
    <div class="result-title">${won ? '🏆 그냥 들고 있는 것보다 잘했어요' : '😵 그냥 들고 있는 게 나았어요'}</div>
    <div class="result-nums"><div><div class="k">최종 수익률</div><div class="v ${cls(last.pnlPct)}">${esc(pct(last.pnlPct))}</div></div>
      <div><div class="k">그냥 보유보다</div><div class="v ${cls(last.vsBenchmark)}">${esc(pct(last.vsBenchmark))}p</div></div>
      <div><div class="k">랭킹</div><div class="v" id="rank">…</div></div></div>
    <div class="row"><button type="button" class="ghost" data-act="restart">↺ 다시 보기</button><a class="primary-link" href="#run">▶ 새 매매</a><a href="#rank">랭킹 보기</a></div></div>`;
  out.querySelector('[data-act="restart"]').addEventListener('click', () => restart(root));
  const r = await rankOf(run);
  const rankEl = out.querySelector('#rank');
  if (rankEl) rankEl.textContent = r ? `${r.rank}위 / ${r.total}` : '–';
}

function renderFrame(root, s, frame) {
  const { t, run, currency, names, engineName } = s;
  const f = t.frames[frame];
  const pnl = root.querySelector('#pnl');
  pnl.textContent = signedMoney(f.pnl, currency);
  pnl.className = `v ${cls(f.pnl)}`;
  root.querySelector('#pnl-pct').textContent = pct(f.pnlPct);
  root.querySelector('#pnl-pct').className = `s ${cls(f.pnlPct)}`;
  root.querySelector('#bench').textContent = pct(f.benchPct);
  const vs = root.querySelector('#vs');
  vs.textContent = `${s.engineName}가 ${Math.abs(f.vsBenchmark * 100).toFixed(1)}%p ${f.vsBenchmark >= 0 ? '더' : '덜'} 벌었어요`;
  vs.className = `s ${cls(f.vsBenchmark)}`;
  root.querySelector('#today').textContent = f.date;
  root.querySelector('#prog').style.width = `${((frame + 1) / t.frames.length) * 100}%`;
  s.priceChart.render(frame);
  s.raceChart.render(frame);
  root.querySelector('#positions').innerHTML = positionsHtml(t, frame, names, currency);

  // 새로 지나간 이벤트를 일지에 추가 (최신이 위)
  const fresh = t.events.filter((e) => e.frame > s.lastFrame && e.frame <= frame);
  if (fresh.length) {
    const feed = root.querySelector('#feed');
    feed.insertAdjacentHTML('afterbegin', fresh.reverse().slice(0, FEED_LIMIT).map((e) => feedItem(e, t, names, currency, engineName)).join(''));
    while (feed.children.length > FEED_LIMIT) feed.lastElementChild.remove();
    const trade = fresh.find((e) => e.type === 'trade');
    if (trade && frame - s.lastFrame < 5) {
      pnl.classList.add('flash');
      setTimeout(() => pnl.classList.remove('flash'), 400);
    }
  }
  if (frame - s.lastFrame < 5) {
    if (f.pnl > s.peak && frame > 5 && f.pnlPct > 0.01 && frame - s.lastPeakToast > 20) {
      showToast(root, `📈 최고 수익 경신 ${pct(f.pnlPct)}`, 'up');
      s.lastPeakToast = frame;
    }
    if (s.lastPnl >= 0 && f.pnl < 0) showToast(root, '📉 손실 구간 진입', 'down');
  }
  s.peak = Math.max(s.peak, f.pnl);
  s.lastPnl = f.pnl;
  s.lastFrame = frame;
  // 이번 종목 차트의 평균단가 표시를 위해 현재 프레임 저장
  s.frame = frame;
  if (frame === t.frames.length - 1 && !s.finished) {
    s.finished = true;
    s.playing = false;
    updateControls(root, s);
    void showResult(root, run, t);
  }
}

function updateControls(root, s) {
  const toggle = root.querySelector('[data-act="toggle"]');
  toggle.textContent = s.playing ? '⏸' : '▶';
  toggle.setAttribute('aria-label', s.playing ? '일시정지' : '재생');
  root.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === s.speed)));
}

function loop(root) {
  const s = session;
  if (!s) return;
  const now = performance.now();
  if (s.playing) {
    s.acc += now - s.prev;
    const step = MS_PER_DAY_AT_1X / s.speed;
    const advance = Math.floor(s.acc / step);
    if (advance > 0) {
      s.acc -= advance * step;
      renderFrame(root, s, Math.min(s.t.frames.length - 1, s.frame + advance));
    }
  }
  s.prev = now;
  s.raf = requestAnimationFrame(() => loop(root));
}

function buildCharts(root, s, symbol) {
  const { t, currency } = s;
  const fmt = (v) => new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 2 }).format(v);
  s.symbol = symbol;
  s.priceChart = createLiveChart(root.querySelector('#price-chart'), {
    height: 360, count: t.frames.length, dates: t.dates, formatY: fmt,
    series: [{ name: s.names[symbol] ?? symbol, color: 'var(--series-1)', values: t.closes[symbol] }],
    markers: t.markers[symbol],
    refLine: (frame) => { const p = t.frames[frame].positions[symbol]; return p.shares > 0 ? p.avgCost : null; },
  });
  s.raceChart = createLiveChart(root.querySelector('#race'), {
    height: 220, count: t.frames.length, dates: t.dates, formatY: fmt,
    series: [
      { name: s.engineName, color: 'var(--series-1)', values: t.frames.map((f) => f.equity) },
      { name: '보유', color: 'var(--series-2)', values: t.frames.map((f) => f.benchmark) },
    ],
  });
}

function restart(root) {
  const s = session;
  if (!s) return;
  root.querySelector('#feed').innerHTML = '';
  root.querySelector('#result').innerHTML = '';
  Object.assign(s, { frame: 0, lastFrame: -1, peak: 0, lastPnl: 0, lastPeakToast: -99, finished: false, playing: true, acc: 0 });
  renderFrame(root, s, 0);
  updateControls(root, s);
}

function bind(root, s) {
  root.querySelector('.back').addEventListener('click', (e) => { e.preventDefault(); history.back(); });
  root.querySelector('[data-act="toggle"]').addEventListener('click', () => {
    if (s.finished) return restart(root);
    s.playing = !s.playing;
    updateControls(root, s);
  });
  root.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => { s.speed = Number(b.dataset.speed); updateControls(root, s); }));
  root.querySelector('[data-act="end"]').addEventListener('click', () => renderFrame(root, s, s.t.frames.length - 1));
  root.querySelector('[data-act="restart"]').addEventListener('click', () => restart(root));
  const tabs = root.querySelector('#sym-tabs');
  tabs.innerHTML = s.t.symbols.length > 1
    ? s.t.symbols.map((sym, i) => `<button type="button" class="chip ${i === 0 ? 'on' : ''}" data-sym="${esc(sym)}">${esc(s.names[sym] ?? sym)}</button>`).join('')
    : `<b>${esc(s.names[s.t.symbols[0]] ?? s.t.symbols[0] ?? '')}</b>`;
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sym]');
    if (!btn) return;
    tabs.querySelectorAll('[data-sym]').forEach((b) => b.classList.toggle('on', b === btn));
    buildCharts(root, s, btn.dataset.sym);
    s.priceChart.render(s.frame);
    s.raceChart.render(s.frame);
  });
}

async function waitUntilDone(root, runId) {
  for (;;) {
    const detail = await api(`/api/runs/${runId}`);
    const { run } = detail;
    if (run.status === 'done' || run.status === 'failed') return detail;
    root.innerHTML = `<div class="card waiting"><div class="spinner" aria-hidden="true"></div>
      <h2>${run.engine === 'live' ? 'Jev' : 'Mock Jev'}가 차트를 읽는 중…</h2>
      <p class="lead">${esc(tickersText(run))} · ${esc(run.start_date)} ~ ${esc(run.end_date)}</p>
      <div class="progress"><div style="width:${Math.round((run.progress ?? 0) * 100)}%"></div></div>
      <p class="hint">${Math.round((run.progress ?? 0) * 100)}% · 끝나면 매매 과정을 처음부터 재생합니다</p></div>`;
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!root.isConnected || !location.hash.startsWith(`#play/${runId}`)) return null;
  }
}

export async function render(root, runId) {
  stop();
  root.innerHTML = '<div class="empty">불러오는 중…</div>';
  let detail;
  try {
    detail = await waitUntilDone(root, runId);
  } catch (ex) {
    root.innerHTML = `<p class="error">${esc(ex.message)}</p>`;
    return;
  }
  if (!detail) return;
  const { run } = detail;
  if (run.status === 'failed') {
    root.innerHTML = `<a href="#run" class="back">← 새 매매</a><div class="card"><h2>실행에 실패했어요</h2><p class="error">${esc(run.error)}</p></div>`;
    return;
  }
  const t = buildTimeline(detail);
  root.innerHTML = shell(run);
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  session = {
    t, run, currency: meta().markets[run.market].currency, names: runNames(run),
    engineName: run.engine === 'live' ? 'Jev' : 'Mock Jev',
    frame: 0, lastFrame: -1, peak: 0, lastPnl: 0, lastPeakToast: -99, finished: false,
    playing: !reduceMotion, speed: 4, acc: 0, prev: performance.now(), raf: 0,
  };
  buildCharts(root, session, t.symbols[0]);
  bind(root, session);
  updateControls(root, session);
  renderFrame(root, session, reduceMotion ? t.frames.length - 1 : 0);
  session.raf = requestAnimationFrame(() => loop(root));
}
