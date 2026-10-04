import { Download, FileJson, FileText, ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { formatDateTime } from '../lib/utils';
import { buildChangeReport } from '../services/contract-service';
import { useContracts } from '../services/contract-queries';
import { useWindows } from '../services/release-queries';
import { gateRows, rollupWindow } from '../models/release';
import { useReviewStore } from '../store/review-store';

export function ReportsPage() {
  const contracts = useContracts();
  const windows = useWindows();
  const selectedContractId = useReviewStore((state) => state.selectedContractId);
  const setSelectedContract = useReviewStore((state) => state.setSelectedContract);
  const contract =
    (contracts.data ?? []).find((item) => item.id === selectedContractId) ??
    contracts.data?.[0];

  const windowList = windows.data ?? [];
  const report = useMemo(
    () => (contract ? buildChangeReport(contract, windowList) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contract, windows.data],
  );
  const reviewed = contract?.changes.filter((change) => change.reviewState !== 'pending') ?? [];
  const contractWindows = contract
    ? windowList.filter((window) =>
        window.scopes.some((scope) => scope.contractId === contract.id),
      )
    : [];

  return (
    <div>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">Change Report</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">
            契约变更报告
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            汇总接口差异、兼容性结论、调用方影响、迁移方案和兼容层豁免，供发布评审归档。
          </p>
        </div>
        {contract && (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                downloadText(
                  `${contract.id}-${contract.version}.json`,
                  JSON.stringify(contract, null, 2),
                  'application/json;charset=utf-8',
                )
              }
            >
              <FileJson className="h-4 w-4" />
              导出 JSON
            </Button>
            <Button
              onClick={() =>
                downloadText(
                  `${contract.id}-${contract.version}-change-report.md`,
                  report,
                  'text/markdown;charset=utf-8',
                )
              }
            >
              <Download className="h-4 w-4" />
              导出报告
            </Button>
          </div>
        )}
      </div>

      <Card className="mb-4">
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
          <span className="text-sm font-medium text-slate-700">选择契约</span>
          <Select
            value={contract?.id ?? ''}
            onValueChange={setSelectedContract}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue placeholder="选择契约" />
            </SelectTrigger>
            <SelectContent>
              {(contracts.data ?? []).map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name} · v{item.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {contract && (
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              <Badge tone="blue">{contract.domain}</Badge>
              <Badge tone="neutral">{contract.changes.length} 个变化</Badge>
              <Badge tone={reviewed.length === contract.changes.length ? 'green' : 'amber'}>
                {reviewed.length === contract.changes.length ? '评审完成' : '仍有待评审项'}
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>

      {contract ? (
        <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>报告预览</CardTitle>
                <p className="mt-1 text-xs text-slate-500">Markdown 归档格式</p>
              </div>
              <FileText className="h-5 w-5 text-slate-400" />
            </CardHeader>
            <CardContent>
              <pre className="max-h-[720px] overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-100">
                {report}
              </pre>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>豁免记录</CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  兼容层范围、原因和到期时间会进入正式报告
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {contract.exemptions.map((exemption) => (
                  <article
                    key={exemption.id}
                    className="rounded-md border border-blue-200 bg-blue-50 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-sm text-blue-950">{exemption.scope}</strong>
                      <Badge tone="blue">至 {exemption.expiresAt}</Badge>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-blue-900">{exemption.reason}</p>
                    <div className="mt-2 text-[11px] text-blue-800">
                      批准人：{exemption.approvedBy}
                    </div>
                  </article>
                ))}
                {!contract.exemptions.length && (
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                    当前没有兼容层豁免。
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>窗口放行结果</CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  与发布页、契约详情共用同一份窗口数据
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {contractWindows.length ? (
                  contractWindows.map((window) => {
                    const rollup = rollupWindow(window, contract!.id);
                    const rows = gateRows(window, contract!.id);
                    return (
                      <article
                        key={window.id}
                        className="rounded-md border border-slate-200 p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <strong className="text-sm">{window.name}</strong>
                          <div className="flex gap-1.5">
                            <Badge tone={window.status === 'open' ? 'green' : 'slate'}>
                              {window.status === 'open' ? '开窗中' : '已关窗'}
                            </Badge>
                            <Badge tone="blue">修订 {window.revision}</Badge>
                          </div>
                        </div>
                        <p className="mt-1 text-[11px] text-slate-500">
                          已放行 {rollup.released}/{rollup.total} · 待核 {rollup.verifying} ·
                          作废 {rollup.voided} · 未获放行 {rollup.conflict}
                          {rollup.uncommitted > 0 && ` · 未完成 ${rollup.uncommitted}`}
                        </p>
                        <ul className="mt-2 space-y-1">
                          {rows.map(({ gate }) => (
                            <li
                              key={gate.id}
                              className="flex items-start justify-between gap-2 text-[11px] text-slate-600"
                            >
                              <span>{gate.consumerName}</span>
                              <span className="text-right">
                                {gate.state === 'released' && gate.basis
                                  ? `已放行 · ${gate.basis.receiptId} · ${gate.basis.revisionLabel}`
                                  : gate.state === 'verifying'
                                    ? '待核'
                                    : gate.state === 'voided'
                                      ? '已作废待重算'
                                      : gate.state === 'conflict'
                                        ? '未获放行'
                                        : '待回执'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </article>
                    );
                  })
                ) : (
                  <div className="rounded-md border border-slate-200 p-3 text-sm text-slate-500">
                    该契约尚未加入发布窗口。
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>评审签名</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {contract.changes.map((change) => (
                  <div
                    key={change.id}
                    className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3 last:border-0 last:pb-0"
                  >
                    <div>
                      <div className="font-mono text-[11px] text-slate-600">
                        {change.method} {change.path}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {change.reviewer || '尚未评审'}
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge
                        tone={
                          change.reviewState === 'accepted'
                            ? 'green'
                            : change.reviewState === 'returned'
                              ? 'red'
                              : change.reviewState === 'exemption'
                                ? 'blue'
                                : 'amber'
                        }
                      >
                        {change.reviewState}
                      </Badge>
                      {change.reviewedAt && (
                        <div className="mt-1 text-[10px] text-slate-400">
                          {formatDateTime(change.reviewedAt)}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <div className="flex items-start gap-3 rounded-md border border-slate-200 bg-white p-4 text-xs leading-5 text-slate-600">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              报告在客户端生成，不依赖后端。正式版本冻结后仍可在历史版本页比较工作副本与发布快照。
            </div>
          </div>
        </div>
      ) : (
        <Card>
          <CardContent className="py-16 text-center text-sm text-slate-500">
            暂无可生成报告的契约。
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
