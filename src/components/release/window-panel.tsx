import {
  Bug,
  CheckCircle2,
  History,
  LockKeyhole,
  RotateCcw,
  Snowflake,
} from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Progress } from '../ui/progress';
import { formatDateTime } from '../../lib/utils';
import { gateRows, rollupWindow, type ReleaseWindow } from '../../models/release';
import { GateTable } from './gate-table';

interface WindowPanelProps {
  window: ReleaseWindow;
  contractId?: string;
  submitting: boolean;
  resetting: boolean;
  recovering: boolean;
  showControls?: boolean;
  onSubmit: (input: {
    windowId: string;
    contractId: string;
    consumerId: string;
    receiptId: string;
    windowRevision: number | null;
    clientVersion: string;
  }) => void;
  onReset: (input: { windowId: string; gateId: string }) => void;
  onRecover?: () => void;
  onClose?: () => void;
  onArmFail?: () => void;
}

export function WindowPanel({
  window,
  contractId,
  submitting,
  resetting,
  recovering,
  showControls = true,
  onSubmit,
  onReset,
  onRecover,
  onClose,
  onArmFail,
}: WindowPanelProps) {
  const rollup = rollupWindow(window, contractId);
  const rows = gateRows(window, contractId);
  const uncommitted = window.journal.filter((entry) => !entry.committed);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 border-b border-slate-100 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{window.name}</CardTitle>
            <Badge tone={window.status === 'open' ? 'green' : 'slate'}>
              {window.status === 'open' ? '开窗中' : '已关窗'}
            </Badge>
            <Badge tone="blue">窗口修订 {window.revision}</Badge>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            开窗 {formatDateTime(window.openedAt)}
            {window.closedAt ? ` · 关窗 ${formatDateTime(window.closedAt)}` : ''}
            {' · '}
            放行 {rollup.released}/{rollup.total}
          </p>
        </div>
        {showControls && window.status === 'open' && (
          <div className="flex flex-wrap gap-2">
            {onArmFail && (
              <Button variant="outline" size="sm" onClick={onArmFail} title="下一次回执提交时模拟完整窗口保存失败">
                <Bug className="h-3.5 w-3.5" />
                模拟下次保存失败
              </Button>
            )}
            {onClose && (
              <Button variant="secondary" size="sm" onClick={onClose}>
                <LockKeyhole className="h-3.5 w-3.5" />
                关闭窗口
              </Button>
            )}
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4 p-4">
        {uncommitted.length > 0 && (
          <div className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 sm:flex-row sm:items-center">
            <RotateCcw className="h-5 w-5 shrink-0 text-amber-700" />
            <div className="flex-1">
              <strong className="text-sm text-amber-900">
                检测到 {uncommitted.length} 个保存失败的未完成放行项
              </strong>
              <p className="mt-0.5 text-xs leading-5 text-amber-800">
                准备记录已随完整窗口保留，可重放恢复；重放走幂等提交，不会生成第二份放行记录。
              </p>
            </div>
            {onRecover && (
              <Button size="sm" disabled={recovering} onClick={onRecover}>
                {recovering ? '恢复重放中' : '从完整窗口恢复未完成项'}
              </Button>
            )}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Snowflake className="h-3.5 w-3.5 text-sky-800" />
              开窗冻结的参与契约与差异范围
            </div>
            <div className="space-y-2">
              {(contractId
                ? window.scopes.filter((scope) => scope.contractId === contractId)
                : window.scopes
              ).map((scope) => {
                const changed = scope.frozenSignature !== scope.currentSignature;
                return (
                  <div
                    key={scope.contractId}
                    className="rounded-md border border-slate-200 p-3 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="text-sm">{scope.contractName}</strong>
                      <Badge tone={changed ? 'amber' : 'green'}>
                        {changed ? '差异已变更' : '差异未变'}
                      </Badge>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <div className="rounded bg-slate-50 p-2">
                        <div className="font-semibold text-slate-500">开窗冻结（修订 1）</div>
                        <div className="mt-1 font-mono text-[10px]">{scope.frozenSignature}</div>
                        <p className="mt-1 leading-4 text-slate-600">{scope.frozenSummary}</p>
                      </div>
                      <div className="rounded bg-sky-50 p-2">
                        <div className="font-semibold text-sky-700">
                          当前（修订 {window.revision} · v{scope.contractVersion}）
                        </div>
                        <div className="mt-1 font-mono text-[10px]">{scope.currentSignature}</div>
                        <p className="mt-1 leading-4 text-slate-700">{scope.currentSummary}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <History className="h-3.5 w-3.5 text-sky-800" />
              窗口修订记录
            </div>
            <ol className="space-y-2">
              {window.revisions.map((revision) => (
                <li
                  key={revision.revision}
                  className="rounded-md border border-slate-200 p-2.5 text-[11px] leading-4"
                >
                  <div className="flex items-center justify-between">
                    <Badge tone={revision.revision === 1 ? 'slate' : 'amber'}>
                      修订 {revision.revision}
                    </Badge>
                    <span className="text-slate-400">{formatDateTime(revision.at)}</span>
                  </div>
                  <p className="mt-1.5 text-slate-600">{revision.reason}</p>
                  <p className="mt-1 text-slate-400">{revision.diffSummary}</p>
                </li>
              ))}
            </ol>

            <div className="mt-4 rounded-md border border-slate-200 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700">分批放行进度</span>
                <span>{rollup.progress}%</span>
              </div>
              <Progress className="mt-2" value={rollup.progress} />
              <div className="mt-3 grid grid-cols-2 gap-1.5 text-[11px] text-slate-600">
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3 text-emerald-600" /> 已放行 {rollup.released}
                </span>
                <span>待回执 {rollup.pending}</span>
                <span className="text-red-700">待核 {rollup.verifying}</span>
                <span>已作废 {rollup.voided}</span>
                <span>未获放行 {rollup.conflict}</span>
                {uncommitted.length > 0 && (
                  <span className="text-amber-700">未完成 {uncommitted.length}</span>
                )}
              </div>
            </div>
          </div>
        </div>

        <GateTable
          window={window}
          rows={rows}
          submitting={submitting}
          resetting={resetting}
          onSubmit={(input) =>
            onSubmit({
              windowId: window.id,
              contractId: input.gate.gate.contractId,
              consumerId: input.gate.gate.consumerId,
              receiptId: input.receiptId,
              windowRevision: input.revision,
              clientVersion: input.clientVersion,
            })
          }
          onReset={(gateId) => onReset({ windowId: window.id, gateId })}
          compact={Boolean(contractId)}
        />
      </CardContent>
    </Card>
  );
}
