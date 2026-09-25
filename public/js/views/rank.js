import { api, qs } from '../api.js';
import { esc, signed, num, strategyLabel, effortLabel, intervalLabel, marketLabel, engineBadge, tickersShort } from '../format.js';
import { filterBar, readFilters } from './filters.js';

let filters = { sort: 'total_return', bestPerUser: 'true' };

function table(rows) {
  if (rows.length === 0) return '<div class="empty">조건에 맞는 완료된 실행이 없습니다. 백테스트를 먼저 실행해 보세요.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>순위</th><th>닉네임</th><th>전략</th><th>effort</th><th>주기</th><th>시장</th><th>종목</th><th>기간</th>
      <th class="num">수익률</th><th class="num">보유 대비</th><th class="num">지수 수익률</th><th class="num">Sharpe</th><th class="num">MDD</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr class="clickable rank-${r.rank}" data-run="${r.id}">
        <td>${r.rank}</td><td><b>${esc(r.nickname)}</b></td>
        <td>${engineBadge(r.engine)} ${esc(strategyLabel(r.strategy))}</td><td>${esc(effortLabel(r.effort))}</td><td>${esc(intervalLabel(r.interval_days))}</td>
        <td>${esc(marketLabel(r.market))}</td><td title="${esc(r.tickers.join(', '))}">${esc(tickersShort(r))}</td>
        <td>${esc(r.start_date)} ~ ${esc(r.end_date)}</td>
        <td class="num"><b>${signed(r.total_return)}</b></td><td class="num">${signed(r.excess_return)}</td><td class="num">${signed(r.index_return)}</td>
        <td class="num">${num(r.sharpe)}</td><td class="num">${signed(r.mdd)}</td>
      </tr>`).join('')}</tbody></table></div>`;
}

async function load(root, onOpenRun) {
  const out = root.querySelector('#rank-table');
  out.innerHTML = '<div class="empty">불러오는 중…</div>';
  try {
    const rows = await api(`/api/leaderboard?${qs({ ...filters, limit: 100 })}`);
    out.innerHTML = table(rows);
    out.querySelectorAll('[data-run]').forEach((tr) => tr.addEventListener('click', () => onOpenRun(Number(tr.dataset.run))));
  } catch (ex) {
    out.innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

export function render(root, onOpenRun) {
  root.innerHTML = `<h2>랭킹</h2>
    <p class="lead">누가 어떤 전략으로 가장 높은 수익을 냈는지 봅니다. 기간이 다르면 시장 상황이 달라지므로, 공정 비교는 <b>보유 대비 초과수익</b> 정렬이나 기간 필터를 쓰세요.</p>
    <div class="card">${filterBar(['market', 'engine', 'execution', 'strategy', 'effort', 'intervalDays', 'sort', 'period', 'bestPerUser'], filters)}<div id="rank-table"></div></div>`;
  root.querySelector('form.filters').addEventListener('change', (e) => {
    filters = readFilters(e.currentTarget);
    load(root, onOpenRun);
  });
  load(root, onOpenRun);
}
