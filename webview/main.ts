import { computeGraph, type GraphRow } from '../src/shared/graph';
import type {
  CommitDetails,
  CommitFile,
  CommitRow,
  FromWebview,
  HistoryData,
  HistoryOptions,
  HistoryState,
  RefBadge,
  ToWebview,
} from '../src/shared/protocol';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const post = (message: FromWebview) => vscode.postMessage(message);

const ROW = 22;
const LANE = 12;
const MAX_GRAPH = 320;

type SectionId = 'incoming' | 'local' | 'all' | 'search';

type Item =
  | { kind: 'section'; id: SectionId; label: string; actions: { label: string; command: string; title: string }[] }
  | { kind: 'commit'; commit: CommitRow; graph?: GraphRow; section: SectionId };

interface UiState {
  widths: { graph?: number; author: number; date: number; id: number };
  detailsHeight: number;
  showDetails: boolean;
  collapsed: Partial<Record<SectionId, boolean>>;
}

const ui: UiState = {
  widths: { author: 150, date: 170, id: 84 },
  detailsHeight: 280,
  showDetails: true,
  collapsed: {},
  ...(vscode.getState() as Partial<UiState> | undefined),
};
const saveUi = () => vscode.setState(ui);

let state: HistoryState | undefined;
let data: HistoryData | undefined;
let items: Item[] = [];
let incomingGraph: GraphRow[] = [];
let localGraph: GraphRow[] = [];
let outgoing = new Set<string>();
let incomingSet = new Set<string>();
let selected: string | undefined;
let details: CommitDetails | undefined;
let detailsLoading = false;
let loadingMore = false;
let autoGraphWidth = 40;
let errorText = '';

// ------------------------------------------------------------------ utilities

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const ctx = (o: Record<string, unknown>) => esc(JSON.stringify({ ...o, preventDefaultContextMenuItems: true }));
const icon = (name: string, extra = '') => `<span class="codicon codicon-${name} ${extra}"></span>`;
const short = (hash: string) => hash.slice(0, 8);

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  switch (state?.dateFormat) {
    case 'iso':
      return iso.replace('T', ' ').slice(0, 19);
    case 'relative': {
      const s = Math.round((Date.now() - d.getTime()) / 1000);
      const units: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
      for (const [secs, name] of units) {
        const n = Math.floor(s / secs);
        if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
      }
      return 'just now';
    }
    default:
      return d.toLocaleString();
  }
}

// ------------------------------------------------------------------ layout

