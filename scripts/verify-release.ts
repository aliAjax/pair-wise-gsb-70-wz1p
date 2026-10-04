// 端到端规则验证：在 Node 中模拟 localStorage / sessionStorage，直接跑发布服务逻辑。
// 转译运行：tsc 输出到 /tmp/verify-out 后 node scripts/verify-release.js
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

Object.assign(globalThis, {
  localStorage: new MemoryStorage(),
  sessionStorage: new MemoryStorage(),
});
(globalThis as Record<string, unknown>).window = globalThis;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const service = require('../src/services/release-service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const releaseModel = require('../src/models/release');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const contractService = require('../src/services/contract-service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const seedModule = require('../src/data/seed');

async function main(): Promise<void> {
let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${name} ${detail}`);
  }
}
const contracts = await contractService.listContracts();
const order = contracts.find((c) => c.id === 'contract-order')!;
const payment = contracts.find((c) => c.id === 'contract-payment')!;

/* ---------- 种子窗口 ---------- */
const windows = await service.listWindows();
const autumn = windows.find((w) => w.id === 'win-autumn-release')!;
const spring = windows.find((w) => w.id === 'win-spring-release')!;
check('种子：主窗口修订号为 2', autumn.revision === 2);
check(
  '种子：已放行订单中心保留放行依据',
  autumn.gates.find((g) => g.consumerId === 'consumer-app')?.state === 'released' &&
    autumn.gates.find((g) => g.consumerId === 'consumer-app')?.basis?.receiptId ===
      'RC-20261001-0001',
);
check(
  '种子：旧回执缺修订号 → 待核',
  autumn.gates.find((g) => g.consumerId === 'consumer-bi')?.state === 'verifying',
);
check(
  '种子：支付差异变更 → 财务对账已作废',
  autumn.gates.find((g) => g.consumerId === 'consumer-finance')?.state === 'voided',
);
check(
  '种子：修订号不符 → 支付运营台待核',
  autumn.gates.find((g) => g.consumerId === 'consumer-pay-ops')?.state === 'verifying',
);
check(
  '种子：并行窗口客服工作台竞争落败',
  spring.gates.find((g) => g.consumerId === 'consumer-cs')?.state === 'conflict',
);
check('种子：存在 1 条未完成准备记录', autumn.journal.filter((j) => !j.committed).length === 1);

/* ---------- 1) 恢复重放：幂等，不生成第二份放行记录 ---------- */
const recovery = await service.recoverWindow('win-autumn-release');
check('恢复：重放 1 条未完成项', recovery.recovered === 1, JSON.stringify(recovery));
const afterRecover = (await service.listWindows()).find((w) => w.id === autumn.id)!;
const payOps = afterRecover.gates.find((g) => g.consumerId === 'consumer-pay-ops')!;
check('恢复：支付运营台已放行', payOps.state === 'released');
check(
  '恢复：依据客户端版本为重放准备记录中的 4.1.9',
  payOps.basis?.clientVersion === '4.1.9',
);
check(
  '恢复：准备记录已标记提交',
  afterRecover.journal.every((j) => j.committed),
);
// 再次恢复应为 0，且不增加 attempt
const recovery2 = await service.recoverWindow('win-autumn-release');
check('二次恢复：无未完成项', recovery2.recovered === 0);
const afterRecover2 = (await service.listWindows()).find((w) => w.id === autumn.id)!;
check(
  '二次恢复：不生成第二份放行记录/受理记录',
  afterRecover2.attempts.length === afterRecover.attempts.length,
);

/* ---------- 2) 差异一改：只作废依赖它且未放行的调用方 ---------- */
// 用一个只出现在新窗口中的全新契约，避免种子窗口已放行门干扰竞争判断
const uniqueId = `contract-verify-${Date.now()}`;
const freshContract = {
  ...structuredClone(order),
  id: uniqueId,
  name: '联动验证 API',
  status: 'review' as const,
  consumers: order.consumers.map((consumer) => ({
    ...consumer,
    id: `${consumer.id}-verify`,
  })),
};
await contractService.saveContract(freshContract);
const win = await service.openWindow('差异联动测试窗', [uniqueId, payment.id]);
const beforeSig = releaseModel.computeContractDiff(freshContract).signature;
const mutated: typeof freshContract = {
  ...freshContract,
  changes: freshContract.changes.map((change, index) =>
    index === 0
      ? { ...change, after: `${change.after}（窗内追加校验规则 v2）` }
      : change,
  ),
};
const afterSig = releaseModel.computeContractDiff(mutated).signature;
check('测试前置：差异签名确实变化', beforeSig !== afterSig);
await contractService.saveContract(mutated);
const changed = (await service.listWindows()).find((w) => w.id === win.id)!;
check('差异联动：窗口修订号 +1', changed.revision === 2, `实际 ${changed.revision}`);
const orderGates = changed.gates.filter((g) => g.contractId === uniqueId);
const paymentGates = changed.gates.filter((g) => g.contractId === payment.id);
check(
  '差异联动：新契约的所有门作废',
  orderGates.length > 0 && orderGates.every((g) => g.state === 'voided'),
  JSON.stringify(orderGates.map((g) => g.state)),
);
check(
  '差异联动：支付契约的门不受影响',
  paymentGates.every((g) => g.state === 'pending'),
);
// 主窗口（autumn）里订单中心已放行：后续同步不影响其依据
const releasedOrderGate = afterRecover.gates.find(
  (g) => g.consumerId === 'consumer-app',
)!;
check(
  '差异联动：主窗口历史已放行门保留依据',
  releasedOrderGate.state === 'released' &&
    releasedOrderGate.basis?.receiptId === 'RC-20261001-0001',
);

/* ---------- 3) 作废 → 重算 → 正确修订回执放行 ---------- */
const voidedGate = changed.gates.find(
  (g) => g.contractId === uniqueId && g.consumerId === 'consumer-app-verify',
)!;
const voidedSubmit = await service.submitReceipt({
  windowId: win.id,
  contractId: uniqueId,
  consumerId: 'consumer-app-verify',
  receiptId: 'RC-T-1',
  windowRevision: 2,
  clientVersion: '9.9.9',
});
check('作废门直接提交被拦截', voidedSubmit.outcome === 'invalid_state');
await service.resetVoidedGate(win.id, voidedGate.id);
const resetWin = (await service.listWindows()).find((w) => w.id === win.id)!;
check('重算后门回到待回执', (() => {
  const g = resetWin.gates.find((x) => x.id === voidedGate.id)!;
  return g.state === 'pending';
})());
const accept = await service.submitReceipt({
  windowId: win.id,
  contractId: uniqueId,
  consumerId: 'consumer-app-verify',
  receiptId: 'RC-T-2',
  windowRevision: 2,
  clientVersion: '4.7.0',
});
check('正确修订回执 → 放行', accept.outcome === 'accepted', accept.detail);
const dup = await service.submitReceipt({
  windowId: win.id,
  contractId: uniqueId,
  consumerId: 'consumer-app-verify',
  receiptId: 'RC-T-2',
  windowRevision: 2,
  clientVersion: '4.7.0',
});
check('重复回执只算一次', dup.outcome === 'duplicate');
const releasedWin = (await service.listWindows()).find((w) => w.id === win.id)!;
const acceptedAttempts = releasedWin.attempts.filter(
  (a) => a.receiptId === 'RC-T-2',
);
check('重复回执未产生第二份受理/放行记录', acceptedAttempts.length === 1);
check(
  '放行依据固定修订 2 与客户端版本',
  releasedWin.gates.find((g) => g.id === voidedGate.id)?.basis?.revision === 2 &&
    releasedWin.gates.find((g) => g.id === voidedGate.id)?.basis?.clientVersion ===
      '4.7.0',
);

/* ---------- 4) 修订号不符 / 旧回执缺修订号 → 待核，且不阻塞同批 ---------- */
const mismatch = await service.submitReceipt({
  windowId: win.id,
  contractId: payment.id,
  consumerId: 'consumer-finance',
  receiptId: 'RC-T-3',
  windowRevision: 1,
  clientVersion: '5.2.0',
});
check('修订号不符 → revision_mismatch', mismatch.outcome === 'revision_mismatch');
// 新契约的门已被差异作废：cs 先重算，再以"旧回执缺修订号"提交进入待核
const csVerifyGate = changed.gates.find(
  (g) => g.consumerId === 'consumer-cs-verify',
)!;
await service.resetVoidedGate(win.id, csVerifyGate.id);
const legacy = await service.submitReceipt({
  windowId: win.id,
  contractId: uniqueId,
  consumerId: 'consumer-cs-verify',
  receiptId: 'RC-T-4',
  windowRevision: null,
  clientVersion: '3.9.2',
});
check('旧回执缺修订号 → legacy_pending', legacy.outcome === 'legacy_pending', `${legacy.outcome}: ${legacy.detail}`);
// bi 也重算后用正确修订号放行，验证待核不阻塞同批他人
const biVerifyGate = changed.gates.find((g) => g.consumerId === 'consumer-bi-verify')!;
await service.resetVoidedGate(win.id, biVerifyGate.id);
const otherAccepted = await service.submitReceipt({
  windowId: win.id,
  contractId: uniqueId,
  consumerId: 'consumer-bi-verify',
  receiptId: 'RC-T-5',
  windowRevision: 2,
  clientVersion: '2.2.0',
});
check('同批其他调用方不受待核阻塞', otherAccepted.outcome === 'accepted', otherAccepted.detail);
const finalWin = (await service.listWindows()).find((w) => w.id === win.id)!;
check(
  '待核门留存待核回执',
  finalWin.gates.find((g) => g.consumerId === 'consumer-finance')?.state ===
    'verifying' &&
    finalWin.gates.find((g) => g.consumerId === 'consumer-finance')?.pendingReceipt
      ?.receiptId === 'RC-T-3',
);
// 待核后带正确修订号重新提交 → 放行
const recheck = await service.submitReceipt({
  windowId: win.id,
  contractId: payment.id,
  consumerId: 'consumer-finance',
  receiptId: 'RC-T-6',
  windowRevision: 2,
  clientVersion: '5.2.1',
});
check('待核后带正确修订号 → 放行', recheck.outcome === 'accepted', recheck.detail);

/* ---------- 5) 两个窗口同一调用方：只放先到者 ---------- */
const win2 = await service.openWindow('竞争测试窗', [uniqueId]);
const conflict = await service.submitReceipt({
  windowId: win2.id,
  contractId: uniqueId,
  consumerId: 'consumer-app-verify', // 已在 win 放行
  receiptId: 'RC-T-7',
  windowRevision: 1,
  clientVersion: '4.7.0',
});
check('后到窗口竞争落败', conflict.outcome === 'conflict_lost');
const loserWin = (await service.listWindows()).find((w) => w.id === win2.id)!;
check(
  '落败门保持未获放行',
  loserWin.gates.find((g) => g.consumerId === 'consumer-app-verify')?.state ===
    'conflict',
);
const conflictDup = await service.submitReceipt({
  windowId: win2.id,
  contractId: uniqueId,
  consumerId: 'consumer-app-verify',
  receiptId: 'RC-T-8',
  windowRevision: 1,
  clientVersion: '4.7.0',
});
check('落败门再次提交不再受理', conflictDup.outcome === 'invalid_state');

/* ---------- 5b) 已关闭窗口不阻挡后续窗口重新验收 ---------- */
await service.closeWindow(win.id);
const winReopen = await service.openWindow('后续窗口', [uniqueId]);
const afterClosed = await service.submitReceipt({
  windowId: winReopen.id,
  contractId: uniqueId,
  consumerId: 'consumer-app-verify',
  receiptId: 'RC-T-5B',
  windowRevision: 1,
  clientVersion: '4.8.0',
});
check(
  '历史窗口已关闭后，新窗口可重新受理并放行',
  afterClosed.outcome === 'accepted',
  afterClosed.detail,
);

/* ---------- 6) 保存失败后从完整窗口恢复，重放不产生第二份记录 ---------- */
const win3 = await service.openWindow('故障恢复测试窗', [payment.id]);
service.armFailNextCommit();
const crashed = await service.submitReceipt({
  windowId: win3.id,
  contractId: payment.id,
  consumerId: 'consumer-finance',
  receiptId: 'RC-T-9',
  windowRevision: 1,
  clientVersion: '5.3.0',
});
check('保存失败返回错误且准备记录保留', crashed.outcome === 'invalid_state');
const crashedWin = (await service.listWindows()).find((w) => w.id === win3.id)!;
check(
  '失败后门仍非放行、存在未完成准备记录',
  crashedWin.gates.find((g) => g.consumerId === 'consumer-finance')?.state !==
    'released' && crashedWin.journal.filter((j) => !j.committed).length === 1,
);
const rec = await service.recoverWindow(win3.id);
check('故障恢复重放 1 项', rec.recovered === 1);
const recoveredWin = (await service.listWindows()).find((w) => w.id === win3.id)!;
check(
  '恢复后放行且依据存在',
  recoveredWin.gates.find((g) => g.consumerId === 'consumer-finance')?.state ===
    'released' &&
    recoveredWin.gates.find((g) => g.consumerId === 'consumer-finance')?.basis
      ?.receiptId === 'RC-T-9',
);
// 再次重放
await service.recoverWindow(win3.id);
const recoveredWin2 = (await service.listWindows()).find((w) => w.id === win3.id)!;
const countAccepted9 = recoveredWin2.attempts.filter(
  (a) => a.receiptId === 'RC-T-9' && a.outcome === 'accepted',
).length;
check('重放不产生第二份放行记录（accepted 仅 1 条）', countAccepted9 === 1);

/* ---------- 7) 关窗 ---------- */
await service.closeWindow(win3.id);
const closed = (await service.listWindows()).find((w) => w.id === win3.id)!;
check('关窗后状态为 closed', closed.status === 'closed');
const afterClose = await service.submitReceipt({
  windowId: win3.id,
  contractId: payment.id,
  consumerId: 'consumer-pay-ops',
  receiptId: 'RC-T-10',
  windowRevision: 1,
  clientVersion: '4.2.0',
});
check('关窗后不再受理回执', afterClose.outcome === 'invalid_state');

/* ---------- 8) 汇总一致性（rollup/gateRows 纯函数） ---------- */
// win 已在 5b 关窗：app/cs 已放行（cs 随后随关窗保留），bi 未完成被终止
const rollup = releaseModel.rollupWindow(finalWin, uniqueId);
check(
  'rollup：新契约 2 个已放行、1 个待核',
  rollup.total === 3 && rollup.released === 2 && rollup.verifying === 1,
  JSON.stringify(rollup),
);
const rows = releaseModel.gateRows(finalWin, payment.id);
check('gateRows：支付契约有 2 行', rows.length === 2);

/* ---------- 9) 报告包含窗口结果 ---------- */
const report = contractService.buildChangeReport(
  seedModule.seedContracts.find((c) => c.id === 'contract-order')!,
  [autumn],
);
check('报告包含发布窗口章节', report.includes('## 发布窗口与分批放行'));
check('报告记录放行依据', report.includes('RC-20261001-0001'));

console.log(failures === 0 ? '\n全部规则验证通过 ✅' : `\n${failures} 项失败 ❌`);
if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
