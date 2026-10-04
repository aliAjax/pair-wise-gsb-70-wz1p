import assert from 'node:assert/strict';
import {
  applyCloseWindow,
  applyOpenWindow,
  applyReceipt,
  emptyWindowState,
  replayPendingJournal,
  scopeSignatureFor,
  syncWindowScopes,
  windowSummary,
  type WindowState,
} from '../src/models/release-window.ts';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const changesA = [
  { id: 'c1', kind: 'field_added', before: '无 x', after: '新增可选 x' },
  { id: 'c2', kind: 'field_removed', before: '有 y', after: '移除 y' },
];
const changesB = [{ id: 'c3', kind: 'enum_expanded', before: 'A|B', after: 'A|B|C' }];

const contractsLive = () => [
  { contractId: 'A', changes: structuredClone(changesA) },
  { contractId: 'B', changes: structuredClone(changesB) },
];

function openTwoWindows(): WindowState {
  let state = emptyWindowState();
  state = applyOpenWindow(state, {
    opId: 'open-1',
    name: '窗口甲',
    opensAt: '2026-10-04T00:00:00Z',
    closesAt: '2026-10-05T00:00:00Z',
    contracts: [
      {
        contractId: 'A',
        contractName: '契约A',
        version: '1.0.0',
        changeIds: ['c1', 'c2'],
        changes: changesA,
      },
    ],
    participants: [
      { consumerId: 'u1', consumerName: '调用方1', owner: '组1', contractId: 'A' },
      { consumerId: 'u2', consumerName: '调用方2', owner: '组2', contractId: 'A' },
    ],
  });
  state = applyOpenWindow(state, {
    opId: 'open-2',
    name: '窗口乙',
    opensAt: '2026-10-04T02:00:00Z',
    closesAt: '2026-10-05T02:00:00Z',
    contracts: [
      {
        contractId: 'B',
        contractName: '契约B',
        version: '2.0.0',
        changeIds: ['c3'],
        changes: changesB,
      },
    ],
    participants: [{ consumerId: 'u1', consumerName: '调用方1', owner: '组1', contractId: 'B' }],
  });
  return state;
}

const win = (state: WindowState, name: string) => state.windows.find((w) => w.name === name)!;
const part = (w: ReturnType<typeof win>, consumerId: string) =>
  w.participants.find((p) => p.consumerId === consumerId)!;

test('开窗冻结契约、差异范围与签名，修订号 r1，参与方待回执', () => {
  const state = openTwoWindows();
  const a = win(state, '窗口甲');
  assert.equal(a.revision, 1);
  assert.equal(a.frozenContracts[0].scopeSignature, scopeSignatureFor(changesA));
  assert.deepEqual(a.frozenContracts[0].changeIds, ['c1', 'c2']);
  assert.ok(a.participants.every((p) => p.state === 'pending'));
});

test('回执修订号+客户端版本匹配则放行并保留依据', () => {
  let state = openTwoWindows();
  const a = win(state, '窗口甲');
  const r = applyReceipt(state, {
    opId: 'rcp-1',
    windowId: a.id,
    receipt: { consumerId: 'u1', windowRevision: 1, clientVersion: '4.6.2' },
  });
  state = r.state;
  assert.equal(r.result.outcome, 'accepted');
  assert.equal(part(win(state, '窗口甲'), 'u1').state, 'cleared');
  assert.equal(part(win(state, '窗口甲'), 'u1').basisRevision, 1);
  assert.ok(part(win(state, '窗口甲'), 'u1').countedReceiptId);
});

test('重复回执（窗口+调用方+修订号+版本一致）只计一次，不新增放行记录', () => {
  let state = openTwoWindows();
  const a = win(state, '窗口甲');
  state = applyReceipt(state, {
    opId: 'rcp-1',
    windowId: a.id,
    receipt: { consumerId: 'u1', windowRevision: 1, clientVersion: '4.6.2' },
  }).state;
  const countedId = part(win(state, '窗口甲'), 'u1').countedReceiptId;
  const dup = applyReceipt(state, {
    opId: 'rcp-2',
    windowId: a.id,
    receipt: { consumerId: 'u1', windowRevision: 1, clientVersion: '4.6.2' },
  });
  state = dup.state;
  assert.equal(dup.result.outcome, 'duplicate');
  const p = part(win(state, '窗口甲'), 'u1');
  assert.equal(p.receipts.length, 2);
  assert.equal(p.state, 'cleared');
  assert.equal(p.countedReceiptId, countedId);
  assert.equal(p.receipts.filter((x) => p.countedReceiptId === x.id).length, 1);
});

