import { Link } from '@tanstack/react-router';
import {
  CalendarClock,
  GitCompare,
  PackageCheck,
  RotateCcw,
  Snowflake,
  TriangleAlert,
  ZapOff,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { WindowPanel } from '../components/release/window-panel';
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
import {
  useContracts,
  useFreezeVersion,
} from '../services/contract-queries';
import {
  useOpenWindow,
  useRecoverWindows,
  useSetFailNextSave,
  useWindows,
} from '../services/window-queries';
import { validateForRelease } from '../models/contract';

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function ReleasesPage() {
  const contracts = useContracts();
  const windows = useWindows();
  const openWindow = useOpenWindow();
  const recoverWindows = useRecoverWindows();
  const setFailNextSave = useSetFailNextSave();
  const freezeVersion = useFreezeVersion();

  const [name, setName] = useState('');
  const [opensAt, setOpensAt] = useState(() => toLocalInput(new Date().toISOString()));
  const [closesAt, setClosesAt] = useState(() =>
    toLocalInput(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()),
  );
  const [contractSelection, setContractSelection] = useState<Record<string, boolean>>({});
  const [changeSelection, setChangeSelection] = useState<Record<string, boolean>>({});
  const [consumerSelection, setConsumerSelection] = useState<Record<string, boolean>>({});
  const [freezeContractId, setFreezeContractId] = useState('');
  const [freezeVersionInput, setFreezeVersionInput] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const contractList = contracts.data ?? [];
  const windowState = windows.data;
  const pendingJournal = windowState?.journal.length ?? 0;
  const failNextSave = windowState?.failNextSave ?? false;

  const selectedContractIds = useMemo(
    () => Object.keys(contractSelection).filter((id) => contractSelection[id]),
    [contractSelection],
  );
  const selectedConsumerIds = useMemo(
    () => Object.keys(consumerSelection).filter((id) => consumerSelection[id]),
    [consumerSelection],
  );

  function toggleContract(contractId: string, checked: boolean) {
    setContractSelection((prev) => ({ ...prev, [contractId]: checked }));
    const contract = contractList.find((item) => item.id === contractId);
    if (!contract) return;
    setChangeSelection((prev) => {
      const next = { ...prev };
      for (const change of contract.changes) next[change.id] = checked;
      return next;
    });
    setConsumerSelection((prev) => {
      const next = { ...prev };
      for (const consumer of contract.consumers) next[consumer.id] = checked;
      return next;
    });
  }

  async function submitOpen() {
    setFeedback(null);
    if (!name.trim()) {
      setFeedback({ tone: 'err', text: '请填写窗口名称。' });
      return;
    }
    if (!selectedContractIds.length) {
      setFeedback({ tone: 'err', text: '至少选择一份参与契约。' });
      return;
    }
    const contractPayloads = selectedContractIds.map((contractId) => {
      const contract = contractList.find((item) => item.id === contractId)!;
      const changeIds = contract.changes
        .map((change) => change.id)
        .filter((id) => changeSelection[id]);
      return { contractId, changeIds };
    });
    if (contractPayloads.some((item) => item.changeIds.length === 0)) {
      setFeedback({ tone: 'err', text: '每份参与契约至少勾选一项差异范围。' });
      return;
    }
    if (!selectedConsumerIds.length) {
      setFeedback({ tone: 'err', text: '至少选择一个参与放行的调用方。' });
      return;
    }
    try {
      await openWindow.mutateAsync({
        name: name.trim(),
        opensAt: new Date(opensAt).toISOString(),
        closesAt: new Date(closesAt).toISOString(),
        contracts: contractPayloads,
        participantIds: selectedConsumerIds,
      });
      setName('');
      setContractSelection({});
      setChangeSelection({});
      setConsumerSelection({});
      setFeedback({ tone: 'ok', text: '窗口已开启：契约版本与差异范围已冻结，修订号 r1。' });
    } catch (error) {
      setFeedback({
        tone: 'err',
        text: `保存失败：${error instanceof Error ? error.message : String(error)} 未完成项已进入完整窗口快照的操作日志，可执行“从快照恢复”。`,
      });
    }
  }

  async function recover() {
    const result = await recoverWindows.mutateAsync();
    setFeedback({ tone: 'ok', text: result.lastRecovery ?? '已从完整窗口快照恢复。' });
  }

  async function freeze() {
    const contract = contractList.find((item) => item.id === freezeContractId);
    if (!contract || !freezeVersionInput.trim()) return;
    await freezeVersion.mutateAsync({
      contractId: contract.id,
      version: freezeVersionInput.trim(),
      notes: `在发布窗口内冻结正式版本，参与调用方分批验收放行。`,
    });
    setFreezeVersionInput('');
    setFeedback({ tone: 'ok', text: `${contract.name} v${freezeVersionInput.trim()} 已冻结。` });
  }

  const freezeContract = contractList.find((item) => item.id === freezeContractId);
  const freezeBlockers = freezeContract
    ? validateForRelease(freezeContract).filter((issue) => issue.severity === 'blocker').length
    : 0;

  return (
    <div>
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">Release Windows</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">
          发布窗口 · 调用方分批放行
        </h1>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-600">
          开窗时冻结参与契约版本与差异范围。窗口期间某份契约的差异一改，窗口修订号递增，
          <strong className="text-slate-800">只作废依赖它且尚未放行的调用方</strong>，
          已放行的保留依据。调用方回传的验收回执必须带窗口修订号与客户端版本；
          重复回执只计一次，修订号对不上先待核，且不挡住同批其他调用方。
        </p>
      </div>

      {(pendingJournal > 0 || windowState?.lastRecovery || failNextSave) && (
        <Card className="mb-4 border-amber-300 bg-amber-50">
          <CardContent className="flex flex-col gap-3 py-4 lg:flex-row lg:items-center">
            <TriangleAlert className="h-5 w-5 shrink-0 text-amber-700" />
            <div className="text-xs leading-5 text-amber-900">
              {pendingJournal > 0 && (
                <p>
                  检测到 {pendingJournal} 条未完成操作（上次保存失败）。完整窗口快照仍在，
                  恢复重放按操作号幂等，<strong>不会生成第二份放行记录</strong>。
                </p>
              )}
              {windowState?.lastRecovery && <p>{windowState.lastRecovery}</p>}
              {failNextSave && pendingJournal === 0 && <p>已设置下一次保存强制失败（演示用）。</p>}
            </div>
            <div className="flex gap-2 lg:ml-auto">
              {pendingJournal > 0 && (
                <Button size="sm" onClick={() => void recover()}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  从完整窗口恢复未完成项
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void setFailNextSave.mutateAsync(!failNextSave)}
              >
                <ZapOff className="h-3.5 w-3.5" />
                {failNextSave ? '取消下次保存失败' : '模拟下次保存失败'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {feedback && (
        <div
          className={`mb-4 rounded-md border px-4 py-3 text-xs ${
            feedback.tone === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
        <div className="space-y-4">
          {windowState && windowState.windows.length === 0 && (
            <Card>
              <CardContent className="py-16 text-center text-sm text-slate-500">
                还没有发布窗口。在右侧开窗，冻结契约与差异范围后开始按调用方分批放行。
              </CardContent>
            </Card>
          )}
          {windowState?.windows.map((window) => (
            <WindowPanel key={window.id} window={window} contracts={contractList} />
          ))}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Snowflake className="h-4 w-4 text-sky-800" />
                正式版本冻结
              </CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                全部调用方放行后，可把窗口内契约冻结为正式版本，历史快照不覆盖。
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto]">
                <Select value={freezeContractId} onValueChange={setFreezeContractId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择窗口内契约" />
                  </SelectTrigger>
                  <SelectContent>
                    {contractList.map((contract) => (
                      <SelectItem key={contract.id} value={contract.id}>
                        {contract.name} · v{contract.version}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="font-mono"
                  value={freezeVersionInput}
                  onChange={(event) => setFreezeVersionInput(event.target.value)}
                  placeholder="2.9.0"
                />
                <Button
                  disabled={
                    !freezeContract ||
                    !freezeVersionInput.trim() ||
                    freezeBlockers > 0 ||
                    freezeVersion.isPending
                  }
                  onClick={() => void freeze()}
                >
                  <PackageCheck className="h-4 w-4" />
                  冻结版本
                </Button>
              </div>
              {freezeContract &&
                (freezeBlockers > 0 ? (
                  <p className="flex items-center gap-1.5 text-xs text-red-700">
                    <TriangleAlert className="h-3.5 w-3.5" />
                    {freezeContract.name} 仍有 {freezeBlockers} 个发布门禁阻断项，先到契约详情处理。
                  </p>
                ) : (
                  <p className="text-xs text-emerald-700">
                    {freezeContract.name} 门禁通过，可冻结 v{freezeVersionInput.trim() || '?'}。
                  </p>
                ))}
              <div className="flex flex-wrap gap-3 pt-1 text-[11px] text-slate-500">
                <Link to="/review" className="text-sky-800 hover:underline">
                  前往批量评审
                </Link>
                <Link to="/reports" className="text-sky-800 hover:underline">
                  查看放行报告
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-sky-800" />
                开启发布窗口
              </CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                开窗即冻结：勾选的契约版本、差异范围与调用方名单写入快照。
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-700">窗口名称</label>
                <Input
                  className="mt-1.5"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如 订单 2.9.0 灰度窗口"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium text-slate-700">开窗时间</label>
                  <Input
                    type="datetime-local"
                    className="mt-1.5"
                    value={opensAt}
                    onChange={(event) => setOpensAt(event.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-700">关窗时间</label>
                  <Input
                    type="datetime-local"
                    className="mt-1.5"
                    value={closesAt}
                    onChange={(event) => setClosesAt(event.target.value)}
                  />
                </div>
              </div>

              <div className="max-h-[360px] space-y-3 overflow-auto rounded-md border border-slate-200 p-3">
                {contractList.map((contract) => {
                  const active = !!contractSelection[contract.id];
                  return (
                    <div key={contract.id} className="rounded-md border border-slate-100">
                      <label className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-slate-50">
                        <Checkbox
                          checked={!!contractSelection[contract.id]}
                          onCheckedChange={(value) => toggleContract(contract.id, value === true)}
                        />
                        <span className="text-xs font-medium text-slate-800">{contract.name}</span>
                        <Badge tone="slate">v{contract.version}</Badge>
                      </label>
                      {active && (
                        <div className="space-y-2 border-t border-slate-100 px-3 py-2">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            差异范围（冻结）
                          </p>
                          {contract.changes.map((change) => (
                            <label
                              key={change.id}
                              className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-600"
                            >
                              <Checkbox
                                checked={!!changeSelection[change.id]}
                                onCheckedChange={(value) =>
                                  setChangeSelection((prev) => ({
                                    ...prev,
                                    [change.id]: value === true,
                                  }))
                                }
                              />
                              <span className="font-mono">{change.method}</span>
                              {change.path}
                            </label>
                          ))}
                          <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            分批放行调用方
                          </p>
                          {contract.consumers.map((consumer) => (
                            <label
                              key={consumer.id}
                              className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-600"
                            >
                              <Checkbox
                                checked={!!consumerSelection[consumer.id]}
                                onCheckedChange={(value) =>
                                  setConsumerSelection((prev) => ({
                                    ...prev,
                                    [consumer.id]: value === true,
                                  }))
                                }
                              />
                              {consumer.name}
                              <span className="font-mono text-slate-400">
                                {consumer.clientVersion}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <Button
                className="w-full"
                disabled={openWindow.isPending}
                onClick={() => void submitOpen()}
              >
                <GitCompare className="h-4 w-4" />
                {openWindow.isPending ? '开窗中' : '开窗并冻结范围'}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>分批放行规则</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-xs leading-5 text-slate-600">
              <Rule text="开窗冻结参与契约版本、差异范围与差异签名，修订号从 r1 起。" />
              <Rule text="冻结范围内某份契约差异一改：窗口 r+1，仅作废依赖它且未放行的调用方；已放行保留依据。" />
              <Rule text="回执带窗口修订号与客户端版本；重复回执（窗口+调用方+修订号+版本）只计一次。" />
              <Rule text="修订号缺失（旧回执）或对不上 → 先待核，不产生放行，不挡同批其他调用方。" />
              <Rule text="两个窗口同时提交同一调用方：只放先到者，后者只待核、不生成放行记录。" />
              <Rule text="保存失败后从完整窗口快照恢复未完成项；重放幂等，不生成第二份放行记录。" />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Rule({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-800" />
      <span>{text}</span>
    </div>
  );
}
