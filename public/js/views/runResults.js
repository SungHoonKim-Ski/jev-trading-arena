import { api, qs } from '../api.js';
import { esc, signed, thresholdLabel, legacyTag, effortLabel, intervalLabel, STATUS_LABEL, engineBadge, num } from '../format.js';

const POLL_MS = 1500;
let pollTimer = null;

function groupTable(runs) {
  const sorted = [...runs].sort((a, b) => (b.total_return ?? -Infinity) - (a.total_return ?? -Infinity));
  return `<div class="table-wrap"><table>
    <thead><tr><th>확신 기준</th><th>effort</th><th>주기</th><th>상태</th><th class="num">수익률</th><th class="num">그냥 보유보다</th><th class="num">MDD</th><th class="num">Sharpe</th><th class="num">거래</th></tr></thead>
    <tbody>${sorted.map((r) => `
      <tr class="clickable" data-run="${r.id}">
        <td>${engineBadge(r.engine)} 기준 ${esc(thresholdLabel(r.threshold))}<span class="hint">${esc(legacyTag(r.strategy))}</span></td><td>${esc(effortLabel(r.effort))}</td><td>${esc(intervalLabel(r.interval_days))}</td>
        <td>${r.status === 'running' ? `<div class="progress" title="${Math.round(r.progress * 100)}%"><div style="width:${r.progress * 100}%"></div></div>`
          : r.status === 'failed' ? `<span class="error" title="${esc(r.error)}">실패</span>` : esc(STATUS_LABEL[r.status])}</td>
        <td class="num">${signed(r.total_return)}</td><td class="num">${signed(r.excess_return)}</td>
        <td class="num">${signed(r.mdd)}</td><td class="num">${num(r.sharpe)}</td><td class="num">${r.trades ?? '–'}</td>
      </tr>`).join('')}</tbody></table></div>`;
}

export function pollGroup(container, groupId, onOpenRun) {
  clearTimeout(pollTimer);
  const tick = async () => {
    try {
      const runs = await api(`/api/runs?${qs({ groupId, limit: 100 })}`);
      const doneCount = runs.filter((r) => r.status === 'done' || r.status === 'failed').length;
      const failed = runs.filter((r) => r.status === 'failed');
      container.innerHTML = `<div class="card"><h3 style="margin-top:0">실행 결과 (${doneCount}/${runs.length})</h3>
        ${failed.length ? `<p class="error">${esc(failed[0].error)}</p>` : ''}
        ${groupTable(runs)}<p class="hint">행을 누르면 상세 결과(수익 곡선, Jev 결정, 체결 내역)를 볼 수 있습니다.</p></div>`;
      container.querySelectorAll('[data-run]').forEach((tr) => tr.addEventListener('click', () => onOpenRun(Number(tr.dataset.run))));
      if (doneCount < runs.length) pollTimer = setTimeout(tick, POLL_MS);
    } catch (ex) {
      container.innerHTML = `<p class="error">${esc(ex.message)}</p>`;
    }
  };
  tick();
}

