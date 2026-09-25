import { api, qs } from '../api.js';
import { esc, pct, meta, effortLabel, intervalLabel, marketLabel, engineBadge, tickersShort, thresholdLabel, legacyTag } from '../format.js';
import { filterBar, readFilters } from './filters.js';
import { currentNickname } from './run.js';

const LIMIT = 200;
const MARKET_TABS = [['', '전체'], ['KR', '🇰🇷 한국'], ['US', '🇺🇸 미국'], ['CRYPTO', '🪙 코인']];
const SORTS = [['total_return', '수익률'], ['excess_return', '보유 대비']];
const MEDALS = ['🥇', '🥈', '🥉'];

let state = { market: '', sort: 'total_return', includeLegacy: false, more: { bestPerUser: 'true' } };

const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

function monthsBetween(a, b) {
  const m = Math.round((Date.parse(b) - Date.parse(a)) / (30.44 * 86_400_000));
  return m >= 12 && m % 12 === 0 ? `${m / 12}년` : `${m}개월`;
}

/** 정렬 기준에 따라 큰 숫자·작은 숫자 결정 */
function figures(r) {
  const vs = r.excess_return;
  const vsText = `보유 대비 ${Math.abs(vs * 100).toFixed(1)}%p ${vs >= 0 ? '앞섬' : '뒤처짐'}`;
  return state.sort === 'excess_return'
    ? { main: `${vs >= 0 ? '+' : ''}${(vs * 100).toFixed(1)}%p`, mainCls: cls(vs), sub: `수익률 ${pct(r.total_return)}`, subCls: cls(r.total_return) }
    : { main: pct(r.total_return), mainCls: cls(r.total_return), sub: vsText, subCls: cls(vs) };
}

function metaLine(r) {
  return `${esc(tickersShort(r))} · 기준 ${esc(thresholdLabel(r.threshold))}${esc(legacyTag(r.strategy))} · ${esc(monthsBetween(r.start_date, r.end_date))} · ${esc(intervalLabel(r.interval_days))} · effort ${esc(effortLabel(r.effort))}`;
}

function sparkline(values, positive) {
  if (!values || values.length < 2) return '';
  const w = 220, h = 48;
  const lo = Math.min(...values), hi = Math.max(...values);
  const step = Math.max(1, Math.floor(values.length / 120));
  const pts = values.filter((_, i) => i % step === 0 || i === values.length - 1);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8)).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" class="${positive ? 'up' : 'down'}" /></svg>`;
}

function podium(top, sparks, mine) {
  // 가운데 1위, 왼쪽 2위, 오른쪽 3위
  const order = [1, 0, 2].filter((i) => top[i]);
  return `<div class="podium">${order.map((i) => {
    const r = top[i];
    const f = figures(r);
    return `<a class="podium-card place-${i + 1} ${r.nickname === mine ? 'mine' : ''}" href="#play/${r.id}" data-run="${r.id}">
      <div class="medal" aria-label="${i + 1}위">${MEDALS[i]}</div>
      <div class="who">${esc(r.nickname)}${r.nickname === mine ? ' <span class="badge live">나</span>' : ''}</div>
      <div class="big ${f.mainCls}">${esc(f.main)}</div>
      <div class="small ${f.subCls}">${esc(f.sub)}</div>
      ${sparkline(sparks.get(r.id), r.total_return >= 0)}
      <div class="meta">${engineBadge(r.engine)} ${esc(marketLabel(r.market))} · ${metaLine(r)}</div>
      <div class="replay-hint">▶ 매매 다시보기</div>
    </a>`;
  }).join('')}</div>`;
}

function list(rows, mine) {
  if (rows.length === 0) return '';
  return `<ol class="rank-list">${rows.map((r) => {
    const f = figures(r);
    return `<li><a class="rank-row ${r.nickname === mine ? 'mine' : ''}" href="#play/${r.id}" data-run="${r.id}">
      <span class="pos-no">${r.rank}</span>
      <span class="who"><span class="name"><b>${esc(r.nickname)}</b>${r.nickname === mine ? '<span class="badge live">나</span>' : ''}</span>
        <span class="meta">${engineBadge(r.engine)} ${esc(marketLabel(r.market))} · ${metaLine(r)}</span></span>
      <span class="figs"><b class="${f.mainCls}">${esc(f.main)}</b><span class="${f.subCls}">${esc(f.sub)}</span></span>
    </a></li>`;
  }).join('')}</ol>`;
}

