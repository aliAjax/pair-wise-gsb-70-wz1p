import { ChevronDown, History, LockKeyhole, Send } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Input } from '../ui/input';
import { formatDateTime } from '../../lib/utils';
import type { ApiContract } from '../../models/contract';
import {
  windowSummary,
  type ParticipantState,
  type ReleaseWindow,
} from '../../models/release-window';
import {
  useCloseWindow,
  useSubmitReceipt,
} from '../../services/window-queries';
import {
  FrozenScopeList,
  ParticipantStateBadge,
  WindowHeader,
} from './window-shared';

function explainState(
  state: ParticipantState,
  basisRevision: number | undefined,
  conflictWindowId: string | undefined,
): string {
  switch (state) {
    case 'pending':
      return '等待调用方回传带窗口修订号与客户端版本的验收回执。';
    case 'cleared':
      return `已按 r${basisRevision ?? '-'} 放行，放行依据保留；后续差异改动不作废此依据。`;
    case 'voided':
      return '冻结范围内差异已被修改，本参与方作废重算，请调用方按新修订号重新验收回传。';
    case 'verifying':
      return conflictWindowId
        ? `修订号核对通过，但同一调用方已被先提交的窗口 ${conflictWindowId} 放行，本窗口只待核、不生成放行记录。`
        : '回执修订号缺失或与窗口修订号不一致，先待核；不影响同批其他调用方放行。';
  }
}