const app = document.getElementById('app')!;
app.innerHTML = `
<div class="toolbar" role="toolbar">
  <button class="repo-button" data-command="gitRepository.switchRepository" title="Switch Repository">
    ${icon('repo')}<span class="repo-name">Git Repository</span>${icon('chevron-down')}
  </button>
  <div class="actions">
    <button class="action" data-command="gitRepository.refresh" title="Refresh">${icon('refresh')}</button>
    <span class="separator"></span>
    <button class="action" data-command="gitRepository.fetch" title="Fetch">${icon('repo-fetch')}</button>
    <button class="action" data-command="gitRepository.pull" title="Pull">${icon('repo-pull')}</button>
    <button class="action" data-command="gitRepository.push" title="Push">${icon('repo-push')}</button>
    <button class="action" data-command="gitRepository.sync" title="Sync (Pull then Push)">${icon('sync')}</button>
    <span class="separator"></span>
    <button class="action" data-command="gitRepository.createBranch" title="New Branch...">${icon('git-branch-create')}</button>
    <span class="separator"></span>
    <button class="action toggle" data-option="mode" title="Show All Branches">${icon('list-tree')}</button>
    <button class="action toggle" data-option="showRemotes" title="Show Remote Branches">${icon('cloud')}</button>
    <button class="action toggle" data-option="showTags" title="Show Tags">${icon('tag')}</button>
    <button class="action toggle" data-option="firstParent" title="Show First Parent Only">${icon('list-flat')}</button>
    <span class="separator"></span>
    <button class="action toggle" data-ui="details" title="Show Commit Details">${icon('layout-panel')}</button>
  </div>
  <div class="search">
    <input type="text" placeholder="Filter History" aria-label="Filter history by message, author or commit ID" spellcheck="false">
    <button class="action clear-search hidden" title="Clear">${icon('close')}</button>
    ${icon('search', 'search-icon')}
  </div>
</div>
<div class="progress"><div class="bar"></div></div>
<div class="banner error hidden"></div>
<div class="banner operation hidden"></div>
<div class="infobar">
  <span class="label">Branch / Tag:</span>
  <a class="ref-link" title="Select a branch or tag to view">&nbsp;</a>
  <span class="upstream"></span>
  <a class="head-link hidden" title="Show the checked-out branch">${icon('home')} Current branch</a>
</div>
<div class="content">
  <div class="grid">
    <div class="header">
      <div class="hcell graph">Graph<span class="resizer" data-col="graph"></span></div>
      <div class="hcell message">Message</div>
      <div class="hcell author">Author<span class="resizer left" data-col="author"></span></div>
      <div class="hcell date">Date<span class="resizer left" data-col="date"></span></div>
      <div class="hcell id">ID<span class="resizer left" data-col="id"></span></div>
    </div>
    <div class="viewport" tabindex="0" role="grid" aria-label="Commit history">
      <div class="spacer"></div>
      <div class="rows"></div>
    </div>
    <div class="empty hidden"></div>
  </div>
  <div class="sash" title="Drag to resize"></div>
  <div class="details" tabindex="-1"></div>
</div>`;

const $ = <T extends Element = HTMLElement>(sel: string) => app.querySelector(sel) as unknown as T;
const grid = $('.grid');
const viewport = $('.viewport');
const spacer = $('.spacer');
const rowsEl = $('.rows');
const emptyEl = $('.empty');
const detailsEl = $('.details');
const sash = $('.sash');
const searchInput = $<HTMLInputElement>('.search input');
const clearSearch = $('.clear-search');

// ------------------------------------------------------------------ toolbar

app.querySelector('.toolbar')!.addEventListener('click', e => {
  const button = (e.target as HTMLElement).closest('button');
  if (!button) return;
  if (button.dataset.command) {
    post({ type: 'command', command: button.dataset.command });
  } else if (button.dataset.option && state) {
    const key = button.dataset.option as keyof HistoryOptions;
    const value = key === 'mode' ? (state.options.mode === 'all' ? 'current' : 'all') : !state.options[key];
    post({ type: 'setOption', key, value });
  } else if (button.dataset.ui === 'details') {
    ui.showDetails = !ui.showDetails;
    saveUi();
    applyLayout();
  } else if (button === clearSearch) {
    searchInput.value = '';
    onSearch(true);
  }
});

let searchTimer: number | undefined;
function onSearch(immediate = false) {
  clearSearch.classList.toggle('hidden', !searchInput.value);
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => post({ type: 'filter', text: searchInput.value }), immediate ? 0 : 400);
}
searchInput.addEventListener('input', () => onSearch());
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    onSearch(true);
  } else if (e.key === 'Enter') {
    onSearch(true);
  } else if (e.key === 'ArrowDown') {
    viewport.focus();
  }
});

$('.ref-link').addEventListener('click', () => post({ type: 'command', command: 'gitRepository.showHistory', args: [{ pick: true }] }));
$('.head-link').addEventListener('click', () => post({ type: 'command', command: 'gitRepository.showHistory' }));

app.querySelector('.banner.operation')!.addEventListener('click', e => {
  const a = (e.target as HTMLElement).closest<HTMLElement>('[data-command]');
  if (a) post({ type: 'command', command: a.dataset.command! });
});

// ------------------------------------------------------------------ column sizing & split

