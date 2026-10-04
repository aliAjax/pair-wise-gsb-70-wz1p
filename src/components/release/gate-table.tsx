import { RotateCcw, SendHorizonal } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { formatDateTime } from '../../lib/utils';
import {
  type GateRow,
  type ReleaseWindow,
} from '../../models/release';
import { GateStateBadge, GateStateIcon, RevisionPill } from './gate-state';

function toneClass(state: string): string {
  switch (state) {
    case 'released':
      return 'text-emerald-600';
    case 'pending':
      return 'text-amber-600';
    case 'verifying':
      return 'text-red-600';
    default:
      return 'text-slate-500';
  }
}

interface GateTableProps {
  window: ReleaseWindow;
  rows: GateRow[];
  submitting: boolean;
  onSubmit: (input: {
    gate: GateRow;
    receiptId: string;
    revision: number | null;
    clientVersion: string;
  }) => void;
  onReset: (gateId: string) => void;
  resetting: boolean;
  compact?: boolean;
}

const HISTORY_LABELS = {
  created: '开窗冻结',
  released: '放行',
  voided: '作废重算',
  verifying: '进入待核',
  conflict: '竞争落败',
  reset: '重新核算',
  window_closed: '窗口终止',
} as const;

export function GateTable({
  window,
  rows,
  submitting,
  onSubmit,
  onReset,
  resetting,
  compact = false,
}: GateTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] text-left text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500">
          <tr>
            {!compact && <th className="px-3 py-3 font-medium">契约 / 调用方</th>}
            {compact && <th className="px-3 py-3 font-medium">调用方</th>}
            <th className="px-3 py-3 font-medium">冻结客户端</th>
            <th className="px-3 py-3 font-medium">差异范围</th>
            <th className="px-3 py-3 font-medium">门状态</th>
            <th className="px-3 py-3 font-medium">验收回执 / 操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <GateRowView
              key={row.gate.id}
              window={window}
              row={row}
              submitting={submitting}
              onSubmit={onSubmit}
              onReset={onReset}
              resetting={resetting}
              compact={compact}
            />
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={5} className="px-3 py-12 text-center text-sm text-slate-500">
                该范围内没有调用方放行门。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function GateRowView({
  window,
  row,
  submitting,
  onSubmit,
  onReset,
  resetting,
  compact,
}: {
  window: ReleaseWindow;
  row: GateRow;
  submitting: boolean;
  onSubmit: GateTableProps['onSubmit'];
  onReset: GateTableProps['onReset'];
  resetting: boolean;
  compact: boolean;
}) {
  const { gate, scope, scopeChanged } = row;
  const [open, setOpen] = useState(false);
  const attempts = window.attempts.filter((attempt) => attempt.gateId === gate.id);

  return (
    <>
      <tr className="border-t border-slate-100 align-top">
        <td className="px-3 py-3">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="text-left"
          >
            <div className="font-medium text-slate-900 hover:text-sky-800">
              {gate.consumerName}
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              {!compact && `${gate.contractName} · `}
              {gate.consumerOwner} · {gate.environment}
            </div>
          </button>
        </td>
        <td className="px-3 py-3 font-mono text-xs text-slate-700">
          {gate.clientVersionAtFreeze}
        </td>
        <td className="px-3 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={scopeChanged ? 'amber' : 'green'}>
              {scope.contractVersion} · {scope.currentSignature.slice(0, 6)}
            </Badge>
            {scopeChanged && <Badge tone="amber">差异已变（修订 {window.revision}）</Badge>}
          </div>
          <p className="mt-1 max-w-[220px] text-[11px] leading-4 text-slate-500">
            当前：{scope.currentSummary}
          </p>
        </td>
        <td className="px-3 py-3">
          <div className="flex items-center gap-1.5">
            <GateStateIcon
              state={gate.state}
              className={`h-4 w-4 ${toneClass(gate.state)}`}
            />
            <GateStateBadge state={gate.state} />
          </div>
          <p className="mt-1 max-w-[220px] text-[11px] leading-4 text-slate-500">
            {gate.note}
          </p>
        </td>
        <td className="px-3 py-3">
          {gate.state === 'released' && gate.basis && (
            <div className="space-y-1 text-[11px] text-slate-600">
              <div className="font-mono">{gate.basis.receiptId}</div>
              <div>
                放行于 {formatDateTime(gate.basis.releasedAt)} · 客户端{' '}
                {gate.basis.clientVersion}
              </div>
              <RevisionPill revision={gate.basis.revision} current={window.revision} />
              <div className="text-slate-400">
                依据差异 {gate.basis.diffSignature.slice(0, 6)} 已固定，不受后续作废影响
              </div>
            </div>
          )}

          {gate.state === 'verifying' && gate.pendingReceipt && (
            <div className="space-y-1 text-[11px] text-slate-600">
              <div className="font-mono">{gate.pendingReceipt.receiptId}</div>
              <div>客户端 {gate.pendingReceipt.clientVersion}</div>
              <RevisionPill
                revision={gate.pendingReceipt.windowRevision}
                current={window.revision}
              />
              <div className="text-slate-500">
                先待核，不阻塞同批其他调用方；核对后可带正确修订号重新提交。
              </div>
            </div>
          )}

          {(gate.state === 'pending' || gate.state === 'verifying') &&
            window.status === 'open' && (
              <ReceiptForm
                key={`${gate.id}-${gate.state}`}
                defaultRevision={window.revision}
                defaultClient={
                  gate.pendingReceipt?.clientVersion ?? gate.clientVersionAtFreeze
                }
                disabled={submitting}
                onSubmit={(receiptId, revision, clientVersion) =>
                  onSubmit({ gate: row, receiptId, revision, clientVersion })
                }
              />
            )}

          {gate.state === 'voided' && window.status === 'open' && (
            <div className="space-y-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={resetting}
                onClick={() => onReset(gate.id)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                按修订 {window.revision} 重算
              </Button>
              <p className="text-[11px] text-slate-500">
                重算回到待回执，再提交携带当前修订号的回执即可放行。
              </p>
            </div>
          )}

          {gate.state === 'conflict' && (
            <p className="text-[11px] text-slate-500">
              另一窗口已先行放行同一调用方，本门保持未放行。
            </p>
          )}
        </td>
      </tr>
      {open && (
        <tr className="bg-slate-50/70">
          <td colSpan={5} className="px-4 py-3">
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  核算轨迹
                </div>
                <ol className="mt-2 space-y-2">
                  {gate.history.map((event, index) => (
                    <li key={index} className="flex gap-2 text-[11px] text-slate-600">
                      <Badge tone="slate">修订 {event.revision}</Badge>
                      <span>
                        {HISTORY_LABELS[event.type]} · {formatDateTime(event.at)}
                        <span className="mt-0.5 block text-slate-500">
                          {event.detail}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  回执受理记录（{attempts.length}）
                </div>
                {attempts.length ? (
                  <ul className="mt-2 space-y-2">
                    {attempts.map((attempt) => (
                      <li key={attempt.id} className="text-[11px] text-slate-600">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono">{attempt.receiptId}</span>
                          <RevisionPill
                            revision={attempt.windowRevision}
                            current={window.revision}
                          />
                        </div>
                        <div className="mt-0.5 text-slate-500">
                          {outcomeLabel(attempt.outcome)} ·{' '}
                          {formatDateTime(attempt.at)} · {attempt.clientVersion}
                        </div>
                        <div className="text-slate-500">{attempt.detail}</div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[11px] text-slate-500">尚无回执记录。</p>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function outcomeLabel(outcome: string): string {
  const map: Record<string, string> = {
    accepted: '已放行',
    duplicate: '重复回执只算一次',
    revision_mismatch: '修订号不符·待核',
    legacy_pending: '旧回执缺修订号·待核',
    conflict_lost: '竞争落败',
    already_released: '已放行（幂等）',
    invalid_state: '状态拦截',
  };
  return map[outcome] ?? outcome;
}

function ReceiptForm({
  defaultRevision,
  defaultClient,
  disabled,
  onSubmit,
}: {
  defaultRevision: number;
  defaultClient: string;
  disabled: boolean;
  onSubmit: (receiptId: string, revision: number | null, clientVersion: string) => void;
}) {
  const [receiptId, setReceiptId] = useState('');
  const [revisionMode, setRevisionMode] = useState('current');
  const [revisionText, setRevisionText] = useState(String(defaultRevision));
  const [clientVersion, setClientVersion] = useState(defaultClient);
  const [error, setError] = useState('');

  function submit() {
    const id = receiptId.trim();
    if (!id) {
      setError('填写回执号');
      return;
    }
    let revision: number | null;
    if (revisionMode === 'legacy') {
      revision = null;
    } else if (revisionMode === 'mismatch') {
      revision = Number(revisionText);
    } else {
      revision = defaultRevision;
    }
    if (revisionMode === 'mismatch' && Number.isNaN(revision)) {
      setError('修订号需为数字');
      return;
    }
    setError('');
    onSubmit(id, revision, clientVersion.trim() || defaultClient);
    setReceiptId('');
  }

  return (
    <div className="space-y-1.5">
      <Input
        className="h-8 text-xs"
        placeholder="验收回执号，如 RC-20261003-0101"
        value={receiptId}
        onChange={(event) => setReceiptId(event.target.value)}
      />
      <div className="flex gap-1.5">
        <Input
          className="h-8 text-xs"
          placeholder="客户端版本"
          value={clientVersion}
          onChange={(event) => setClientVersion(event.target.value)}
        />
        <Select value={revisionMode} onValueChange={setRevisionMode}>
          <SelectTrigger className="h-8 w-[132px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="current">携带当前修订</SelectItem>
            <SelectItem value="mismatch">修订号不符</SelectItem>
            <SelectItem value="legacy">旧回执无修订号</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {revisionMode === 'mismatch' && (
        <Input
          className="h-8 text-xs"
          type="number"
          value={revisionText}
          onChange={(event) => setRevisionText(event.target.value)}
          placeholder="回执声称的修订号"
        />
      )}
      {error && <p className="text-[11px] text-red-600">{error}</p>}
      <Button size="sm" className="w-full" disabled={disabled} onClick={submit}>
        <SendHorizonal className="h-3.5 w-3.5" />
        回传验收回执
      </Button>
    </div>
  );
}