export function WindowPanel({
  window,
  contracts,
  closable = true,
}: {
  window: ReleaseWindow;
  contracts: ApiContract[];
  closable?: boolean;
}) {
  const submitReceipt = useSubmitReceipt();
  const closeWindow = useCloseWindow();
  const [showLog, setShowLog] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(
    null,
  );
  const [drafts, setDrafts] = useState<Record<string, { revision: string; version: string }>>({});

  const summary = windowSummary(window);
  const contractName = (contractId: string) =>
    contracts.find((contract) => contract.id === contractId)?.name ?? contractId;

  async function submit(consumerId: string, revisionText: string, clientVersion: string) {
    const revision = revisionText.trim() === '' ? undefined : Number(revisionText);
    if (revisionText.trim() !== '' && (!Number.isInteger(revision) || revision! <= 0)) {
      setFeedback({ tone: 'err', text: '修订号必须是正整数；留空可模拟旧回执（缺修订号）。' });
      return;
    }
    if (!clientVersion.trim()) {
      setFeedback({ tone: 'err', text: '客户端版本不能为空。' });
      return;
    }
    try {
      const result = await submitReceipt.mutateAsync({
        windowId: window.id,
        receipt: { consumerId, windowRevision: revision, clientVersion: clientVersion.trim() },
      });
      setFeedback({
        tone: result.outcome === 'accepted' ? 'ok' : result.outcome === 'conflict' ? 'err' : 'warn',
        text: result.detail,
      });
    } catch (error) {
      setFeedback({
        tone: 'err',
        text: `保存失败：${error instanceof Error ? error.message : String(error)} 未完成项已写入完整窗口快照，可在发布页执行恢复。`,
      });
    }
  }

  async function close() {
    const result = await closeWindow.mutateAsync(window.id);
    setFeedback({
      tone: result.ok ? 'ok' : 'err',
      text: result.detail,
    });
  }

  return (
    <Card>
      <WindowHeader
        window={window}
        extra={
          closable && window.status === 'open' ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={!summary.allCleared || closeWindow.isPending}
              onClick={() => void close()}
            >
              <LockKeyhole className="h-3.5 w-3.5" />
              {summary.allCleared
                ? closeWindow.isPending
                  ? '关窗中'
                  : '关闭窗口'
                : `${summary.total - summary.cleared} 个未放行`}
            </Button>
          ) : undefined
        }
      />
      <FrozenScopeList window={window} />

      {feedback && (
        <div
          className={
            feedback.tone === 'ok'
              ? 'mx-4 mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900'
              : feedback.tone === 'warn'
                ? 'mx-4 mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900'
                : 'mx-4 mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900'
          }
        >
          {feedback.text}
        </div>
      )}

      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">调用方</th>
                <th className="px-4 py-2.5 font-medium">依赖契约</th>
                <th className="px-4 py-2.5 font-medium">状态 / 放行依据</th>
                <th className="px-4 py-2.5 font-medium">回传验收回执（修订号 + 客户端版本）</th>
              </tr>
            </thead>
            <tbody>
              {window.participants.map((participant) => {
                const contract = contracts.find((item) => item.id === participant.contractId);
                const consumer = contract?.consumers.find(
                  (item) => item.id === participant.consumerId,
                );
                const draft = drafts[participant.id] ?? {
                  revision: String(window.revision),
                  version: consumer?.clientVersion ?? '',
                };
                const busy =
                  submitReceipt.isPending && submitReceipt.variables?.receipt.consumerId === participant.consumerId;
                return (
                  <tr key={participant.id} className="border-t border-slate-100 align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{participant.consumerName}</div>
                      <div className="mt-0.5 text-xs text-slate-500">{participant.owner}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      {contractName(participant.contractId)}
                    </td>
                    <td className="px-4 py-3">
                      <ParticipantStateBadge state={participant.state} />
                      {participant.state === 'cleared' && (
                        <div className="mt-1 font-mono text-[10px] text-emerald-700">
                          依据 r{participant.basisRevision} · 回执 {participant.countedReceiptId}
                        </div>
                      )}
                      <p className="mt-1 max-w-60 text-[11px] leading-4 text-slate-500">
                        {explainState(
                          participant.state,
                          participant.basisRevision,
                          participant.claimConflictWindowId,
                        )}
                      </p>
                      {participant.receipts.length > 0 && (
                        <div className="mt-1.5 space-y-0.5">
                          {participant.receipts.map((receipt) => (
                            <div
                              key={receipt.id}
                              className="font-mono text-[10px] text-slate-400"
                              title={`${formatDateTime(receipt.receivedAt)} · ${receipt.id}`}
                            >
                              r{receipt.windowRevision ?? '缺失'} @ {receipt.clientVersion} ·{' '}
                              {participant.countedReceiptId === receipt.id ? '已计数' : '重复'}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Input
                          className="h-8 w-20 font-mono text-xs"
                          value={draft.revision}
                          disabled={window.status !== 'open'}
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [participant.id]: { ...draft, revision: event.target.value },
                            }))
                          }
                          placeholder="修订号"
                        />
                        <Input
                          className="h-8 w-32 font-mono text-xs"
                          value={draft.version}
                          disabled={window.status !== 'open'}
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [participant.id]: { ...draft, version: event.target.value },
                            }))
                          }
                          placeholder="客户端版本"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={window.status !== 'open' || busy}
                          onClick={() =>
                            void submit(participant.consumerId, draft.revision, draft.version)
                          }
                        >
                          <Send className="h-3.5 w-3.5" />
                          {busy ? '提交中' : '回传'}
                        </Button>
                      </div>
                      <p className="mt-1 text-[10px] text-slate-400">
                        当前窗口 r{window.revision}；修订号留空可模拟旧回执（缺修订号 → 待核）。
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="border-t border-slate-100">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            onClick={() => setShowLog((value) => !value)}
          >
            <History className="h-3.5 w-3.5 text-sky-800" />
            窗口操作流水（{window.events.length}）
            <ChevronDown
              className={`ml-auto h-3.5 w-3.5 transition-transform ${showLog ? 'rotate-180' : ''}`}
            />
          </button>
          {showLog && (
            <ul className="space-y-1 border-t border-slate-100 bg-slate-50 px-4 py-3">
              {window.events.map((event) => (
                <li key={event.id} className="text-[11px] leading-4 text-slate-600">
                  <span className="font-mono text-slate-400">{formatDateTime(event.at)}</span>
                  {'  '}
                  {event.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