function graphWidth(): number {
  if (data?.isSearch) return 0;
  return ui.widths.graph ?? autoGraphWidth;
}

function applyLayout() {
  grid.style.setProperty('--w-graph', `${graphWidth()}px`);
  grid.style.setProperty('--w-author', `${ui.widths.author}px`);
  grid.style.setProperty('--w-date', `${ui.widths.date}px`);
  grid.style.setProperty('--w-id', `${ui.widths.id}px`);
  grid.classList.toggle('no-graph', graphWidth() === 0);
  detailsEl.classList.toggle('hidden', !ui.showDetails);
  sash.classList.toggle('hidden', !ui.showDetails);
  detailsEl.style.height = `${clampDetails(ui.detailsHeight)}px`;
  app.querySelector('[data-ui="details"]')!.classList.toggle('checked', ui.showDetails);
  renderRows();
}

function clampDetails(height: number): number {
  const total = (app.querySelector('.content') as HTMLElement).clientHeight;
  return total > 0 ? Math.max(80, Math.min(height, Math.round(total * 0.75))) : height;
}
window.addEventListener('resize', () => {
  detailsEl.style.height = `${clampDetails(ui.detailsHeight)}px`;
});

function drag(onMove: (e: MouseEvent) => void, cursor: string) {
  document.body.style.cursor = cursor;
  document.body.classList.add('dragging');
  const up = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', up);
    document.body.style.cursor = '';
    document.body.classList.remove('dragging');
    saveUi();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', up);
}

app.querySelector('.header')!.addEventListener('mousedown', e => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('.resizer');
  if (!r) return;
  e.preventDefault();
  const col = r.dataset.col as keyof UiState['widths'];
  const startX = (e as MouseEvent).clientX;
  const start = col === 'graph' ? graphWidth() : ui.widths[col]!;
  drag(m => {
    const delta = m.clientX - startX;
    ui.widths[col] = Math.max(col === 'graph' ? 16 : 40, col === 'graph' ? start + delta : start - delta);
    applyLayout();
  }, 'col-resize');
});

app.querySelector('.header')!.addEventListener('dblclick', e => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('.resizer');
  if (r?.dataset.col === 'graph') {
    delete ui.widths.graph;
    saveUi();
    applyLayout();
  }
});

sash.addEventListener('mousedown', e => {
  e.preventDefault();
  const startY = e.clientY;
  const start = ui.detailsHeight;
  drag(m => {
    ui.detailsHeight = clampDetails(start - (m.clientY - startY));
    detailsEl.style.height = `${ui.detailsHeight}px`;
    renderRows();
  }, 'row-resize');
});

// ------------------------------------------------------------------ building items

