import { seedContracts } from '../data/seed';
import type { ApiContract } from '../models/contract';
import {
  applyCloseWindow,
  applyOpenWindow,
  applyReceipt,
  emptyWindowState,
  replayPendingJournal,
  scopeSignatureFor,
  syncWindowScopes,
  type JournalEntry,
  type OpenWindowInput,
  type ReceiptInput,
  type WindowState,
} from '../models/release-window';

const WINDOW_STORAGE_KEY = 'pair-wise-gsb-70-windows';
const CONTRACT_STORAGE_KEY = 'pair-wise-gsb-70-contracts';
const LATENCY = 180;

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function wait(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, LATENCY));
}

function readContracts(): ApiContract[] {
  const stored = localStorage.getItem(CONTRACT_STORAGE_KEY);
  if (stored) {
    try {
      return JSON.parse(stored) as ApiContract[];
    } catch {
      // 契约存储损坏时回退种子，窗口模块自身仍可工作。
    }
  }
  return seedContracts;
}

function seedWindowState(): WindowState {
  // 预置一个开窗样例：订单契约的三项差异与三个调用方，修订号 r1。
  const order = seedContracts.find((contract) => contract.id === 'contract-order');
  if (!order) return emptyWindowState();
  const opens = new Date('2026-10-04T01:00:00.000Z');
  const closes = new Date('2026-10-05T01:00:00.000Z');
  const input: OpenWindowInput = {
    opId: 'seed-open-order-window',
    name: '订单履约 2.8.0 灰度窗口',
    opensAt: opens.toISOString(),
    closesAt: closes.toISOString(),
    contracts: [
      {
        contractId: order.id,
        contractName: order.name,
        version: order.version,
        changeIds: order.changes.map((change) => change.id),
        changes: order.changes.map((change) => ({
          id: change.id,
          kind: change.kind,
          before: change.before,
          after: change.after,
        })),
      },
    ],
    participants: order.consumers.map((consumer) => ({
      consumerId: consumer.id,
      consumerName: consumer.name,
      owner: consumer.owner,
      contractId: order.id,
    })),
  };
  const state = applyOpenWindow(emptyWindowState(), input);
  // 稳定的窗口 id，避免每次重新播种都变化。
  state.windows[0].id = 'win-seed-order';
  state.windows[0].participants.forEach((participant, index) => {
    participant.id = `win-seed-order-p-${index + 1}`;
  });
  return state;
}

function rawLoad(): WindowState {
  const stored = localStorage.getItem(WINDOW_STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as WindowState;
      return { ...emptyWindowState(), ...parsed };
    } catch {
      localStorage.removeItem(WINDOW_STORAGE_KEY);
    }
  }
  const seeded = seedWindowState();
  persist(seeded, true);
  return seeded;
}

/** persist 模拟一次后端保存；failNextSave 时第二阶段落账会失败。 */
function persist(state: WindowState, force = false): void {
  if (state.failNextSave && !force) {
    throw new Error('保存失败：存储暂不可用，未完成项已留在完整窗口快照的操作日志中。');
  }
  localStorage.setItem(WINDOW_STORAGE_KEY, JSON.stringify(state));
}

/**
 * 读取窗口：先重放保存失败留下的未完成操作日志（幂等，不产生第二份放行记录），
 * 再根据当前契约差异做漂移检测（修订号递增 / 未放行参与方作废重算）。
 */
export async function listWindows(): Promise<WindowState> {
  await wait();
  let state = rawLoad();

  if (state.journal.length > 0) {
    const recovered = replayPendingJournal(state);
    recovered.failNextSave = false;
    persist(recovered, true);
    state = recovered;
  }

  const contracts = readContracts().map((contract) => ({
    contractId: contract.id,
    changes: contract.changes.map((change) => ({
      id: change.id,
      kind: change.kind,
      before: change.before,
      after: change.after,
    })),
  }));
  const synced = syncWindowScopes(state, contracts);
  if (synced !== state) {
    persist(synced, true);
    state = synced;
  }
  return clone(state);
}

