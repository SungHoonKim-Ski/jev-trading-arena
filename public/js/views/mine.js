import { api, qs } from '../api.js';
import { esc, signed, num, thresholdLabel, legacyTag, effortLabel, intervalLabel, marketLabel, engineBadge, tickersShort, STATUS_LABEL } from '../format.js';
import { currentNickname } from './run.js';

async function load(root, nickname, onOpenRun) {
  const out = root.querySelector('#mine-body');
  if (!nickname) { out.innerHTML = '<div class="empty">닉네임을 입력하세요.</div>'; return; }
  try {
    const runs = await api(`/api/runs?${qs({ nickname, limit: 200 })}`);
    if (runs.length === 0) { out.innerHTML = '<div class="empty">실행 기록이 없습니다.</div>'; return; }
    out.innerHTML = `<div class="table-wrap"><table><thead><tr><th>#</th><th>실행 시각</th><th>확신 기준</th><th>effort</th><th>주기</th><th>시장</th><th>종목</th><th>기간</th><th>상태</th>
      <th class="num">수익률</th><th class="num">보유 대비</th><th class="num">Sharpe</th></tr></thead><tbody>${runs.map((r) => `
      <tr class="clickable" data-run="${r.id}"><td>${r.id}</td><td>${esc(new Date(r.created_at).toLocaleString('ko-KR'))}</td>
        <td>${engineBadge(r.engine)} 기준 ${esc(thresholdLabel(r.threshold))}<span class="hint">${esc(legacyTag(r.strategy))}</span></td><td>${esc(effortLabel(r.effort))}</td><td>${esc(intervalLabel(r.interval_days))}</td>
        <td>${esc(marketLabel(r.market))}</td><td>${esc(tickersShort(r))}</td><td>${esc(r.start_date)} ~ ${esc(r.end_date)}</td>
        <td>${r.status === 'failed' ? `<span class="error" title="${esc(r.error)}">실패</span>` : esc(STATUS_LABEL[r.status])}</td>
        <td class="num">${signed(r.total_return)}</td><td class="num">${signed(r.excess_return)}</td><td class="num">${num(r.sharpe)}</td></tr>`).join('')}</tbody></table></div>`;
    out.querySelectorAll('[data-run]').forEach((tr) => tr.addEventListener('click', () => onOpenRun(Number(tr.dataset.run))));
  } catch (ex) {
    out.innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

export function render(root, onOpenRun) {
  const nick = currentNickname();
  root.innerHTML = `<h2>내 기록</h2><p class="lead">닉네임별 실행 기록입니다.</p>
    <div class="card"><div class="filters"><label>닉네임 <input type="text" id="mine-nick" value="${esc(nick)}" maxlength="20" /></label></div><div id="mine-body"></div></div>`;
  const input = root.querySelector('#mine-nick');
  input.addEventListener('change', () => load(root, input.value.trim(), onOpenRun));
  load(root, nick, onOpenRun);
}