function buildItems() {
  items = [];
  if (!data || !state) return;
  outgoing = new Set(data.outgoing);
  incomingSet = new Set(data.incomingHashes);

  const opts = state.options;
  const isBranch = state.refType === 'branch';
  const upstreamActions = state.upstream
    ? [
        { label: 'Push', command: 'gitRepository.push', title: `Push to ${state.upstream}` },
        { label: 'Sync', command: 'gitRepository.sync', title: 'Pull then push' },
      ]
    : isBranch && state.hasRemotes
      ? [{ label: 'Publish', command: 'gitRepository.push', title: 'Publish this branch to a remote' }]
      : [];
  const isHeadRef = state.refLabel === state.headLabel;

  if (data.isSearch) {
    items.push({ kind: 'section', id: 'search', label: `Search Results (${data.commits.length}${data.commits.length >= 1000 ? '+' : ''})`, actions: [] });
    if (!ui.collapsed.search) for (const commit of data.commits) items.push({ kind: 'commit', commit, section: 'search' });
    localGraph = [];
    incomingGraph = [];
  } else if (opts.mode === 'all') {
    localGraph = computeGraph(data.commits);
    incomingGraph = [];
    const counts = state.upstream ? ` — ${state.ahead} outgoing, ${state.behind} incoming` : '';
    items.push({ kind: 'section', id: 'all', label: `All Branches${counts}`, actions: isHeadRef ? upstreamActions : [] });
    if (!ui.collapsed.all) data.commits.forEach((commit, i) => items.push({ kind: 'commit', commit, graph: localGraph[i], section: 'all' }));
  } else {
    if (data.incoming && state.upstream) {
      incomingGraph = computeGraph(data.incoming);
      items.push({
        kind: 'section',
        id: 'incoming',
        label: `Incoming (${data.incoming.length})`,
        actions: isHeadRef
          ? [
              { label: 'Fetch', command: 'gitRepository.fetch', title: 'Fetch' },
              { label: 'Pull', command: 'gitRepository.pull', title: `Pull from ${state.upstream}` },
            ]
          : [{ label: 'Fetch', command: 'gitRepository.fetch', title: 'Fetch' }],
      });
      if (!ui.collapsed.incoming) data.incoming.forEach((commit, i) => items.push({ kind: 'commit', commit, graph: incomingGraph[i], section: 'incoming' }));
    } else {
      incomingGraph = [];
    }
    localGraph = computeGraph(data.commits);
    const label = state.upstream ? `Local History (${state.ahead} Outgoing)` : isBranch ? 'Local History' : 'History';
    items.push({ kind: 'section', id: 'local', label, actions: isHeadRef ? upstreamActions : [] });
    if (!ui.collapsed.local) data.commits.forEach((commit, i) => items.push({ kind: 'commit', commit, graph: localGraph[i], section: 'local' }));
  }

  const lanes = Math.max(1, ...localGraph.map(g => g.width), ...incomingGraph.map(g => g.width));
  autoGraphWidth = Math.max(56, Math.min(MAX_GRAPH, lanes * LANE + LANE));
}

// ------------------------------------------------------------------ rendering

function graphSvg(row: GraphRow, commit: CommitRow): string {
  const x = (lane: number) => lane * LANE + LANE / 2 + 2;
  const mid = ROW / 2;
  let paths = '';
  for (const s of row.segments) {
    const x1 = x(s.from);
    const x2 = x(s.to);
    const [y1, y2] = s.half === 'top' ? [0, mid] : [mid, ROW];
    const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
    paths += `<path d="${d}" class="line c${s.color % 5}"/>`;
  }
  const cx = x(row.lane);
  const color = row.color % 5;
  const isHead = commit.hash === state?.headHash;
  let node: string;
  if (isHead) {
    node = `<circle cx="${cx}" cy="${mid}" r="5.5" class="node-ring c${color}"/><circle cx="${cx}" cy="${mid}" r="2.5" class="node f${color}"/>`;
  } else if (commit.parents.length > 1) {
    node = `<circle cx="${cx}" cy="${mid}" r="4" class="node-ring c${color}"/>`;
  } else {
    node = `<circle cx="${cx}" cy="${mid}" r="4" class="node f${color}"/>`;
  }
  return `<svg width="${Math.max(row.width, row.lane + 1) * LANE + 4}" height="${ROW}" aria-hidden="true">${paths}${node}</svg>`;
}

function mergeBadges(refs: RefBadge[]): (RefBadge & { synced?: string })[] {
  const remotes = refs.filter(r => r.type === 'remote');
  const consumed = new Set<RefBadge>();
  const result: (RefBadge & { synced?: string })[] = [];
  for (const r of refs) {
    if (r.type !== 'branch') continue;
    const twin = remotes.find(rm => !consumed.has(rm) && rm.name.endsWith('/' + r.name) && !rm.name.slice(0, -(r.name.length + 1)).includes('/'));
    if (twin) consumed.add(twin);
    result.push({ ...r, synced: twin?.name });
  }
  for (const r of refs) if (r.type !== 'branch' && !consumed.has(r)) result.push(r);
  return result;
}

