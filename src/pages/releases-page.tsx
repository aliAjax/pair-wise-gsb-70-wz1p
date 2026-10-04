import { Link } from '@tanstack/react-router';
import {
  Archive,
  CheckCircle2,
  ClipboardList,
  LockKeyhole,
  PackageCheck,
  Plus,
  TriangleAlert,
  AppWindow,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { WindowPanel } from '../components/release/window-panel';
import { formatDateTime } from '../lib/utils';
import { validateForRelease } from '../models/contract';
import {
  useArmFailNextCommit,
  useCloseWindow,
  useOpenWindow,
  useRecoverWindow,
  useResetGate,
  useSubmitReceipt,
  useWindows,
} from '../services/release-queries';
import { useContracts } from '../services/contract-queries';
import { RECEIPT_OUTCOME_LABELS } from '../models/release';

interface ReceiptFeedback {
  tone: 'success' | 'warning' | 'error';
  title: string;
  detail: string;
}

export function ReleasesPage() {
  const contracts = useContracts();
  const windowsQuery = useWindows();
  const openWindow = useOpenWindow();
  const closeWindow = useCloseWindow();
  const submitReceipt = useSubmitReceipt();
  const resetGate = useResetGate();
  const recoverWindow = useRecoverWindow();
  const armFail = useArmFailNextCommit();

  const [activeWindowId, setActiveWindowId] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [windowName, setWindowName] = useState('');
  const [pickedContracts, setPickedContracts] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<ReceiptFeedback | null>(null);

  const windows = windowsQuery.data ?? [];
  const openWindows = windows.filter((window) => window.status === 'open');
  const activeWindow =
    windows.find((window) => window.id === activeWindowId) ??
    openWindows[0] ??
    windows[0];

  const versions = useMemo(
    () =>
      (contracts.data ?? [])
        .flatMap((contract) => contract.versions.map((release) => ({ contract, release })))
        .sort(
          (left, right) =>
            new Date(right.release.releasedAt).getTime() -
            new Date(left.release.releasedAt).getTime(),
        ),
    [contracts.data],
  );

  function toggleContract(id: string) {
    setPickedContracts((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  async function createWindow() {
    if (!pickedContracts.length) return;
    const created = await openWindow.mutateAsync({
      name: windowName.trim(),
      contractIds: pickedContracts,
    });
    setActiveWindowId(created.id);
    setWindowName('');
    setPickedContracts([]);
    setShowCreate(false);
    setFeedback({
      tone: 'success',
      title: '窗口已开启',
      detail: '参与契约的差异范围与调用方清单已随开窗冻结。',
    });
  }

  return (
    <div>
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">Release Center</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">
          契约发布 · 调用方分批放行
        </h1>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-600">
          发布窗口开窗即冻结参与契约、差异范围和每个调用方的放行门；窗内差异一旦改动，只作废依赖它且未放行的调用方重算，已放行保留依据。
          回执按窗口修订号与客户端版本受理，重复只算一次、修订不符先待核，且不阻塞同批其他调用方。
        </p>
      </div>

      {feedback && (
        <div
          className={`mb-4 flex items-start gap-3 rounded-md border p-3 ${
            feedback.tone === 'success'
              ? 'border-emerald-200 bg-emerald-50'
              : feedback.tone === 'warning'
                ? 'border-amber-200 bg-amber-50'
                : 'border-red-200 bg-red-50'
          }`}
        >
          {feedback.tone === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" />
          ) : (
            <TriangleAlert className="mt-0.5 h-4 w-4 text-amber-700" />
          )}
          <div className="flex-1">
            <strong className="text-sm">{feedback.title}</strong>
            <p className="mt-0.5 text-xs leading-5 text-slate-600">{feedback.detail}</p>
          </div>
          <button
            type="button"
            className="text-xs text-slate-400 hover:text-slate-600"
            onClick={() => setFeedback(null)}
          >
            关闭
          </button>
        </div>
      )}

      <Card className="mb-4">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <AppWindow className="h-4 w-4 text-sky-800" />
              发布窗口
            </CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              两个窗口可并行存在；同一调用方的回执，只放先到者
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={activeWindow?.id ?? ''}
              onValueChange={(value) => setActiveWindowId(value)}
            >
              <SelectTrigger className="w-[240px]">
                <SelectValue placeholder="选择发布窗口" />
              </SelectTrigger>
              <SelectContent>
                {windows.map((window) => (
                  <SelectItem key={window.id} value={window.id}>
                    {window.name} · 修订 {window.revision} ·{' '}
                    {window.status === 'open' ? '开窗中' : '已关窗'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="secondary" size="sm" onClick={() => setShowCreate((v) => !v)}>
              <Plus className="h-3.5 w-3.5" />
              开新窗口
            </Button>
          </div>
        </CardHeader>

        {showCreate && (
          <CardContent className="border-t border-slate-100 pt-4">
            <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-slate-700">窗口名称</label>
                  <Input
                    className="mt-1.5"
                    value={windowName}
                    onChange={(event) => setWindowName(event.target.value)}
                    placeholder="例如 10 月第二批灰度窗口"
                  />
                </div>
                <p className="text-xs leading-5 text-slate-500">
                  开窗时会冻结所选契约当前的契约版本、差异范围（OpenAPI 与差异条目签名）和全部依赖调用方。
                  开窗后契约差异再改，未放行调用方自动作废重算。
                </p>
                <Button
                  disabled={!pickedContracts.length || openWindow.isPending}
                  onClick={() => void createWindow()}
                >
                  <LockKeyhole className="h-4 w-4" />
                  {openWindow.isPending ? '开窗中' : '开窗冻结并生成放行门'}
                </Button>
              </div>
              <div className="space-y-2">
                {(contracts.data ?? []).map((contract) => {
                  const issues = validateForRelease(contract);
                  const blockers = issues.filter((issue) => issue.severity === 'blocker').length;
                  const checked = pickedContracts.includes(contract.id);
                  return (
                    <label
                      key={contract.id}
                      className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 p-3 hover:bg-slate-50"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleContract(contract.id)}
                      />
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-sm">{contract.name}</strong>
                          <Badge tone="slate">v{contract.version}</Badge>
                          <Badge tone={blockers ? 'amber' : 'green'}>
                            {blockers ? `${blockers} 项发布阻断` : '门禁通过'}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {contract.domain} · {contract.consumers.length} 个依赖调用方 ·{' '}
                          {contract.changes.length} 项差异
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {activeWindow ? (
        <WindowPanel
          window={activeWindow}
          submitting={submitReceipt.isPending}
          resetting={resetGate.isPending}
          recovering={recoverWindow.isPending}
          onSubmit={async (input) => {
            const result = await submitReceipt.mutateAsync(input);
            const tone =
              result.outcome === 'accepted'
                ? 'success'
                : result.outcome === 'duplicate' || result.outcome === 'already_released'
                  ? 'warning'
                  : result.outcome === 'invalid_state'
                    ? 'error'
                    : 'warning';
            setFeedback({
              tone,
              title: RECEIPT_OUTCOME_LABELS[result.outcome],
              detail: result.detail,
            });
          }}
          onReset={(input) => resetGate.mutate(input)}
          onRecover={async () => {
            const result = await recoverWindow.mutateAsync(activeWindow.id);
            setFeedback({
              tone: result.skipped ? 'warning' : 'success',
              title: `恢复完成：重放 ${result.recovered} 项，跳过 ${result.skipped} 项`,
              detail: '重放走幂等提交，已放行的门未生成第二份放行记录。',
            });
          }}
          onClose={async () => {
            await closeWindow.mutateAsync(activeWindow.id);
            setFeedback({
              tone: 'success',
              title: '窗口已关闭',
              detail: '已放行依据保留；未完成的待回执/待核门随窗口终止。',
            });
          }}
          onArmFail={() => {
            armFail.mutate();
            setFeedback({
              tone: 'warning',
              title: '故障注入已准备',
              detail: '下一次回执提交会在准备记录落盘后模拟完整窗口保存失败，可验证恢复重放。',
            });
          }}
        />
      ) : (
        <Card>
          <CardContent className="py-14 text-center text-sm text-slate-500">
            尚无发布窗口，点击「开新窗口」冻结参与契约与调用方。
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-sky-800" />
            正式版本记录
          </CardTitle>
          <p className="mt-1 text-xs text-slate-500">{versions.length} 个冻结版本</p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">契约</th>
                  <th className="px-4 py-3 font-medium">版本</th>
                  <th className="px-4 py-3 font-medium">发布时间</th>
                  <th className="px-4 py-3 font-medium">校验值</th>
                  <th className="px-4 py-3 font-medium">发布说明</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {versions.map(({ contract, release }) => (
                  <tr key={release.id} className="border-t border-slate-100">
                    <td className="px-4 py-4">
                      <div className="font-medium">{contract.name}</div>
                      <div className="mt-1 text-xs text-slate-500">{contract.domain}</div>
                    </td>
                    <td className="px-4 py-4">
                      <Badge tone="slate">v{release.version}</Badge>
                    </td>
                    <td className="px-4 py-4 text-slate-600">
                      {formatDateTime(release.releasedAt)}
                    </td>
                    <td className="px-4 py-4 font-mono text-xs text-slate-600">
                      {release.checksum}
                    </td>
                    <td className="max-w-md px-4 py-4 text-slate-600">{release.notes}</td>
                    <td className="px-4 py-4 text-right">
                      <Link
                        to="/contracts/$contractId"
                        params={{ contractId: contract.id }}
                        className="text-xs font-medium text-sky-800 hover:underline"
                      >
                        查看版本
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!versions.length && (
              <p className="px-4 py-16 text-center text-sm text-slate-500">
                尚无冻结的正式版本。
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>分批放行规则</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm text-slate-600 sm:grid-cols-3">
          <Policy icon={Archive} text="开窗冻结契约版本、差异签名和调用方清单，窗内修订号单调递增。" />
          <Policy
            icon={PackageCheck}
            text="某份契约差异一改，仅该契约未放行的门作废重算；已放行门保留固定依据。"
          />
          <Policy
            icon={LockKeyhole}
            text="回执带窗口修订号与客户端版本：重复只算一次、不符先待核，且不阻塞同批他人。"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Policy({
  icon: Icon,
  text,
}: {
  icon: typeof Archive;
  text: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-slate-200 p-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-sky-800" />
      <span className="text-xs leading-5">{text}</span>
    </div>
  );
}
