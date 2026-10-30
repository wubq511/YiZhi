import { ChevronDown, ChevronRight, Circle, CircleAlert, CircleCheck, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type Ref } from 'react';
import type { CourseGraph, ReviewSnapshot, ReviewStatus } from '../shared';
import { Button } from './components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './components/ui/dropdown-menu';

type Filter = 'all' | ReviewStatus;
const filterLabels: Record<Filter, string> = { all: '全部单元', pending: '待复习', weak: '薄弱', mastered: '已掌握' };
const filters: Filter[] = ['all', 'pending', 'weak', 'mastered'];
type DirectoryNode = CourseGraph['nodes'][number];

function DirectoryUnit({ node, selected, status, onNavigate }: {
  node: DirectoryNode; selected: boolean; status?: ReviewStatus; onNavigate(id: string): void;
}) {
  const statusId = useId();
  const StatusIcon = status === 'mastered' ? CircleCheck : status === 'weak' ? CircleAlert : Circle;
  return <Button variant="ghost" type="button" className="directory-unit" aria-label={node.name} aria-current={selected ? 'page' : undefined}
    aria-describedby={status ? statusId : undefined} onClick={() => onNavigate(node.id)}>
    <span className="directory-title">{node.name}</span>
    {status && <span id={statusId} className={`directory-status status-${status}`} title={filterLabels[status]}>
      <span className="sr-only">{filterLabels[status]}</span><StatusIcon size={status === 'pending' ? 9 : 13} aria-hidden="true"/>
    </span>}
  </Button>;
}

function DirectoryTheme({ group, nodes, counts, expanded, selectedId, review, onExpandedChange, onNavigate }: {
  group: CourseGraph['groups'][number]; nodes: DirectoryNode[]; counts?: ReviewSnapshot['themes'][string];
  expanded: boolean; selectedId?: string; review?: ReviewSnapshot;
  onExpandedChange(open: boolean): void; onNavigate(id: string): void;
}) {
  const countId = useId();
  const total = counts && counts.pending + counts.weak + counts.mastered;
  const countLabel = counts ? `已掌握 ${counts.mastered} 个，共 ${total} 个单元` : undefined;
  return <Collapsible className="directory-group" open={expanded} onOpenChange={onExpandedChange} disabled={nodes.length === 0}>
    <CollapsibleTrigger asChild>
      <Button variant="ghost" type="button" className="directory-theme-row" disabled={nodes.length === 0} aria-label={group.name} aria-describedby={counts ? countId : undefined}>
        <ChevronRight className="directory-chevron" data-icon="inline-start" aria-hidden="true"/>
        <span className="directory-title">{group.name}</span>
        {counts && <span id={countId} className="directory-count" title={countLabel}>
          <CircleCheck size={12} aria-hidden="true"/><span aria-hidden="true">{counts.mastered}/{total}</span><span className="sr-only">{countLabel}</span>
        </span>}
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="directory-units">
      {nodes.map(node => <DirectoryUnit key={node.id} node={node} selected={selectedId === node.id}
        status={review ? review.units[node.id]?.status ?? 'pending' : undefined} onNavigate={onNavigate}/>)}
    </CollapsibleContent>
  </Collapsible>;
}

export function DirectoryPanel({ navRef, open, inert, graph, review, selectedId, selectedThemeId, narrow, onClose, onNavigate }: {
  navRef: Ref<HTMLElement>; open: boolean; inert: boolean; graph?: CourseGraph; review?: ReviewSnapshot;
  selectedId?: string; selectedThemeId?: string; narrow: boolean; onClose(): void; onNavigate(id: string): void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [expandedThemes, setExpandedThemes] = useState<Set<string>>(() => new Set());
  const [collapsedMatches, setCollapsedMatches] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedThemeId) return;
    setExpandedThemes(previous => previous.has(selectedThemeId) ? previous : new Set(previous).add(selectedThemeId));
  }, [selectedId, selectedThemeId]);
  useEffect(() => { if (!open || inert) setFilterOpen(false); }, [open, inert]);

  const groups = useMemo(() => graph?.groups.map(group => {
    const nodes = graph.nodes.filter(node => node.themeId === group.id &&
      (filter === 'all' || (review && (review.units[node.id]?.status ?? 'pending') === filter)));
    return { group, nodes };
  }).filter(({ nodes }) => filter === 'all' || nodes.length > 0), [graph, review, filter]);

  const changeFilter = (next: Filter) => {
    setFilter(next);
    setCollapsedMatches(new Set());
    if (listRef.current) listRef.current.scrollTop = 0;
  };
  const navigate = (id: string) => {
    onNavigate(id);
    if (narrow) onClose();
  };
  const setExpanded = (id: string, expanded: boolean) => {
    if (filter === 'all') {
      setExpandedThemes(previous => {
        const next = new Set(previous);
        if (expanded) next.add(id); else next.delete(id);
        return next;
      });
      return;
    }
    setCollapsedMatches(previous => {
      const next = new Set(previous);
      if (expanded) next.delete(id); else next.add(id);
      return next;
    });
  };

  return <nav ref={navRef} className="directory-panel" hidden={!open} inert={!open || inert} aria-label="课程目录"
    onKeyDown={event => { if (event.key === 'Escape' && !filterOpen && !event.defaultPrevented) onClose(); }}>
    <div className="directory-header">
      <h2>课程目录</h2>
      <DropdownMenu open={filterOpen} onOpenChange={setFilterOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="directory-filter" disabled={!review} aria-label={`复习状态筛选：${filterLabels[filter]}`}>
            <span>{filterLabels[filter]}</span><ChevronDown size={14} aria-hidden="true"/>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="directory-filter-menu" align="end" sideOffset={6}>
          <DropdownMenuRadioGroup value={filter} onValueChange={value => changeFilter(value as Filter)}>
            {filters.map(value => <DropdownMenuRadioItem key={value} value={value}>{filterLabels[value]}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="icon-sm" type="button" className="panel-close" aria-label="收起目录" onClick={onClose}><X size={18}/></Button>
    </div>
    <div className="directory-list" ref={listRef}>
      {groups?.map(({ group, nodes }) => <DirectoryTheme key={group.id} group={group} nodes={nodes} counts={review?.themes[group.id]}
        expanded={filter === 'all' ? expandedThemes.has(group.id) : !collapsedMatches.has(group.id)}
        selectedId={selectedId} review={review} onExpandedChange={value => setExpanded(group.id, value)} onNavigate={navigate}/>)}
      {graph && groups?.length === 0 && filter !== 'all' && <div className="directory-empty" role="status">
        <p>没有{filterLabels[filter]}的单元</p>
        <Button variant="link" type="button" onClick={() => changeFilter('all')}>查看全部单元</Button>
      </div>}
    </div>
  </nav>;
}
