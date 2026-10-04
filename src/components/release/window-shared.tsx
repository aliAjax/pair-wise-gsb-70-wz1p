import type { ReactNode } from 'react';
import { Badge } from '../ui/badge';
import { Progress } from '../ui/progress';
import { formatDateTime } from '../../lib/utils';
import {
  PARTICIPANT_STATE_LABELS,
  windowSummary,
  type ParticipantState,
  type ReleaseWindow,
} from '../../models/release-window';

export function ParticipantStateBadge({ state }: { state: ParticipantState }) {
  const tone: 'amber' | 'green' | 'blue' | 'red' =
    state === 'pending'
      ? 'amber'
      : state === 'cleared'
        ? 'green'
        : state === 'verifying'
          ? 'blue'
          : 'red';
  return <Badge tone={tone}>{PARTICIPANT_STATE_LABELS[state]}</Badge>;
}

export function WindowHeader({
  window,
  extra,
}: {
  window: ReleaseWindow;
  extra?: ReactNode;
}) {
  const summary = windowSummary(window);
  return (
    <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm text-slate-950">{window.name}</strong>
          <Badge tone="slate">r{window.revision}</Badge>
          <Badge tone={window.status === 'open' ? 'amber' : 'neutral'}>
            {window.status === 'open' ? '开窗中' : '已关闭'}
          </Badge>
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          窗口 {formatDateTime(window.opensAt)} ~ {formatDateTime(window.closesAt)} · 放行{' '}
          {summary.cleared}/{summary.total}
          {summary.verifying > 0 && ` · ${summary.verifying} 待核`}
          {summary.voided > 0 && ` · ${summary.voided} 作废重算`}
          {summary.pending > 0 && ` · ${summary.pending} 待回执`}
        </p>
        <Progress className="mt-2 h-1.5 w-64" value={summary.progress} />
      </div>
      {extra ? <div className="flex shrink-0 items-center gap-2">{extra}</div> : null}
    </div>
  );
}

export function FrozenScopeList({ window }: { window: ReleaseWindow }) {
  return (
    <div className="space-y-2 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        开窗冻结的契约与差异范围
      </p>
      {window.frozenContracts.map((scope) => (
        <div
          key={scope.contractId}
          className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
        >
          <span className="text-xs font-medium text-slate-800">{scope.contractName}</span>
          <Badge tone="slate">v{scope.version}</Badge>
          <Badge tone="neutral">{scope.changeIds.length} 项差异</Badge>
          <span className="ml-auto font-mono text-[10px] text-slate-400">
            冻结签名 {scope.scopeSignature}
          </span>
        </div>
      ))}
    </div>
  );
}