test('修订号对不上 → 待核，不产生放行，不挡住同批其他调用方', () => {
  let state = openTwoWindows();
  const a = win(state, '窗口甲');
  const bad = applyReceipt(state, {
    opId: 'rcp-x',
    windowId: a.id,
    receipt: { consumerId: 'u1', windowRevision: 2, clientVersion: '4.6.2' },
  });
  state = bad.state;
  assert.equal(bad.result.outcome, 'verifying');
  assert.equal(part(win(state, '窗口甲'), 'u1').state, 'verifying');
  const ok = applyReceipt(state, {
    opId: 'rcp-y',
    windowId: a.id,
    receipt: { consumerId: 'u2', windowRevision: 1, clientVersion: '3.9.0' },
  });
  state = ok.state;
  assert.equal(ok.result.outcome, 'accepted');
  assert.equal(part(win(state, '窗口甲'), 'u2').state, 'cleared');
});

test('旧回执缺修订号 → 待核', () => {
  const state = openTwoWindows();
  const a = win(state, '窗口甲');
  const r = applyReceipt(state, {
    opId: 'rcp-old',
    windowId: a.id,
    receipt: { consumerId: 'u1', clientVersion: '1.0.0' },
  });
  assert.equal(r.result.outcome, 'verifying');
  assert.match(r.result.detail, /缺少修订号/);
});

test('两个窗口同时提交同一调用方，只放先到者，后者不生成放行记录', () => {
  let state = openTwoWindows();
  const a = win(state, '窗口甲');
  const b = win(state, '窗口乙');
  state = applyReceipt(state, {
    opId: 'rcp-a',
    windowId: a.id,
    receipt: { consumerId: 'u1', windowRevision: 1, clientVersion: '4.6.2' },
  }).state;
  const conflict = applyReceipt(state, {
    opId: 'rcp-b',
    windowId: b.id,
    receipt: { consumerId: 'u1', windowRevision: 1, clientVersion: '5.0.0' },
  });
  state = conflict.state;
  assert.equal(conflict.result.outcome, 'conflict');
  assert.equal(conflict.result.claimOwnerWindowId, a.id);
  const inB = part(win(state, '窗口乙'), 'u1');
  assert.equal(inB.state, 'verifying');
  assert.equal(inB.basisRevision, undefined);
  assert.equal(state.claims.u1, a.id);
});

test('差异一改：修订号+1，仅作废依赖该契约且未放行的调用方；已放行保留依据', () => {
  let state = openTwoWindows();
  const a = win(state, '窗口甲');
  state = applyReceipt(state, {
    opId: 'rcp-1',
    windowId: a.id,
    receipt: { consumerId: 'u1', windowRevision: 1, clientVersion: '4.6.2' },
  }).state;
  const live = contractsLive();
  live[0].changes[0].after = '新增可选 x 与 x2';
  state = syncWindowScopes(state, live);
  const a2 = win(state, '窗口甲');
  assert.equal(a2.revision, 2);
  assert.equal(part(a2, 'u1').state, 'cleared');
  assert.equal(part(a2, 'u1').basisRevision, 1);
  assert.equal(part(a2, 'u2').state, 'voided');
  assert.equal(win(state, '窗口乙').revision, 1);
});

test('作废后用新修订号回执可重新放行；旧修订号回执仍待核', () => {
  let state = openTwoWindows();
  const a = win(state, '窗口甲');
  state = applyReceipt(state, {
    opId: 'rcp-1',
    windowId: a.id,
    receipt: { consumerId: 'u1', windowRevision: 1, clientVersion: '4.6.2' },
  }).state;
  const live = contractsLive();
  live[0].changes[0].after = '新增可选 x 与 x2';
  state = syncWindowScopes(state, live);

  let r = applyReceipt(state, {
    opId: 'rcp-u2-old',
    windowId: a.id,
    receipt: { consumerId: 'u2', windowRevision: 1, clientVersion: '3.9.0' },
  });
  state = r.state;
  assert.equal(r.result.outcome, 'verifying');
  r = applyReceipt(state, {
    opId: 'rcp-u2-new',
    windowId: a.id,
    receipt: { consumerId: 'u2', windowRevision: 2, clientVersion: '3.9.1' },
  });
  state = r.state;
  assert.equal(r.result.outcome, 'accepted');
  assert.equal(part(win(state, '窗口甲'), 'u2').basisRevision, 2);
});

test('重复同步是稳定的：签名没变不递增、不再作废', () => {
  const state = openTwoWindows();
  const live = contractsLive();
  live[0].changes[0].after = '新增可选 x 与 x2';
  const once = syncWindowScopes(state, live);
  const twice = syncWindowScopes(once, live);
  assert.equal(twice, once);
  assert.equal(win(twice, '窗口甲').revision, 2);
});