function badgeHtml(b: RefBadge & { synced?: string }): string {
  const iconName = b.type === 'tag' ? 'tag' : b.type === 'remote' ? 'cloud' : b.type === 'head' ? 'target' : b.isCurrent ? 'check' : 'git-branch';
  const context = b.type === 'head' ? '' : ` data-vscode-context="${ctx({ webviewSection: 'ref', refType: b.type, refName: b.name, refFull: b.fullName, isCurrentRef: !!b.isCurrent })}"`;
  const title = b.synced ? `${b.fullName}\nIn sync with ${b.synced}` : b.fullName;
  return `<span class="badge ${b.type}${b.isCurrent ? ' current' : ''}" title="${esc(title)}"${context} data-ref="${esc(JSON.stringify(b))}">${icon(iconName)}<span class="badge-label">${esc(b.name)}</span>${b.synced ? icon('cloud', 'synced') : ''}</span>`;
}

function renderItem(item: Item, index: number): string {
  const top = index * ROW;
  if (item.kind === 'section') {
    const collapsed = !!ui.collapsed[item.id];
    const actions = item.actions.map(a => `<a class="link" data-command="${a.command}" title="${esc(a.title)}">${esc(a.label)}</a>`).join('<span class="pipe">|</span>');
    return `<div class="row section" style="top:${top}px" data-section="${item.id}" role="row" aria-expanded="${!collapsed}">
      ${icon(collapsed ? 'chevron-right' : 'chevron-down', 'twistie')}<span class="section-label">${esc(item.label)}</span><span class="section-actions">${actions}</span></div>`;
  }
  const c = item.commit;
  const isOut = outgoing.has(c.hash);
  const isIn = item.section === 'incoming' || incomingSet.has(c.hash);
  const marker = isOut
    ? `<span class="marker" title="Outgoing (not yet pushed)">${icon('arrow-up')}</span>`
    : isIn
      ? `<span class="marker" title="Incoming (not yet pulled)">${icon('arrow-down')}</span>`
      : `<span class="marker"></span>`;
  const context = ctx({
    webviewSection: 'commit',
    hash: c.hash,
    parentHash: c.parents[0] ?? '',
    isHead: c.hash === state?.headHash,
    isMerge: c.parents.length > 1,
  });
  const sel = c.hash === selected ? ' selected' : '';
  return `<div class="row commit${sel}${isIn && item.section === 'incoming' ? ' incoming' : ''}" style="top:${top}px" data-hash="${c.hash}" data-vscode-context="${context}" role="row" aria-selected="${!!sel}">
    <div class="cell graph">${item.graph && graphWidth() > 0 ? graphSvg(item.graph, c) : ''}</div>
    <div class="cell message">${marker}${c.refs.length ? `<span class="refs">${mergeBadges(c.refs).map(badgeHtml).join('')}</span>` : ''}<span class="subject" title="${esc(c.subject)}">${esc(c.subject)}</span></div>
    <div class="cell author" title="${esc(`${c.author} <${c.authorEmail}>`)}">${esc(c.author)}</div>
    <div class="cell date" title="${esc(new Date(c.date).toString())}">${esc(formatDate(c.date))}</div>
    <div class="cell id">${short(c.hash)}</div>
  </div>`;
}

let renderQueued = false;
function renderRows() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    spacer.style.height = `${items.length * ROW}px`;
    const top = viewport.scrollTop;
    const height = viewport.clientHeight;
    const start = Math.max(0, Math.floor(top / ROW) - 8);
    const end = Math.min(items.length, Math.ceil((top + height) / ROW) + 8);
    let html = '';
    for (let i = start; i < end; i++) html += renderItem(items[i], i);
    rowsEl.innerHTML = html;
    if (data && data.hasMore && !loadingMore && !data.isSearch && end >= items.length - 20) {
      loadingMore = true;
      post({ type: 'loadMore' });
    }
  });
}

viewport.addEventListener('scroll', renderRows);
new ResizeObserver(renderRows).observe(viewport);