function myCard(rows, mine) {
  if (!mine) return `<div class="my-rank empty-cta">닉네임을 정하고 매매하면 여기에서 내 순위를 볼 수 있어요. <a class="primary-link" href="#run">▶ 매매하기</a></div>`;
  const hit = rows.find((r) => r.nickname === mine);
  if (!hit) return `<div class="my-rank empty-cta"><b>${esc(mine)}</b>님의 기록이 이 조건에는 아직 없어요. <a class="primary-link" href="#run">▶ 첫 매매 하기</a></div>`;
  const f = figures(hit);
  const ahead = rows[hit.rank - 2];
  const gap = ahead ? (state.sort === 'excess_return' ? ahead.excess_return - hit.excess_return : ahead.total_return - hit.total_return) : 0;
  return `<div class="my-rank">
    <div><div class="k">내 최고 기록</div><div class="v">${hit.rank}위 <span class="of">/ ${rows.length}</span></div></div>
    <div><div class="k">${state.sort === 'excess_return' ? '보유 대비' : '수익률'}</div><div class="v ${f.mainCls}">${esc(f.main)}</div></div>
    <div class="chase">${ahead ? `바로 위 <b>${esc(ahead.nickname)}</b>까지 <b>${(gap * 100).toFixed(1)}%p</b>` : '🏆 지금 1위예요'}</div>
    <div class="row"><a href="#play/${hit.id}">내 매매 보기</a><a class="primary-link" href="#run">▶ 다시 도전</a></div>
  </div>`;
}

async function loadSparks(top) {
  const entries = await Promise.all(top.map(async (r) => {
    try {
      const d = await api(`/api/runs/${r.id}`);
      return [r.id, d.equity.map((p) => p.equity)];
    } catch {
      return [r.id, null];
    }
  }));
  return new Map(entries);
}

async function load(root) {
  const board = root.querySelector('#rank-board');
  board.innerHTML = '<div class="empty">불러오는 중…</div>';
  try {
    const query = { ...state.more, market: state.market, sort: state.sort, limit: LIMIT, ...(state.includeLegacy ? {} : { strategy: 'noul' }) };
    const rows = await api(`/api/leaderboard?${qs(query)}`);
    const mine = currentNickname();
    root.querySelector('#my-rank').innerHTML = myCard(rows, mine);
    if (rows.length === 0) {
      board.innerHTML = '<div class="empty">아직 이 조건의 기록이 없어요. <a href="#run">첫 번째 주인공이 되어 보세요 ▶</a></div>';
      return;
    }
    const top = rows.slice(0, 3);
    board.innerHTML = `${podium(top, new Map(), mine)}${list(rows.slice(3), mine)}`;
    const sparks = await loadSparks(top);
    const pod = board.querySelector('.podium');
    if (pod) pod.outerHTML = podium(top, sparks, mine);
  } catch (ex) {
    board.innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

function tabs(name, options, current) {
  return `<div class="seg tabs" role="radiogroup" aria-label="${esc(name)}">${options.map(([v, l]) => `<label class="tab"><input type="radio" name="${esc(name)}" value="${esc(v)}" ${v === current ? 'checked' : ''} /><span>${esc(l)}</span></label>`).join('')}</div>`;
}

export function render(root) {
  const m = meta();
  root.innerHTML = `<div class="rank-head"><h2>랭킹</h2>
      <p class="lead">누가 Jev와 함께 가장 많이 벌었을까요? 기간마다 시장 상황이 달라서, 공정하게 겨루려면 <b>보유 대비</b>로 보세요.</p></div>
    <div class="rank-controls">
      ${tabs('market', MARKET_TABS, state.market)}
      ${tabs('sort', SORTS, state.sort)}
      <details class="more-filters"><summary>필터 더보기</summary>
        ${filterBar(['engine', 'execution', 'threshold', 'effort', 'intervalDays', 'period', 'bestPerUser'], state.more)}
        <label class="legacy-toggle"><input type="checkbox" id="include-legacy" ${state.includeLegacy ? 'checked' : ''} /> 이전 질문 방식(3지선다·5단계) 기록도 보기</label>
      </details>
    </div>
    <div id="my-rank"></div>
    <div id="rank-board"></div>
    ${m.jevLive ? '' : '<p class="hint">지금 기록은 모두 Mock 엔진 결과입니다. 실제 Jev 결과는 따로 집계됩니다.</p>'}`;
  root.querySelectorAll('input[name="market"]').forEach((r) => r.addEventListener('change', () => { state = { ...state, market: r.value }; load(root); }));
  root.querySelectorAll('input[name="sort"]').forEach((r) => r.addEventListener('change', () => { state = { ...state, sort: r.value }; load(root); }));
  root.querySelector('.more-filters form.filters').addEventListener('change', (e) => { state = { ...state, more: readFilters(e.currentTarget) }; load(root); });
  root.querySelector('#include-legacy').addEventListener('change', (e) => { state = { ...state, includeLegacy: e.target.checked }; load(root); });
  load(root);
}