test('保存失败后从完整窗口快照重放未完成项，不生成第二份放行记录', () => {
  const base = openTwoWindows();
  const a = win(base, '窗口甲');
  const payload = {
    opId: 'rcp-pending',
    windowId: a.id,
    receipt: { consumerId: 'u1', windowRevision: 1, clientVersion: '4.6.2' },
  };
  const crashed: WindowState = {
    ...base,
    journal: [
      { opId: payload.opId, kind: 'receipt' as const, at: '2026-10-04T03:00:00Z', payload },
    ],
  };
  const recovered = replayPendingJournal(crashed);
  assert.equal(recovered.journal.length, 0);
  assert.equal(part(win(recovered, '窗口甲'), 'u1').state, 'cleared');
  const clearedCount1 = win(recovered, '窗口甲').participants.filter(
    (p) => p.state === 'cleared',
  ).length;
  // 再次重放（恢复保存也失败的极端情况）不会产生第二份记录
  const again = replayPendingJournal({ ...recovered, journal: crashed.journal });
  const clearedCount2 = win(again, '窗口甲').participants.filter(
    (p) => p.state === 'cleared',
  ).length;
  assert.equal(clearedCount1, clearedCount2);
  assert.equal(part(win(again, '窗口甲'), 'u1').receipts.length, 1);
});

test('同一 opId 重放天然幂等（开窗/回执）', () => {
  const openInput = {
    opId: 'same',
    name: 'X',
    opensAt: 't',
    closesAt: 't',
    contracts: [],
    participants: [],
  };
  const once = applyOpenWindow(emptyWindowState(), openInput);
  const twice = applyOpenWindow(once, openInput);
  assert.equal(twice, once);

  let state = openTwoWindows();
  const a = win(state, '窗口甲');
  const input = {
    opId: 'idempotent',
    windowId: a.id,
    receipt: { consumerId: 'u1', windowRevision: 1, clientVersion: '9.9.9' },
  };
  state = applyReceipt(state, input).state;
  const replay = applyReceipt(state, input);
  assert.equal(replay.result.outcome, 'duplicate');
  assert.equal(part(win(state, '窗口甲'), 'u1').receipts.length, 1);
});

test('未全部放行不能关窗；全部放行后可关窗', () => {
  let state = openTwoWindows();
  const a = win(state, '窗口甲');
  assert.equal(applyCloseWindow(state, { opId: 'close-1', windowId: a.id }).ok, false);
  state = applyReceipt(state, {
    opId: 'r1',
    windowId: a.id,
    receipt: { consumerId: 'u1', windowRevision: 1, clientVersion: '4.6.2' },
  }).state;
  // u2 先被作废 → 仍不能关窗
  const live = contractsLive();
  live[0].changes[0].after = 'changed';
  state = syncWindowScopes(state, live);
  assert.equal(part(win(state, '窗口甲'), 'u2').state, 'voided');
  assert.equal(applyCloseWindow(state, { opId: 'close-2', windowId: a.id }).ok, false);
  // u2 按 r2 重新验收
  state = applyReceipt(state, {
    opId: 'r2',
    windowId: a.id,
    receipt: { consumerId: 'u2', windowRevision: 2, clientVersion: '3.9.1' },
  }).state;
  const closed = applyCloseWindow(state, { opId: 'close-3', windowId: a.id });
  assert.equal(closed.ok, true);
  assert.equal(win(closed.state, '窗口甲').status, 'closed');
  assert.equal(windowSummary(win(closed.state, '窗口甲')).allCleared, true);
});

test('客户端版本不同视为不同回执：r1@1.0 待核后，r2@2.0 可放行并保留两条回执留痕', () => {
  let state = openTwoWindows();
  const a = win(state, '窗口甲');
  const live = contractsLive();
  live[0].changes[0].after = 'changed';
  state = syncWindowScopes(state, live);
  const v1 = applyReceipt(state, {
    opId: 'rv1',
    windowId: a.id,
    receipt: { consumerId: 'u1', windowRevision: 1, clientVersion: '1.0' },
  });
  state = v1.state;
  assert.equal(v1.result.outcome, 'verifying');
  const v2 = applyReceipt(state, {
    opId: 'rv2',
    windowId: a.id,
    receipt: { consumerId: 'u1', windowRevision: 2, clientVersion: '2.0' },
  });
  state = v2.state;
  assert.equal(v2.result.outcome, 'accepted');
  assert.equal(part(win(state, '窗口甲'), 'u1').receipts.length, 2);
  assert.equal(part(win(state, '窗口甲'), 'u1').basisRevision, 2);
});

console.log(`\n${passed} 个行为测试全部通过`);
