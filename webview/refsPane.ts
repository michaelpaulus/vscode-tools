import type { FromWebview, RefTreeNode } from '../src/shared/protocol';

export interface RefsPaneOptions {
  post(message: FromWebview): void;
  esc(s: string): string;
  ctx(o: object): string;
  icon(name: string, extra?: string): string;
  /** Persisted expand state, keyed by node id. */
  expanded: Record<string, boolean>;
  save(): void;
}

interface Row {
  node: RefTreeNode;
  depth: number;
  parent?: RefTreeNode;
  expanded: boolean;
  expandable: boolean;
}

/** The branches/tags/stashes/worktrees/submodules tree on the left of the Git Repository window. */
export class RefsPane {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private nodes: RefTreeNode[] = [];
  private root = '';
  private readonly lazyChildren = new Map<string, RefTreeNode[]>();
  private readonly loading = new Set<string>();
  private rows: Row[] = [];
  private selectedId?: string;
  private activeRef?: string;
  private filter = '';

  constructor(private readonly o: RefsPaneOptions) {
    const { icon } = o;
    this.element = document.createElement('div');
    this.element.className = 'refs-pane';
    this.element.innerHTML = `
      <div class="refs-header">
        <span class="refs-title">Branches</span>
        <div class="refs-actions">
          <button class="action" data-command="gitRepository.createBranch" title="New Branch...">${icon('git-branch-create')}</button>
          <button class="action" data-command="gitRepository.stashAll" title="Stash All...">${icon('git-stash')}</button>
          <button class="action" data-collapse title="Collapse All">${icon('collapse-all')}</button>
        </div>
      </div>
      <div class="refs-filter">
        <input type="text" placeholder="Filter branches" aria-label="Filter branches, tags, stashes, worktrees and submodules" spellcheck="false">
        <button class="action clear-filter hidden" title="Clear">${icon('close')}</button>
      </div>
      <div class="refs-tree" role="tree" tabindex="0" aria-label="Branches"></div>`;
    this.list = this.element.querySelector('.refs-tree')!;
    this.filterInput = this.element.querySelector('.refs-filter input')!;
    const clear = this.element.querySelector<HTMLElement>('.clear-filter')!;

    this.element.querySelector('.refs-header')!.addEventListener('click', e => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!button) return;
      if (button.dataset.command) o.post({ type: 'command', command: button.dataset.command });
      else if ('collapse' in button.dataset) this.collapseAll();
    });

    this.filterInput.addEventListener('input', () => {
      this.filter = this.filterInput.value.trim().toLowerCase();
      clear.classList.toggle('hidden', !this.filterInput.value);
      this.render();
    });
    this.filterInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.setFilter('');
      else if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        const first = this.rows.find(r => r.node.refFull) ?? this.rows[0];
        if (first) this.select(first.node.id, true);
      }
    });
    clear.addEventListener('click', () => this.setFilter(''));

    this.list.addEventListener('mousedown', e => {
      const row = this.rowOf(e.target);
      if (row) this.select(row.node.id, false);
    });
    this.list.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      const row = this.rowOf(target);
      if (!row) return;
      const button = target.closest<HTMLElement>('button[data-command]');
      if (button) {
        e.stopPropagation();
        this.run(button.dataset.command!, row.node);
        return;
      }
      if (target.closest('.twistie') || (!row.node.command && row.expandable)) this.toggle(row);
      else if (row.node.command) this.run(row.node.command, row.node);
    });
    this.list.addEventListener('dblclick', e => {
      const row = this.rowOf(e.target);
      if (!row || (e.target as HTMLElement).closest('button, .twistie')) return;
      if (row.node.dblCommand) this.run(row.node.dblCommand, row.node);
      else if (row.expandable && row.node.command) this.toggle(row);
    });
    this.list.addEventListener('keydown', e => this.onKey(e));
  }

  setTree(nodes: RefTreeNode[], root: string): void {
    if (root !== this.root) {
      this.lazyChildren.clear();
      this.selectedId = undefined;
    }
    this.nodes = nodes;
    this.root = root;
    this.render();
  }

  setChildren(id: string, nodes: RefTreeNode[]): void {
    this.lazyChildren.set(id, nodes);
    this.loading.delete(id);
    this.render();
  }

  /** Highlights the ref whose history is displayed. */
  setActiveRef(fullName: string | undefined): void {
    if (fullName === this.activeRef) return;
    this.activeRef = fullName;
    this.render();
  }

  focusFilter(select = true): void {
    this.filterInput.focus();
    if (select) this.filterInput.select();
  }

  // ---------------------------------------------------------------- rendering

  private children(node: RefTreeNode): RefTreeNode[] | undefined {
    if (node.lazy) return this.lazyChildren.get(node.id) ?? [];
    return node.children;
  }

  private isExpanded(node: RefTreeNode): boolean {
    return this.o.expanded[node.id] ?? !!node.expanded;
  }

  private matches(node: RefTreeNode): boolean {
    return !node.noFilter && `${node.label} ${node.description ?? ''} ${node.refFull ?? ''}`.toLowerCase().includes(this.filter);
  }

  /** Visible rows. While filtering, only matches and their ancestors are shown, all expanded. */
  private flatten(nodes: RefTreeNode[], depth: number, parent: RefTreeNode | undefined, out: Row[]): boolean {
    let any = false;
    for (const node of nodes) {
      const kids = this.children(node);
      const expandable = !!node.lazy || !!kids?.length;
      if (!this.filter) {
        const expanded = expandable && this.isExpanded(node);
        out.push({ node, depth, parent, expanded, expandable });
        if (expanded) {
          if (node.lazy && !this.lazyChildren.has(node.id)) out.push(this.loadingRow(node, depth + 1));
          else this.flatten(kids ?? [], depth + 1, node, out);
        }
        any = true;
        continue;
      }
      const self = this.matches(node);
      const at = out.length;
      const sub: Row[] = [];
      // A matching container shows all its children; otherwise only matching descendants.
      const childMatch = kids?.length ? (self ? this.flattenAll(kids, depth + 1, node, sub) : this.flatten(kids, depth + 1, node, sub)) : false;
      if (self || childMatch) {
        out.splice(at, 0, { node, depth, parent, expanded: sub.length > 0, expandable }, ...sub);
        any = true;
      }
    }
    return any;
  }

  private flattenAll(nodes: RefTreeNode[], depth: number, parent: RefTreeNode, out: Row[]): boolean {
    for (const node of nodes) {
      if (node.noFilter) continue;
      const kids = this.children(node);
      const sub: Row[] = [];
      if (kids?.length) this.flattenAll(kids, depth + 1, node, sub);
      out.push({ node, depth, parent, expanded: sub.length > 0, expandable: !!node.lazy || !!kids?.length }, ...sub);
    }
    return nodes.length > 0;
  }

  private loadingRow(parent: RefTreeNode, depth: number): Row {
    if (!this.loading.has(parent.id) && parent.context.stashHash) {
      this.loading.add(parent.id);
      this.o.post({ type: 'treeChildren', id: parent.id, stashHash: parent.context.stashHash });
    }
    const node: RefTreeNode = { id: `${parent.id}|loading`, label: 'Loading...', context: { webviewSection: 'tree', treeItem: 'info' }, noFilter: true };
    return { node, depth, parent, expanded: false, expandable: false };
  }

  private render(): void {
    const { esc, ctx, icon } = this.o;
    this.rows = [];
    this.flatten(this.nodes, 0, undefined, this.rows);
    if (this.selectedId && !this.rows.some(r => r.node.id === this.selectedId)) this.selectedId = undefined;
    if (this.rows.length === 0) {
      this.list.innerHTML = `<div class="refs-empty">${this.filter ? 'No matches.' : this.root ? '' : 'No repository.'}</div>`;
      return;
    }
    this.list.innerHTML = this.rows
      .map(({ node, depth, expanded, expandable }) => {
        const classes = ['tnode'];
        if (node.id === this.selectedId) classes.push('selected');
        if (node.refFull && node.refFull === this.activeRef) classes.push('active');
        if (node.emphasis) classes.push('emphasis');
        if (node.context.treeItem === 'info') classes.push('info');
        if (depth === 0) classes.push('group');
        const twistie = expandable ? icon(expanded ? 'chevron-down' : 'chevron-right', 'twistie') : '<span class="twistie"></span>';
        const actions = (node.actions ?? [])
          .map(a => `<button class="action" data-command="${esc(a.command)}" title="${esc(a.title)}" tabindex="-1">${icon(a.icon)}</button>`)
          .join('');
        return `<div class="${classes.join(' ')}" role="treeitem" data-id="${esc(node.id)}" style="padding-left:${4 + depth * 12}px"
          ${expandable ? `aria-expanded="${expanded}"` : ''} aria-level="${depth + 1}" aria-selected="${node.id === this.selectedId}"
          title="${esc(node.tooltip ?? node.label)}" data-vscode-context="${ctx(node.context)}">
          ${twistie}${node.icon ? icon(node.icon, 'ticon') : ''}<span class="tlabel">${this.highlight(node.label)}</span>${
            node.description ? `<span class="tdesc">${esc(node.description)}</span>` : ''
          }${actions ? `<span class="tactions">${actions}</span>` : ''}</div>`;
      })
      .join('');
  }

  private highlight(label: string): string {
    const { esc } = this.o;
    const i = this.filter ? label.toLowerCase().indexOf(this.filter) : -1;
    if (i < 0) return esc(label);
    return `${esc(label.slice(0, i))}<mark>${esc(label.slice(i, i + this.filter.length))}</mark>${esc(label.slice(i + this.filter.length))}`;
  }

  // ---------------------------------------------------------------- interaction

  private rowOf(target: EventTarget | null): Row | undefined {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('.tnode');
    return el ? this.rows.find(r => r.node.id === el.dataset.id) : undefined;
  }

  private run(command: string, node: RefTreeNode): void {
    if (node.context.treeItem === 'info') return;
    this.o.post({ type: 'command', command, args: [node.context] });
  }

  private toggle(row: Row, value = !row.expanded): void {
    if (!row.expandable || this.filter) return;
    this.o.expanded[row.node.id] = value;
    this.o.save();
    this.render();
  }

  private collapseAll(): void {
    const visit = (nodes: RefTreeNode[]) => {
      for (const n of nodes) {
        if (n.children?.length || n.lazy) this.o.expanded[n.id] = false;
        if (n.children) visit(n.children);
      }
    };
    visit(this.nodes);
    this.o.save();
    this.setFilter('');
  }

  private setFilter(text: string): void {
    this.filterInput.value = text;
    this.filterInput.dispatchEvent(new Event('input'));
  }

  private select(id: string, focus: boolean): void {
    this.selectedId = id;
    for (const el of this.list.querySelectorAll('.tnode.selected')) {
      el.classList.remove('selected');
      el.setAttribute('aria-selected', 'false');
    }
    const el = this.list.querySelector<HTMLElement>(`.tnode[data-id="${CSS.escape(id)}"]`);
    el?.classList.add('selected');
    el?.setAttribute('aria-selected', 'true');
    el?.scrollIntoView({ block: 'nearest' });
    if (focus) this.list.focus();
  }

  private onKey(e: KeyboardEvent): void {
    const index = this.rows.findIndex(r => r.node.id === this.selectedId);
    const row = this.rows[index];
    const move = (i: number) => {
      const r = this.rows[Math.max(0, Math.min(this.rows.length - 1, i))];
      if (r) this.select(r.node.id, true);
    };
    switch (e.key) {
      case 'ArrowDown':
        move(index + 1);
        break;
      case 'ArrowUp':
        if (index <= 0) this.focusFilter();
        else move(index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(this.rows.length - 1);
        break;
      case 'ArrowRight':
        if (!row) return;
        if (row.expandable && !row.expanded) this.toggle(row, true);
        else if (row.expanded) move(index + 1);
        break;
      case 'ArrowLeft':
        if (!row) return;
        if (row.expanded && !this.filter) this.toggle(row, false);
        else if (row.parent) this.select(row.parent.id, true);
        break;
      case 'Enter':
        if (!row) return;
        if (row.node.command) this.run(row.node.command, row.node);
        else if (row.node.dblCommand) this.run(row.node.dblCommand, row.node);
        else this.toggle(row);
        break;
      case ' ':
        if (row) this.toggle(row);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Type-to-filter, like a VS Code tree.
          this.focusFilter(false);
          return;
        }
        return;
    }
    e.preventDefault();
  }
}