function renderState() {
  if (!state) return;
  $('.repo-name').textContent = state.repoName;
  $('.repo-button').title = `${state.repoRoot}\nSwitch Repository`;
  const refLink = $('.ref-link');
  refLink.innerHTML = `${icon(state.refType === 'tag' ? 'tag' : state.refType === 'commit' ? 'git-commit' : state.refType === 'remote' ? 'cloud' : 'git-branch')} ${esc(state.refLabel)} ${icon('chevron-down')}`;
  $('.upstream').textContent = state.upstream ? `tracking ${state.upstream}  ↑${state.ahead} ↓${state.behind}` : '';
  $('.head-link').classList.toggle('hidden', state.refLabel === state.headLabel);
  for (const b of app.querySelectorAll<HTMLElement>('[data-option]')) {
    const key = b.dataset.option as keyof HistoryOptions;
    b.classList.toggle('checked', key === 'mode' ? state.options.mode === 'all' : !!state.options[key]);
    b.setAttribute('aria-pressed', String(b.classList.contains('checked')));
  }
  if (document.activeElement !== searchInput && searchInput.value !== state.filter) {
    searchInput.value = state.filter;
    clearSearch.classList.toggle('hidden', !state.filter);
  }
  const op = $('.banner.operation');
  if (state.operation) {
    op.innerHTML = `${icon('warning')} <span>A <b>${esc(state.operation)}</b> is in progress. Resolve any conflicts in Source Control, then</span>
      <a class="link" data-command="gitRepository.continueOperation">Continue</a><span class="pipe">|</span>
      <a class="link" data-command="gitRepository.abortOperation">Abort</a><span class="pipe">|</span>
      <a class="link" data-command="workbench.view.scm">Open Source Control</a>`;
    op.classList.remove('hidden');
  } else {
    op.classList.add('hidden');
  }
}

function renderError() {
  const el = $('.banner.error');
  el.classList.toggle('hidden', !errorText);
  el.innerHTML = errorText ? `${icon('error')} <span>${esc(errorText)}</span>` : '';
}

function renderEmpty() {
  const hasCommits = items.some(i => i.kind === 'commit');
  const sectionsCollapsed = items.length > 0;
  emptyEl.classList.toggle('hidden', hasCommits || (sectionsCollapsed && !data?.isSearch && (data?.commits.length ?? 0) > 0));
  emptyEl.textContent = data?.isSearch ? 'No commits match the filter.' : 'No commits yet.';
}

// ------------------------------------------------------------------ selection & details

function commitIndex(hash: string): number {
  return items.findIndex(i => i.kind === 'commit' && i.commit.hash === hash);
}

function select(hash: string | undefined, reveal = false) {
  if (!hash) return;
  if (selected !== hash) {
    selected = hash;
    details = undefined;
    detailsLoading = true;
    post({ type: 'selectCommit', hash });
    renderDetails();
  }
  if (reveal) {
    const idx = commitIndex(hash);
    if (idx >= 0) {
      const top = idx * ROW;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + ROW > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + ROW - viewport.clientHeight;
    }
  }
  renderRows();
}

function toggleSection(id: SectionId) {
  ui.collapsed[id] = !ui.collapsed[id];
  saveUi();
  buildItems();
  renderRows();
}

rowsEl.addEventListener('mousedown', e => {
  const target = e.target as HTMLElement;
  if (target.closest('.link')) return;
  const row = target.closest<HTMLElement>('.row.commit');
  if (row) select(row.dataset.hash);
});

rowsEl.addEventListener('click', e => {
  const target = e.target as HTMLElement;
  const link = target.closest<HTMLElement>('.link');
  if (link?.dataset.command) {
    post({ type: 'command', command: link.dataset.command });
    return;
  }
  const section = target.closest<HTMLElement>('.row.section');
  if (section) toggleSection(section.dataset.section as SectionId);
});

