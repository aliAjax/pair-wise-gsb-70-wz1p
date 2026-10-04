import assert from 'node:assert/strict';

// 浏览器环境垫片
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
}
(globalThis as any).localStorage = new MemoryStorage();
(globalThis as any).window = { setTimeout: (fn: () => void) => setTimeout(fn, 0) };

const service = await import('../src/services/window-service.ts');
const contractsService = await import('../src/services/contract-service.ts');

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const orderConsumers = ['consumer-app', 'consumer-cs', 'consumer-bi'];

await test('开窗：从种子契约冻结订单契约差异与 3 个调用方', async () => {
  const result = await service.openWindow({
    name: '集成测试窗口',
    opensAt: '2026-10-04T00:00:00Z',
    closesAt: '2026-10-05T00:00:00Z',
    contracts: [{ contractId: 'contract-order', changeIds: ['chg-order-1', 'chg-order-2'] }],
    participantIds: orderConsumers,
  });
  assert.ok(result.id);
  const state = await service.listWindows();
  const opened = state.windows.find((w) => w.name === '集成测试窗口')!;
  assert.equal(opened.revision, 1);
  assert.equal(opened.frozenContracts[0].changeIds.length, 2);
  assert.equal(opened.participants.length, 3);
});

await test('保存失败：故障开关打开后提交回执抛错，完整窗口快照保留未完成操作', async () => {
  await service.setFailNextSave(true);
  const state = await service.listWindows();
  const target = state.windows.find((w) => w.name === '集成测试窗口')!;
  await assert.rejects(
    () =>
      service.submitReceipt({
        windowId: target.id,
        receipt: { consumerId: 'consumer-app', windowRevision: 1, clientVersion: '4.6.2' },
      }),
    /保存失败/,
  );
  // 原始读取：journal 中有 1 条未完成操作，且尚未产生放行
  const raw = localStorage.getItem('pair-wise-gsb-70-windows')!;
  const persisted = JSON.parse(raw);
  assert.equal(persisted.journal.length, 1);
  const participant = persisted.windows
    .find((w: any) => w.name === '集成测试窗口')
    .participants.find((p: any) => p.consumerId === 'consumer-app');
  assert.equal(participant.state, 'pending');
});

await test('恢复：listWindows 自动从完整窗口重放，放行落账且无第二份记录', async () => {
  const state = await service.listWindows();
  assert.equal(state.journal.length, 0);
  const target = state.windows.find((w) => w.name === '集成测试窗口')!;
  const p = target.participants.find((x) => x.consumerId === 'consumer-app')!;
  assert.equal(p.state, 'cleared');
  assert.equal(p.basisRevision, 1);
  assert.equal(p.receipts.length, 1);
  assert.ok(state.lastRecovery?.includes('重放'));
});

await test('再次加载不重复落账（幂等恢复）', async () => {
  const state = await service.listWindows();
  assert.equal(state.journal.length, 0);
  const p = state.windows
    .find((w) => w.name === '集成测试窗口')!
    .participants.find((x) => x.consumerId === 'consumer-app')!;
  assert.equal(p.receipts.length, 1);
});

await test('改契约差异：再加载时窗口 r2，未放行调用方作废，已放行保留依据', async () => {
  const contracts = await contractsService.listContracts();
  const order = contracts.find((c) => c.id === 'contract-order')!;
  const updated = {
    ...order,
    changes: order.changes.map((c) =>
      c.id === 'chg-order-1' ? { ...c, after: '新增可选响应字段 loyaltyDiscount: number 与 campaignId: string' } : c,
    ),
  };
  await contractsService.saveContract(updated);

  const state = await service.listWindows();
  const target = state.windows.find((w) => w.name === '集成测试窗口')!;
  assert.equal(target.revision, 2);
  const app = target.participants.find((x) => x.consumerId === 'consumer-app')!;
  const cs = target.participants.find((x) => x.consumerId === 'consumer-cs')!;
  const bi = target.participants.find((x) => x.consumerId === 'consumer-bi')!;
  assert.equal(app.state, 'cleared'); // 已放行保留
  assert.equal(app.basisRevision, 1); // 依据仍是 r1
  assert.equal(cs.state, 'voided');
  assert.equal(bi.state, 'voided');
});

await test('作废重算：旧修订号 r1 回执待核，r2 回执放行', async () => {
  let state = await service.listWindows();
  const target = state.windows.find((w) => w.name === '集成测试窗口')!;
  const old = await service.submitReceipt({
    windowId: target.id,
    receipt: { consumerId: 'consumer-cs', windowRevision: 1, clientVersion: '3.9.0' },
  });
  assert.equal(old.outcome, 'verifying');
  const fresh = await service.submitReceipt({
    windowId: target.id,
    receipt: { consumerId: 'consumer-cs', windowRevision: 2, clientVersion: '3.9.1' },
  });
  assert.equal(fresh.outcome, 'accepted');
  state = await service.listWindows();
  const cs = state.windows
    .find((w) => w.name === '集成测试窗口')!
    .participants.find((x) => x.consumerId === 'consumer-cs')!;
  assert.equal(cs.state, 'cleared');
  assert.equal(cs.basisRevision, 2);
  assert.equal(cs.receipts.length, 2);
});

await test('两窗同一调用方：第二个窗口提交只待核，不生成放行记录', async () => {
  await service.openWindow({
    name: '第二个窗口',
    opensAt: '2026-10-04T00:00:00Z',
    closesAt: '2026-10-06T00:00:00Z',
    contracts: [{ contractId: 'contract-order', changeIds: ['chg-order-3'] }],
    participantIds: ['consumer-app'],
  });
  const state = await service.listWindows();
  const second = state.windows.find((w) => w.name === '第二个窗口')!;
  const result = await service.submitReceipt({
    windowId: second.id,
    receipt: { consumerId: 'consumer-app', windowRevision: 1, clientVersion: '4.6.2' },
  });
  assert.equal(result.outcome, 'conflict');
  const after = await service.listWindows();
  const p = after.windows
    .find((w) => w.name === '第二个窗口')!
    .participants.find((x) => x.consumerId === 'consumer-app')!;
  assert.equal(p.state, 'verifying');
  assert.equal(p.basisRevision, undefined);
  assert.equal(after.claims['consumer-app'], state.windows.find((w) => w.name === '集成测试窗口')!.id);
});

await test('关窗：有未放行参与方时拒绝；全部放行后成功', async () => {
  const state = await service.listWindows();
  const target = state.windows.find((w) => w.name === '集成测试窗口')!;
  const rejected = await service.closeWindow(target.id);
  assert.equal(rejected.ok, false); // bi 仍 voided
  await service.submitReceipt({
    windowId: target.id,
    receipt: { consumerId: 'consumer-bi', windowRevision: 2, clientVersion: '2.1.6' },
  });
  const closed = await service.closeWindow(target.id);
  assert.equal(closed.ok, true);
  const after = await service.listWindows();
  assert.equal(after.windows.find((w) => w.name === '集成测试窗口')!.status, 'closed');
});

await test('报告：三处共用的窗口结果段包含修订号、状态与放行依据', async () => {
  const state = await service.listWindows();
  const section = service.buildWindowReportSection(state, 'contract-order');
  assert.match(section, /集成测试窗口/);
  assert.match(section, /r2/);
  assert.match(section, /订单中心：cleared，放行依据 r1/);
  assert.match(section, /客服工作台：cleared，放行依据 r2/);
  assert.match(section, /冻结签名 [0-9a-f]{8}/); // 冻结范围与签名
});

console.log(`\n${passed} 个服务集成测试全部通过`);
