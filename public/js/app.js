import { api } from './api.js';
import { esc, setMeta } from './format.js';
import * as runView from './views/run.js';
import * as rankView from './views/rank.js';
import * as statsView from './views/stats.js';
import * as mineView from './views/mine.js';
import * as detailView from './views/detail.js';
import * as dataView from './views/data.js';

const VIEWS = { run: runView, rank: rankView, stats: statsView, mine: mineView, data: dataView };
let lastTab = 'run';
const rendered = new Set();

const openRun = (id) => { location.hash = `#run/${id}`; };

function show(name) {
  document.querySelectorAll('section.view').forEach((s) => s.classList.toggle('active', s.id === `view-${name}`));
  document.querySelectorAll('nav.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
}

function route() {
  const hash = location.hash.replace(/^#/, '') || 'run';
  const detail = /^run\/(\d+)$/.exec(hash);
  if (detail) {
    show('detail');
    detailView.render(document.getElementById('view-detail'), Number(detail[1]), { onBack: () => { location.hash = `#${lastTab}`; } });
    return;
  }
  const tab = VIEWS[hash] ? hash : 'run';
  lastTab = tab;
  show(tab);
  // 실행 화면은 진행 중인 결과를 유지하기 위해 한 번만 렌더, 나머지는 최신 데이터로 다시 렌더
  if (tab !== 'run' || !rendered.has(tab)) {
    VIEWS[tab].render(document.getElementById(`view-${tab}`), openRun);
    rendered.add(tab);
  }
}

async function boot() {
  try {
    const m = await api('/api/meta');
    setMeta(m);
    document.getElementById('engine-badge').innerHTML = m.jevLive
      ? `<span class="badge live">Jev 연결됨 · ${esc(m.model)}</span>`
      : '<span class="badge">Mock 모드 (API 키 없음)</span>';
    window.addEventListener('hashchange', route);
    route();
  } catch (ex) {
    document.querySelector('main').innerHTML = `<p class="error">초기화 실패: ${esc(ex.message)}</p>`;
  }
}

boot();