rowsEl.addEventListener('dblclick', e => {
  const badge = (e.target as HTMLElement).closest<HTMLElement>('.badge');
  if (badge?.dataset.ref) {
    const ref = JSON.parse(badge.dataset.ref) as RefBadge;
    if (ref.type !== 'head') {
      post({ type: 'command', command: 'gitRepository.showHistory', args: [{ webviewSection: 'ref', refType: ref.type, refName: ref.name, refFull: ref.fullName, isCurrentRef: !!ref.isCurrent }] });
    }
  }
});

viewport.addEventListener('keydown', e => {
  const commits = items.map((it, i) => ({ it, i })).filter(x => x.it.kind === 'commit');
  if (commits.length === 0) return;
  const pos = selected ? commits.findIndex(x => (x.it as { commit: CommitRow }).commit.hash === selected) : -1;
  const page = Math.max(1, Math.floor(viewport.clientHeight / ROW) - 1);
  let next = pos;
  switch (e.key) {
    case 'ArrowDown': next = Math.min(commits.length - 1, pos + 1); break;
    case 'ArrowUp': next = Math.max(0, pos - 1); break;
    case 'PageDown': next = Math.min(commits.length - 1, pos + page); break;
    case 'PageUp': next = Math.max(0, pos - page); break;
    case 'Home': next = 0; break;
    case 'End': next = commits.length - 1; break;
    case 'c':
      if ((e.ctrlKey || e.metaKey) && selected) {
        post({ type: 'command', command: 'gitRepository.copySha', args: [{ hash: selected }] });
        e.preventDefault();
      }
      return;
    default:
      return;
  }
  e.preventDefault();
  if (next >= 0) select((commits[next].it as { commit: CommitRow }).commit.hash, true);
});

function fileRow(d: CommitDetails, f: CommitFile): string {
  const slash = f.path.lastIndexOf('/');
  const name = slash >= 0 ? f.path.slice(slash + 1) : f.path;
  const dir = slash >= 0 ? f.path.slice(0, slash) : '';
  const context = ctx({ webviewSection: 'file', hash: d.hash, parentHash: d.parents[0] ?? '', filePath: f.path, fileOldPath: f.oldPath ?? '', fileStatus: f.status });
  const statusTitle: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged' };
  return `<div class="file status-${f.status}" data-file="${esc(JSON.stringify(f))}" data-vscode-context="${context}" title="${esc(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path)}" tabindex="0">
    ${icon('file')}<span class="file-name">${esc(name)}</span><span class="file-dir">${esc(f.oldPath ? `${f.oldPath} →` : dir)}</span>
    <span class="file-status" title="${statusTitle[f.status] ?? f.status}">${esc(f.status)}</span></div>`;
}