function newOpId(kind: string): string {
  return `op-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 两阶段变更：
 * 1) 先把未完成操作连同一个“opId + 载荷”写进完整窗口快照的操作日志（WAL）；
 * 2) 再应用领域规则并删除日志、正式落账。
 * 第二阶段保存失败时，日志仍在持久化的完整快照里，下次 listWindows 从快照恢复重放；
 * 若正式落账其实已成功，重放会因 opId 已应用而跳过，不生成第二份放行记录。
 */
async function commit<P extends { opId: string }, T>(
  kind: JournalEntry['kind'],
  payload: P,
  apply: (state: WindowState) => { state: WindowState; result: T },
): Promise<T> {
  await wait();
  const base = rawLoad();
  if (base.appliedOps.includes(payload.opId)) {
    // 同一个操作重试/重放：直接按幂等处理，不落第二笔账。
    return apply(base).result;
  }

  const entry: JournalEntry = {
    opId: payload.opId,
    kind,
    at: new Date().toISOString(),
    payload,
  };
  // 完整窗口快照（含未完成项）先 durable；故障开关在快照落账后即复位，
  // 保证“保存失败后的恢复保存”不会再次失败。
  const wal: WindowState = {
    ...base,
    failNextSave: false,
    journal: [...base.journal, entry],
  };
  persist(wal, true);

  const applied = apply(base);
  const next: WindowState = {
    ...applied.state,
    journal: applied.state.journal.filter((item) => item.opId !== payload.opId),
  };
  persist(next); // 可能抛错（模拟保存失败）；WAL 快照保留在存储中等待恢复。
  return applied.result;
}

export interface OpenWindowRequest {
  name: string;
  opensAt: string;
  closesAt: string;
  contracts: Array<{ contractId: string; changeIds: string[] }>;
  participantIds: string[];
}

export async function openWindow(request: OpenWindowRequest): Promise<{ id: string }> {
  const contracts = readContracts();
  const selectedContracts = request.contracts
    .map((selection) => {
      const contract = contracts.find((item) => item.id === selection.contractId);
      if (!contract) return null;
      return {
        contractId: contract.id,
        contractName: contract.name,
        version: contract.version,
        changeIds: selection.changeIds,
        changes: contract.changes.map((change) => ({
          id: change.id,
          kind: change.kind,
          before: change.before,
          after: change.after,
        })),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const participantSet = new Set(request.participantIds);
  const participants = contracts.flatMap((contract) =>
    contract.consumers
      .filter((consumer) => participantSet.has(consumer.id))
      .map((consumer) => ({
        consumerId: consumer.id,
        consumerName: consumer.name,
        owner: consumer.owner,
        contractId: contract.id,
      })),
  );

  const opId = newOpId('open');
  return commit(
    'open',
    { opId },
    (state) => {
      const next = applyOpenWindow(state, {
        opId,
        name: request.name,
        opensAt: request.opensAt,
        closesAt: request.closesAt,
        contracts: selectedContracts,
        participants,
      });
      const id = next.windows[0]?.id ?? '';
      return { state: next, result: { id } };
    },
  );
}

export interface SubmitReceiptRequest {
  windowId: string;
  receipt: ReceiptInput;
}

export async function submitReceipt(
  request: SubmitReceiptRequest,
): Promise<{ outcome: string; detail: string }> {
  const opId = newOpId('rcp');
  return commit('receipt', { opId, windowId: request.windowId, receipt: request.receipt }, (state) =>
    applyReceipt(state, { opId, windowId: request.windowId, receipt: request.receipt }),
  );
}

export async function closeWindow(windowId: string): Promise<{ ok: boolean; detail: string }> {
  const opId = newOpId('close');
  return commit('close', { opId, windowId }, (state) => {
    const applied = applyCloseWindow(state, { opId, windowId });
    return { state: applied.state, result: { ok: applied.ok, detail: applied.detail } };
  });
}

/** 手动触发：从完整窗口快照恢复未完成项。 */
export async function recoverWindows(): Promise<WindowState> {
  await wait();
  const state = rawLoad();
  const recovered = replayPendingJournal(state);
  recovered.failNextSave = false;
  persist(recovered, true);
  return clone(recovered);
}

export async function setFailNextSave(fail: boolean): Promise<void> {
  await wait();
  const state = rawLoad();
  persist({ ...state, failNextSave: fail }, true);
}

/** 报告用：某份契约当前涉及哪些窗口（发布页/详情/报告共用同一份结果）。 */
export function windowsForContract(state: WindowState, contractId: string) {
  return state.windows.filter((window) =>
    window.frozenContracts.some((scope) => scope.contractId === contractId),
  );
}

export function buildWindowReportSection(
  state: WindowState,
  contractId: string | undefined,
): string {
  const windows = contractId ? windowsForContract(state, contractId) : state.windows;
  if (!windows.length) return '## 发布窗口与分批放行\n- 无开窗记录。';
  const lines = ['## 发布窗口与分批放行'];
  for (const window of windows) {
    lines.push(
      `### ${window.name}（r${window.revision}，${window.status === 'open' ? '开窗中' : '已关闭'}）`,
      `- 窗口时间：${window.opensAt} ~ ${window.closesAt}`,
      `- 冻结契约：${window.frozenContracts
        .map((scope) => `${scope.contractName}@v${scope.version}（${scope.changeIds.length} 项差异，冻结签名 ${scope.scopeSignature}）`)
        .join('；')}`,
    );
    for (const participant of window.participants) {
      const basis =
        participant.state === 'cleared'
          ? `，放行依据 r${participant.basisRevision ?? '-'} / 回执 ${participant.countedReceiptId ?? '-'}`
          : '';
      const receipts = participant.receipts.length
        ? `，回执 ${participant.receipts
            .map((receipt) => `r${receipt.windowRevision ?? '缺失'}@${receipt.clientVersion}`)
            .join('、')}`
        : '';
      lines.push(`- ${participant.consumerName}：${participant.state}${basis}${receipts}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** 工具：给报告导出复用的差异签名。 */
export function currentScopeSignature(contract: ApiContract, changeIds: string[]): string {
  return scopeSignatureFor(
    contract.changes
      .filter((change) => changeIds.includes(change.id))
      .map((change) => ({
        id: change.id,
        kind: change.kind,
        before: change.before,
        after: change.after,
      })),
  );
}