function renderDetails() {
  if (!ui.showDetails) return;
  if (!selected) {
    detailsEl.innerHTML = `<div class="placeholder">Select a commit to see its details.</div>`;
    return;
  }
  if (!details) {
    detailsEl.innerHTML = `<div class="placeholder">${detailsLoading ? 'Loading commit details…' : 'Commit details are unavailable.'}</div>`;
    return;
  }
  const d = details;
  const committerDiffers = d.committer !== d.author || d.committerEmail !== d.authorEmail;
  const parents = d.parents.map(p => `<a class="link sha" data-select="${p}" title="${p}">${short(p)}</a>`).join(', ') || '<span class="dim">none (root commit)</span>';
  detailsEl.innerHTML = `
    <div class="details-header">
      <div class="details-subject">${esc(d.subject)}</div>
      <div class="details-actions">
        <button class="action" data-command="gitRepository.createBranchFrom" title="New Branch from Commit...">${icon('git-branch-create')}</button>
        <button class="action" data-command="gitRepository.createTag" title="New Tag...">${icon('tag')}</button>
        <button class="action" data-command="gitRepository.cherryPick" title="Cherry-Pick">${icon('git-commit')}</button>
        <button class="action" data-command="gitRepository.revert" title="Revert">${icon('discard')}</button>
        <button class="action" data-command="gitRepository.copySha" title="Copy Commit ID">${icon('copy')}</button>
      </div>
    </div>
    <div class="details-meta">
      <div>${icon('account')} <b>${esc(d.author)}</b> <span class="dim">&lt;${esc(d.authorEmail)}&gt;</span> <span class="dim">· ${esc(formatDate(d.date))}</span></div>
      ${committerDiffers ? `<div class="dim">${icon('person')} Committed by ${esc(d.committer)} &lt;${esc(d.committerEmail)}&gt; · ${esc(formatDate(d.committerDate))}</div>` : ''}
      <div>${icon('git-commit')} <span class="sha" title="${d.hash}">${d.hash}</span>
        <span class="dim">· Parents:</span> ${parents}</div>
      ${d.refs.length ? `<div class="details-refs">${mergeBadges(d.refs).map(badgeHtml).join('')}</div>` : ''}
    </div>
    ${d.body ? `<pre class="details-body">${esc(d.body)}</pre>` : ''}
    <div class="files-header">Changes <span class="count-badge">${d.files.length}</span></div>
    <div class="files">${d.files.map(f => fileRow(d, f)).join('') || '<div class="placeholder">No file changes.</div>'}</div>`;
}

detailsEl.addEventListener('click', e => {
  const target = e.target as HTMLElement;
  const button = target.closest<HTMLElement>('button[data-command]');
  if (button && details) {
    post({ type: 'command', command: button.dataset.command!, args: [{ webviewSection: 'commit', hash: details.hash, isHead: details.hash === state?.headHash }] });
    return;
  }
  const parent = target.closest<HTMLElement>('[data-select]');
  if (parent) {
    const hash = parent.dataset.select!;
    if (commitIndex(hash) >= 0) select(hash, true);
    else {
      selected = undefined;
      select(hash);
    }
    return;
  }
  const file = target.closest<HTMLElement>('.file');
  if (file && details) post({ type: 'openFile', hash: details.hash, file: JSON.parse(file.dataset.file!) });
});

detailsEl.addEventListener('keydown', e => {
  const file = (e.target as HTMLElement).closest<HTMLElement>('.file');
  if (!file || !details) return;
  if (e.key === 'Enter') post({ type: 'openFile', hash: details.hash, file: JSON.parse(file.dataset.file!) });
  if (e.key === 'ArrowDown') (file.nextElementSibling as HTMLElement | null)?.focus();
  if (e.key === 'ArrowUp') (file.previousElementSibling as HTMLElement | null)?.focus();
});

// ------------------------------------------------------------------ messages

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const m = event.data;
  switch (m.type) {
    case 'state':
      state = m.state;
      errorText = '';
      renderError();
      renderState();
      break;
    case 'history': {
      data = m.data;
      loadingMore = false;
      buildItems();
      if (!m.preserveSelection) {
        viewport.scrollTop = 0;
      }
      if (selected && commitIndex(selected) < 0 && !m.preserveSelection) {
        selected = undefined;
        details = undefined;
      } else if (selected && m.preserveSelection) {
        // Refs or content of the selected commit (e.g. after amend) may have changed.
        post({ type: 'selectCommit', hash: selected });
      }
      applyLayout();
      renderDetails();
      renderEmpty();
      break;
    }
    case 'more':
      if (data) {
        data.commits.push(...m.commits);
        data.hasMore = m.hasMore;
      }
      loadingMore = false;
      buildItems();
      applyLayout();
      break;
    case 'details':
      if (m.hash === selected) {
        details = m.details;
        detailsLoading = false;
        renderDetails();
      }
      break;
    case 'select':
      select(m.hash, true);
      break;
    case 'loading':
      app.classList.toggle('loading', m.value);
      break;
    case 'error':
      errorText = m.message;
      renderError();
      break;
  }
});

applyLayout();
renderDetails();
post({ type: 'ready' });
