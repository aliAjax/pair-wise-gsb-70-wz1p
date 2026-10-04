import { seedContracts } from '../data/seed';
import type { ApiContract } from '../models/contract';
import type {
  GateHistoryEvent,
  GateState,
  JournalEntry,
  ReceiptAttempt,
  ReceiptOutcome,
  ReleaseGate,
  ReleaseWindow,
  WindowRevision,
  WindowScope,
} from '../models/release';
import {
  RECEIPT_OUTCOME_LABELS,
  computeContractDiff,
  gateIdentity,
} from '../models/release';

const CONTRACTS_KEY = 'pair-wise-gsb-70-contracts';
const WINDOWS_KEY = 'pair-wise-gsb-70-release-windows';
const FAIL_NEXT_KEY = 'pair-wise-gsb-70-release-fail-next';
const LATENCY = 180;

async function wait(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, LATENCY));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface SubmitReceiptInput {
  windowId: string;
  contractId: string;
  consumerId: string;
  receiptId: string;
  /** 调用方回执携带的窗口修订号；旧回执没有该字段 */
  windowRevision: number | null;
  clientVersion: string;
}

export interface SubmitReceiptResult {
  outcome: ReceiptOutcome;
  detail: string;
  gateId?: string;
}

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

function readContractsSnapshot(): ApiContract[] {
  const stored = window.localStorage.getItem(CONTRACTS_KEY);
  if (stored) {
    try {
      return JSON.parse(stored) as ApiContract[];
    } catch {
      // 契约存储损坏时退回种子，发布窗口仍可从自身完整数据恢复
    }
  }
  return clone(seedContracts);
}

function readWindows(): ReleaseWindow[] {
  const stored = window.localStorage.getItem(WINDOWS_KEY);
  if (stored) {
    try {
      const windows = JSON.parse(stored) as ReleaseWindow[];
      if (Array.isArray(windows)) return windows;
    } catch {
      window.localStorage.removeItem(WINDOWS_KEY);
    }
  }
  const seeded = buildSeedWindows(readContractsSnapshot());
  persistWindows(seeded);
  return seeded;
}

function persistWindows(windows: ReleaseWindow[]): void {
  window.localStorage.setItem(WINDOWS_KEY, JSON.stringify(windows));
}

function writeWindows(next: ReleaseWindow[]): void {
  // 模拟"提交失败"：准备记录已落盘，但完整窗口写入抛错
  if (window.sessionStorage.getItem(FAIL_NEXT_KEY) === 'commit') {
    window.sessionStorage.removeItem(FAIL_NEXT_KEY);
    throw new Error('窗口结果保存失败，准备记录已保留，可从完整窗口恢复未完成项。');
  }
  persistWindows(next);
}

/** 仅追加准备记录，不走故障注入，保证重放依据一定能落盘 */
function appendJournal(entry: JournalEntry): void {
  const stored = readWindows();
  const next = stored.map((window) =>
    window.id === entry.windowId
      ? { ...window, journal: [...window.journal, entry] }
      : window,
  );
  persistWindows(next);
}

/** 演示用：让下一次完整窗口提交失败（准备阶段仍成功） */
export function armFailNextCommit(): void {
  window.sessionStorage.setItem(FAIL_NEXT_KEY, 'commit');
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export async function listWindows(): Promise<ReleaseWindow[]> {
  await wait();
  return clone(readWindows());
}

export async function getWindow(id: string): Promise<ReleaseWindow | undefined> {
  const windows = await listWindows();
  return windows.find((window) => window.id === id);
}

/* ------------------------------------------------------------------ */
/* 开窗 / 关窗                                                          */
/* ------------------------------------------------------------------ */

export async function openWindow(
  name: string,
  contractIds: string[],
): Promise<ReleaseWindow> {
  await wait();
  const contracts = readContractsSnapshot();
  const now = new Date().toISOString();
  const windowId = `win-${Date.now()}`;
  const selected = contracts.filter((contract) => contractIds.includes(contract.id));
  const scopes: WindowScope[] = selected.map((contract) => {
    const diff = computeContractDiff(contract);
    return {
      contractId: contract.id,
      contractName: contract.name,
      contractVersion: contract.version,
      frozenSignature: diff.signature,
      frozenSummary: diff.summary,
      currentSignature: diff.signature,
      currentSummary: diff.summary,
    };
  });

  const gates: ReleaseGate[] = selected.flatMap((contract) =>
    contract.consumers.map((consumer) => ({
      id: gateIdentity(windowId, contract.id, consumer.id),
      windowId,
      contractId: contract.id,
      contractName: contract.name,
      consumerId: consumer.id,
      consumerName: consumer.name,
      consumerOwner: consumer.owner,
      environment: consumer.environment,
      clientVersionAtFreeze: consumer.clientVersion,
      state: 'pending' as GateState,
      scopeRevision: 1,
      note: '开窗冻结差异，等待调用方回传验收回执。',
      history: [
        {
          at: now,
          revision: 1,
          type: 'created' as const,
          detail: `随窗口开窗冻结，客户端版本 ${consumer.clientVersion}。`,
        },
      ],
    })),
  );

  const window: ReleaseWindow = {
    id: windowId,
    name: name.trim() || `发布窗口 ${new Date(now).toLocaleString('zh-CN')}`,
    openedAt: now,
    status: 'open',
    revision: 1,
    revisions: [
      {
        revision: 1,
        at: now,
        reason: '开窗冻结参与契约与差异范围',
        diffSummary: scopes
          .map((scope) => `${scope.contractName}：${scope.frozenSummary}`)
          .join('；'),
      },
    ],
    scopes,
    gates,
    attempts: [],
    journal: [],
  };

  writeWindows([...readWindows(), window]);
  return clone(window);
}

export async function closeWindow(windowId: string): Promise<ReleaseWindow> {
  await wait();
  const windows = readWindows();
  const now = new Date().toISOString();
  const next = windows.map((window) => {
    if (window.id !== windowId) return window;
    return {
      ...window,
      status: 'closed' as const,
      closedAt: now,
      gates: window.gates.map((gate) => {
        if (gate.state === 'released' || gate.state === 'conflict') return gate;
        const terminates = gate.state === 'pending' || gate.state === 'verifying';
        return {
          ...gate,
          state: terminates ? ('voided' as GateState) : gate.state,
          note: terminates
            ? '窗口关闭，未完成验收，放行随窗口终止。'
            : gate.note,
          pendingReceipt: terminates ? undefined : gate.pendingReceipt,
          history: terminates
            ? [
                ...gate.history,
                {
                  at: now,
                  revision: window.revision,
                  type: 'window_closed' as const,
                  detail: '窗口关闭，未放行的门随窗口终止。',
                } satisfies GateHistoryEvent,
              ]
            : gate.history,
        };
      }),
    };
  });
  writeWindows(next);
  const updated = next.find((window) => window.id === windowId);
  if (!updated) throw new Error('发布窗口不存在');
  return clone(updated);
}

/* ------------------------------------------------------------------ */
/* 契约差异变化 → 只作废依赖它且未放行的调用方，已放行保留依据            */
/* ------------------------------------------------------------------ */

export async function syncContractChange(
  contractId: string,
  contract: ApiContract,
): Promise<void> {
  const diff = computeContractDiff(contract);
  const windows = readWindows();
  const now = new Date().toISOString();
  let affected = false;

  const next = windows.map((window) => {
    const scope = window.scopes.find((item) => item.contractId === contractId);
    if (!scope || window.status !== 'open') return window;
    affected = true;

    const sameSignature = scope.currentSignature === diff.signature;
    const scopes = window.scopes.map((item) =>
      item.contractId === contractId
        ? {
            ...item,
            contractVersion: contract.version,
            currentSignature: diff.signature,
            currentSummary: diff.summary,
          }
        : item,
    );
    if (sameSignature) {
      return { ...window, scopes };
    }

    const revision = window.revision + 1;
    const gates = window.gates.map((gate) => {
      if (gate.contractId !== contractId || gate.state === 'released') return gate;
      return {
        ...gate,
        state: 'voided' as GateState,
        scopeRevision: revision,
        note: '差异已变更，此前状态作废；重算后按最新修订重新受理回执。',
        pendingReceipt: undefined,
        history: [
          ...gate.history,
          {
            at: now,
            revision,
            type: 'voided' as const,
            detail: `${contract.name} 的差异在窗口内变更，旧核算作废，需重算（修订 ${window.revision} → ${revision}）。`,
          } satisfies GateHistoryEvent,
        ],
      };
    });

    const voidedCount = gates.filter(
      (gate) =>
        gate.contractId === contractId &&
        gate.history.some(
          (event) => event.type === 'voided' && event.revision === revision,
        ),
    ).length;
    const revisionEntry: WindowRevision = {
      revision,
      at: now,
      reason: `${contract.name} 差异范围变更，${voidedCount} 个未放行调用方作废重算；已放行调用方保留依据`,
      changedContractId: contractId,
      changedContractName: contract.name,
      diffSummary: diff.summary,
    };

    return {
      ...window,
      revision,
      revisions: [...window.revisions, revisionEntry],
      scopes,
      gates,
    };
  });

  if (affected) {
    persistWindows(next);
  }
}

/** 作废后重新核算：回到待回执，按当前修订重新等待回执 */
export async function resetVoidedGate(
  windowId: string,
  gateId: string,
): Promise<ReleaseWindow> {
  await wait();
  const windows = readWindows();
  const now = new Date().toISOString();
  const next = windows.map((window) => {
    if (window.id !== windowId) return window;
    return {
      ...window,
      gates: window.gates.map((gate) => {
        if (gate.id !== gateId || gate.state !== 'voided') return gate;
        return {
          ...gate,
          state: 'pending' as GateState,
          note: `已按修订 ${window.revision} 重新核算，等待新回执。`,
          history: [
            ...gate.history,
            {
              at: now,
              revision: window.revision,
              type: 'reset' as const,
              detail: `按修订 ${window.revision} 重新核算，等待最新回执。`,
            } satisfies GateHistoryEvent,
          ],
        };
      }),
    };
  });
  writeWindows(next);
  const updated = next.find((window) => window.id === windowId);
  if (!updated) throw new Error('发布窗口不存在');
  return clone(updated);
}

/* ------------------------------------------------------------------ */
/* 回执受理                                                             */
/* ------------------------------------------------------------------ */

function findGate(
  window: ReleaseWindow,
  contractId: string,
  consumerId: string,
): ReleaseGate | undefined {
  return window.gates.find(
    (gate) => gate.contractId === contractId && gate.consumerId === consumerId,
  );
}

function attemptId(receiptId: string): string {
  return `att-${receiptId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')}-${Date.now().toString(36)}`;
}

export async function submitReceipt(
  input: SubmitReceiptInput,
): Promise<SubmitReceiptResult> {
  await wait();
  const window = readWindows().find((item) => item.id === input.windowId);
  if (!window) {
    return { outcome: 'invalid_state', detail: '发布窗口不存在。' };
  }
  if (window.status !== 'open') {
    return { outcome: 'invalid_state', detail: '窗口已关闭，不再受理回执。' };
  }
  const gate = findGate(window, input.contractId, input.consumerId);
  if (!gate) {
    return {
      outcome: 'invalid_state',
      detail: '该契约 / 调用方不在本窗口冻结范围内。',
    };
  }

  // 1) 重复回执只算一次：按回执号命中历史受理或既有依据，幂等返回，不产生第二份记录
  const prior = window.attempts.find(
    (attempt) => attempt.receiptId === input.receiptId,
  );
  if (prior) {
    return {
      outcome: 'duplicate',
      detail: `回执 ${input.receiptId} 已受理过（${RECEIPT_OUTCOME_LABELS[prior.outcome]}），重复回执只算一次。`,
      gateId: prior.gateId,
    };
  }
  if (gate.state === 'released' || gate.basis?.receiptId === input.receiptId) {
    return {
      outcome: 'already_released',
      detail: '该调用方已放行（或该回执此前已完成放行），不会生成第二份放行记录。',
      gateId: gate.id,
    };
  }
  if (gate.state === 'conflict') {
    return {
      outcome: 'invalid_state',
      detail: '该调用方已在其他窗口先行获得放行，本窗口不再受理。',
      gateId: gate.id,
    };
  }

  // 2) 两个窗口同时提交同一调用方：只放先到者。其他【仍开窗】的窗口已放行即落败；
  //    已关闭的历史窗口不阻挡后续窗口重新验收
  const winner = readWindows().find(
    (item) =>
      item.id !== window.id &&
      item.status === 'open' &&
      item.gates.some(
        (other) =>
          other.contractId === input.contractId &&
          other.consumerId === input.consumerId &&
        other.state === 'released',
      ),
  );
  if (winner) {
    const detail = `调用方已在窗口「${winner.name}」先行获得放行，本窗口不再放行。`;
    const attempt: ReceiptAttempt = {
      id: attemptId(input.receiptId),
      at: new Date().toISOString(),
      gateId: gate.id,
      contractId: input.contractId,
      consumerId: input.consumerId,
      receiptId: input.receiptId,
      windowRevision: input.windowRevision,
      clientVersion: input.clientVersion,
      outcome: 'conflict_lost',
      detail,
      otherWindowId: winner.id,
    };
    try {
      commitAttempt(window.id, gate.id, {
        state: 'conflict',
        note: '同一调用方的验收回执已在其他窗口先行受理并放行，本窗口按先到者规则不放行。',
        history: { type: 'conflict', detail },
        attempt,
      });
    } catch (error) {
      return {
        outcome: 'invalid_state',
        detail: error instanceof Error ? error.message : '受理结果保存失败。',
        gateId: gate.id,
      };
    }
    return { outcome: 'conflict_lost', detail, gateId: gate.id };
  }

  // 3) 差异已变更、门被作废：不能直接放行，需先重算
  if (gate.state === 'voided') {
    const detail = `该调用方因差异变更已作废，需先按修订 ${window.revision} 重算后再提交回执。`;
    const attempt: ReceiptAttempt = {
      id: attemptId(input.receiptId),
      at: new Date().toISOString(),
      gateId: gate.id,
      contractId: input.contractId,
      consumerId: input.consumerId,
      receiptId: input.receiptId,
      windowRevision: input.windowRevision,
      clientVersion: input.clientVersion,
      outcome: 'invalid_state',
      detail,
    };
    try {
      commitAttempt(window.id, gate.id, { attempt });
    } catch (error) {
      return {
        outcome: 'invalid_state',
        detail: error instanceof Error ? error.message : '受理结果保存失败。',
        gateId: gate.id,
      };
    }
    return { outcome: 'invalid_state', detail, gateId: gate.id };
  }

  // 4) 旧回执缺修订号 → 待核；修订号对不上当前修订 → 待核。均不阻塞同批其他调用方
  if (input.windowRevision === null || input.windowRevision !== window.revision) {
    const isLegacy = input.windowRevision === null;
    const note = isLegacy
      ? '旧回执未携带窗口修订号，先待核；确认其验收对应的差异版本后再处理。'
      : `回执修订号 ${input.windowRevision} 与窗口当前修订 ${window.revision} 不一致，先待核，不影响同批其他调用方。`;
    const attempt: ReceiptAttempt = {
      id: attemptId(input.receiptId),
      at: new Date().toISOString(),
      gateId: gate.id,
      contractId: input.contractId,
      consumerId: input.consumerId,
      receiptId: input.receiptId,
      windowRevision: input.windowRevision,
      clientVersion: input.clientVersion,
      outcome: isLegacy ? 'legacy_pending' : 'revision_mismatch',
      detail: note,
    };
    try {
      commitAttempt(window.id, gate.id, {
        state: 'verifying',
        note,
        pendingReceipt: {
          receiptId: input.receiptId,
          windowRevision: input.windowRevision,
          clientVersion: input.clientVersion,
          receivedAt: new Date().toISOString(),
          note,
        },
        history: { type: 'verifying', detail: note },
        attempt,
      });
    } catch (error) {
      return {
        outcome: 'invalid_state',
        detail: error instanceof Error ? error.message : '受理结果保存失败。',
        gateId: gate.id,
      };
    }
    return {
      outcome: isLegacy ? 'legacy_pending' : 'revision_mismatch',
      detail: note,
      gateId: gate.id,
    };
  }

  // 5) 正常受理：两阶段提交，先落准备记录，再提交完整窗口
  const now = new Date().toISOString();
  const entry: JournalEntry = {
    id: `jrn-${input.receiptId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')}-${Date.now()}`,
    windowId: window.id,
    gateId: gate.id,
    input: {
      windowId: input.windowId,
      contractId: input.contractId,
      consumerId: input.consumerId,
      receiptId: input.receiptId,
      windowRevision: input.windowRevision,
      clientVersion: input.clientVersion,
    },
    preparedAt: now,
    committed: false,
  };
  appendJournal(entry);

  try {
    commitPreparedEntry(entry.id);
  } catch (error) {
    return {
      outcome: 'invalid_state',
      detail:
        error instanceof Error
          ? error.message
          : '保存失败，准备记录已保留，可从完整窗口恢复。',
      gateId: gate.id,
    };
  }

  return {
    outcome: 'accepted',
    detail: `已按修订 ${window.revision} 放行，验收回执 ${input.receiptId} 只计入一次。`,
    gateId: gate.id,
  };
}

interface CommitPatch {
  state?: GateState;
  note?: string;
  pendingReceipt?: ReleaseGate['pendingReceipt'];
  history?: { type: GateHistoryEvent['type']; detail: string };
  attempt: ReceiptAttempt;
}

/** 直接受理类结果（待核/落败/作废拦截）的落盘 */
function commitAttempt(windowId: string, gateId: string, patch: CommitPatch): void {
  const windows = readWindows();
  const now = new Date().toISOString();
  const next = windows.map((window) => {
    if (window.id !== windowId) return window;
    return {
      ...window,
      gates: window.gates.map((gate) => {
        if (gate.id !== gateId) return gate;
        const history = patch.history
          ? [
              ...gate.history,
              {
                at: now,
                revision: window.revision,
                type: patch.history.type,
                detail: patch.history.detail,
              } satisfies GateHistoryEvent,
            ]
          : gate.history;
        return {
          ...gate,
          state: patch.state ?? gate.state,
          note: patch.note ?? gate.note,
          pendingReceipt:
            'pendingReceipt' in patch ? patch.pendingReceipt : gate.pendingReceipt,
          history,
        };
      }),
      attempts: [...window.attempts, patch.attempt],
    };
  });
  writeWindows(next);
}

/**
 * 提交准备记录（阶段二）。天然幂等：
 * gate 已被同一回执放行 / 准备记录已提交时直接返回，重放不会生成第二份放行记录。
 */
function commitPreparedEntry(entryId: string): void {
  const windows = readWindows();
  const entry = windows
    .flatMap((window) => window.journal)
    .find((item) => item.id === entryId);
  if (!entry) throw new Error('准备记录缺失，无法恢复。');
  if (entry.committed) return;

  const window = windows.find((item) => item.id === entry.windowId);
  if (!window) throw new Error('发布窗口不存在，准备记录无法恢复。');
  const gate = window.gates.find((item) => item.id === entry.gateId);
  if (!gate) throw new Error('放行门缺失，准备记录无法恢复。');

  // 重放时该门已被放行（无论是否同一回执）：幂等成功，只补齐准备记录的提交标记，
  // 不覆盖既有依据、不生成第二份放行记录
  if (gate.state === 'released') {
    markCommitted(entry.id);
    return;
  }

  const scope = window.scopes.find((item) => item.contractId === gate.contractId);
  const now = new Date().toISOString();
  const basis = {
    releasedAt: now,
    receiptId: entry.input.receiptId,
    revision: window.revision,
    revisionLabel: `修订 ${window.revision}`,
    clientVersion: entry.input.clientVersion,
    contractVersion: scope?.contractVersion ?? '-',
    diffSignature: scope?.currentSignature ?? '-',
    diffSummary: scope?.currentSummary ?? '-',
  };
  const attempt: ReceiptAttempt = {
    id: attemptId(entry.input.receiptId),
    at: now,
    gateId: gate.id,
    contractId: entry.input.contractId,
    consumerId: entry.input.consumerId,
    receiptId: entry.input.receiptId,
    windowRevision: entry.input.windowRevision,
    clientVersion: entry.input.clientVersion,
    outcome: 'accepted',
    detail: `按修订 ${window.revision} 放行；客户端 ${entry.input.clientVersion}。`,
  };

  const next = windows.map((item) => {
    if (item.id !== window.id) return item;
    return {
      ...item,
      journal: item.journal.map((journal) =>
        journal.id === entry.id ? { ...journal, committed: true } : journal,
      ),
      gates: item.gates.map((candidate) =>
        candidate.id === gate.id
          ? {
              ...candidate,
              state: 'released' as GateState,
              scopeRevision: window.revision,
              note: '验收回执通过，已放行；放行依据已固定。',
              basis,
              pendingReceipt: undefined,
              history: [
                ...candidate.history,
                {
                  at: now,
                  revision: window.revision,
                  type: 'released' as const,
                  detail: `回执 ${entry.input.receiptId} 验收通过并放行（客户端 ${entry.input.clientVersion}，修订 ${window.revision}）。`,
                } satisfies GateHistoryEvent,
              ],
            }
          : candidate,
      ),
      attempts: [...item.attempts, attempt],
    };
  });
  writeWindows(next);
}

function markCommitted(entryId: string): void {
  const windows = readWindows();
  const next = windows.map((window) => ({
    ...window,
    journal: window.journal.map((journal) =>
      journal.id === entryId ? { ...journal, committed: true } : journal,
    ),
  }));
  persistWindows(next);
}

/**
 * 保存失败后的恢复：从完整窗口读出全部未完成准备记录并重放。
 * 每条只处理一次，已放行的门幂等跳过，重放不生成第二份放行记录。
 */
export async function recoverWindow(windowId: string): Promise<{
  recovered: number;
  skipped: number;
}> {
  await wait();
  const window = readWindows().find((item) => item.id === windowId);
  if (!window) throw new Error('发布窗口不存在');
  const pending = window.journal.filter((entry) => !entry.committed);
  let recovered = 0;
  let skipped = 0;
  for (const entry of pending) {
    try {
      commitPreparedEntry(entry.id);
      recovered += 1;
    } catch {
      skipped += 1;
    }
  }
  return { recovered, skipped };
}

/* ------------------------------------------------------------------ */
/* 种子窗口：演示分批放行、作废重算、待核、先到者、未完成重放             */
/* ------------------------------------------------------------------ */

function buildSeedWindows(contracts: ApiContract[]): ReleaseWindow[] {
  const order = contracts.find((item) => item.id === 'contract-order')!;
  const payment = contracts.find((item) => item.id === 'contract-payment')!;
  const openedAt = '2026-10-01T01:00:00.000Z';
  const orderDiff = computeContractDiff(order);
  const paymentDiff = computeContractDiff(payment);
  const windowId = 'win-autumn-release';
  const secondWindowId = 'win-spring-release';
  // 支付契约在窗口内改过差异：冻结签名刻意区别于当前签名
  const frozenPaymentSummary = '2 项差异：删除字段、新增错误码（开窗基线）';
  const frozenPaymentSignature = `${paymentDiff.signature}-base`;

  const gate = (
    contract: ApiContract,
    consumerId: string,
    patch: Partial<ReleaseGate>,
  ): ReleaseGate => {
    const consumer = contract.consumers.find((item) => item.id === consumerId)!;
    return {
      id: gateIdentity(windowId, contract.id, consumer.id),
      windowId,
      contractId: contract.id,
      contractName: contract.name,
      consumerId: consumer.id,
      consumerName: consumer.name,
      consumerOwner: consumer.owner,
      environment: consumer.environment,
      clientVersionAtFreeze: consumer.clientVersion,
      state: 'pending',
      scopeRevision: 1,
      note: '开窗冻结差异，等待调用方回传验收回执。',
      history: [
        {
          at: openedAt,
          revision: 1,
          type: 'created' as const,
          detail: `随窗口开窗冻结，客户端版本 ${consumer.clientVersion}。`,
        },
      ],
      ...patch,
    };
  };

  const gates: ReleaseGate[] = [
    // 订单中心：已放行，依据固定；订单差异未变，修订仍是 1
    gate(order, 'consumer-app', {
      state: 'released',
      note: '验收回执通过，已放行；放行依据已固定。',
      basis: {
        releasedAt: '2026-10-01T03:20:00.000Z',
        receiptId: 'RC-20261001-0001',
        revision: 1,
        revisionLabel: '修订 1',
        clientVersion: '4.6.2',
        contractVersion: order.version,
        diffSignature: orderDiff.signature,
        diffSummary: orderDiff.summary,
      },
    }),
    // 客服工作台：在主窗口先获放行（并行窗口竞争落败的依据）
    gate(order, 'consumer-cs', {
      state: 'released',
      note: '验收回执通过，已放行；放行依据已固定。',
      basis: {
        releasedAt: '2026-10-01T04:40:00.000Z',
        receiptId: 'RC-20261001-0007',
        revision: 1,
        revisionLabel: '修订 1',
        clientVersion: '3.9.0',
        contractVersion: order.version,
        diffSignature: orderDiff.signature,
        diffSummary: orderDiff.summary,
      },
    }),
    // 经营分析：旧回执缺修订号 → 待核，不阻塞同批
    gate(order, 'consumer-bi', {
      state: 'verifying',
      note: '旧回执未携带窗口修订号，先待核。',
      pendingReceipt: {
        receiptId: 'RC-20261001-0009',
        windowRevision: null,
        clientVersion: '2.1.5',
        receivedAt: '2026-10-02T08:10:00.000Z',
        note: '旧回执未携带窗口修订号，先待核；确认验收对应的差异版本后再处理。',
      },
    }),
    // 财务对账：支付差异在窗内变更 → 已作废待重算（修订 1 → 2）
    gate(payment, 'consumer-finance', {
      state: 'voided',
      scopeRevision: 2,
      note: '差异已变更，此前状态作废；重算后按最新修订重新受理回执。',
    }),
    // 支付运营台：修订 1 回执对不上当前修订 2 → 待核
    gate(payment, 'consumer-pay-ops', {
      state: 'verifying',
      scopeRevision: 2,
      note: '回执修订号 1 与窗口当前修订 2 不一致，先待核。',
      pendingReceipt: {
        receiptId: 'RC-20261002-0014',
        windowRevision: 1,
        clientVersion: '4.1.8',
        receivedAt: '2026-10-02T09:05:00.000Z',
        note: '回执修订号 1 与窗口当前修订 2 不一致，先待核，不影响同批其他调用方。',
      },
    }),
  ];

  // 补齐与状态一致的历史轨迹
  gates.forEach((item) => {
    if (item.state === 'released' && item.basis) {
      item.history.push({
        at: item.basis.releasedAt,
        revision: item.basis.revision,
        type: 'released',
        detail: `回执 ${item.basis.receiptId} 验收通过并放行（客户端 ${item.basis.clientVersion}，修订 ${item.basis.revision}）。`,
      });
    } else if (item.state === 'verifying') {
      item.history.push({
        at: item.pendingReceipt!.receivedAt,
        revision: item.scopeRevision,
        type: 'verifying',
        detail: item.note,
      });
    } else if (item.state === 'voided') {
      item.history.push({
        at: '2026-10-02T07:30:00.000Z',
        revision: 2,
        type: 'voided',
        detail: '支付清算 API 的差异在窗口内变更，旧核算作废，需重算（修订 1 → 2）。',
      });
    }
  });

  // 保存失败后未完成的准备记录：恢复重放后按修订 2 放行支付运营台，且不产生第二份记录
  const journal: JournalEntry[] = [
    {
      id: 'jrn-seed-pay-ops-0022',
      windowId,
      gateId: gateIdentity(windowId, payment.id, 'consumer-pay-ops'),
      input: {
        windowId,
        contractId: payment.id,
        consumerId: 'consumer-pay-ops',
        receiptId: 'RC-20261002-0022',
        windowRevision: 2,
        clientVersion: '4.1.9',
      },
      preparedAt: '2026-10-02T09:40:00.000Z',
      committed: false,
    },
  ];

  const attempts: ReceiptAttempt[] = [
    {
      id: 'att-rc-20261001-0001',
      at: '2026-10-01T03:20:00.000Z',
      gateId: gateIdentity(windowId, order.id, 'consumer-app'),
      contractId: order.id,
      consumerId: 'consumer-app',
      receiptId: 'RC-20261001-0001',
      windowRevision: 1,
      clientVersion: '4.6.2',
      outcome: 'accepted',
      detail: '按修订 1 放行；客户端 4.6.2。',
    },
    {
      id: 'att-rc-20261001-0001-dup',
      at: '2026-10-01T04:02:00.000Z',
      gateId: gateIdentity(windowId, order.id, 'consumer-app'),
      contractId: order.id,
      consumerId: 'consumer-app',
      receiptId: 'RC-20261001-0001',
      windowRevision: 1,
      clientVersion: '4.6.2',
      outcome: 'duplicate',
      detail: '重复回执只算一次，未生成第二份放行记录。',
    },
    {
      id: 'att-rc-20261001-0007',
      at: '2026-10-01T04:40:00.000Z',
      gateId: gateIdentity(windowId, order.id, 'consumer-cs'),
      contractId: order.id,
      consumerId: 'consumer-cs',
      receiptId: 'RC-20261001-0007',
      windowRevision: 1,
      clientVersion: '3.9.0',
      outcome: 'accepted',
      detail: '按修订 1 放行；客户端 3.9.0。先于并行窗口受理。',
    },
    {
      id: 'att-rc-20261001-0009',
      at: '2026-10-02T08:10:00.000Z',
      gateId: gateIdentity(windowId, order.id, 'consumer-bi'),
      contractId: order.id,
      consumerId: 'consumer-bi',
      receiptId: 'RC-20261001-0009',
      windowRevision: null,
      clientVersion: '2.1.5',
      outcome: 'legacy_pending',
      detail: '旧回执未携带窗口修订号，先待核。',
    },
    {
      id: 'att-rc-20261002-0014',
      at: '2026-10-02T09:05:00.000Z',
      gateId: gateIdentity(windowId, payment.id, 'consumer-pay-ops'),
      contractId: payment.id,
      consumerId: 'consumer-pay-ops',
      receiptId: 'RC-20261002-0014',
      windowRevision: 1,
      clientVersion: '4.1.8',
      outcome: 'revision_mismatch',
      detail: '回执修订号 1 与窗口当前修订 2 不一致，先待核。',
    },
    {
      id: 'att-rc-20261002-0031',
      at: '2026-10-02T10:40:00.000Z',
      gateId: gateIdentity(windowId, payment.id, 'consumer-finance'),
      contractId: payment.id,
      consumerId: 'consumer-finance',
      receiptId: 'RC-20261002-0031',
      windowRevision: 2,
      clientVersion: '5.2.0',
      outcome: 'invalid_state',
      detail: '支付契约差异已变更（修订 2），该门已作废，需先重算。',
    },
  ];

  const autumn: ReleaseWindow = {
    id: windowId,
    name: '国庆后批次（2026-10 上）',
    openedAt,
    status: 'open',
    revision: 2,
    revisions: [
      {
        revision: 1,
        at: openedAt,
        reason: '开窗冻结参与契约与差异范围',
        diffSummary: `订单履约 API：${orderDiff.summary}；支付清算 API：${frozenPaymentSummary}`,
      },
      {
        revision: 2,
        at: '2026-10-02T07:30:00.000Z',
        reason: '支付清算 API 差异范围变更，未放行调用方作废重算；已放行调用方保留依据',
        changedContractId: payment.id,
        changedContractName: payment.name,
        diffSummary: paymentDiff.summary,
      },
    ],
    scopes: [
      {
        contractId: order.id,
        contractName: order.name,
        contractVersion: order.version,
        frozenSignature: orderDiff.signature,
        frozenSummary: orderDiff.summary,
        currentSignature: orderDiff.signature,
        currentSummary: orderDiff.summary,
      },
      {
        contractId: payment.id,
        contractName: payment.name,
        contractVersion: payment.version,
        frozenSignature: frozenPaymentSignature,
        frozenSummary: frozenPaymentSummary,
        currentSignature: paymentDiff.signature,
        currentSummary: paymentDiff.summary,
      },
    ],
    gates,
    attempts,
    journal,
  };

  // 并行窗口：客服工作台在此重复提交，因主窗口已先行放行而落败
  const csGate: ReleaseGate = {
    id: gateIdentity(secondWindowId, order.id, 'consumer-cs'),
    windowId: secondWindowId,
    contractId: order.id,
    contractName: order.name,
    consumerId: 'consumer-cs',
    consumerName: '客服工作台',
    consumerOwner: '服务体验组',
    environment: '生产',
    clientVersionAtFreeze: '3.9.0',
    state: 'conflict',
    scopeRevision: 1,
    note: '同一调用方的验收回执已在其他窗口先行受理并放行，本窗口按先到者规则不放行。',
    history: [
      {
        at: '2026-10-01T02:00:00.000Z',
        revision: 1,
        type: 'created',
        detail: '随窗口开窗冻结，客户端版本 3.9.0。',
      },
      {
        at: '2026-10-01T05:10:00.000Z',
        revision: 1,
        type: 'conflict',
        detail: '竞争落败：客服工作台已在窗口「国庆后批次（2026-10 上）」获得放行。',
      },
    ],
  };

  const spring: ReleaseWindow = {
    id: secondWindowId,
    name: '应急修复窗口（并行）',
    openedAt: '2026-10-01T02:00:00.000Z',
    status: 'open',
    revision: 1,
    revisions: [
      {
        revision: 1,
        at: '2026-10-01T02:00:00.000Z',
        reason: '开窗冻结参与契约与差异范围',
        diffSummary: `订单履约 API：${orderDiff.summary}`,
      },
    ],
    scopes: [
      {
        contractId: order.id,
        contractName: order.name,
        contractVersion: order.version,
        frozenSignature: orderDiff.signature,
        frozenSummary: orderDiff.summary,
        currentSignature: orderDiff.signature,
        currentSummary: orderDiff.summary,
      },
    ],
    gates: [csGate],
    attempts: [
      {
        id: 'att-rc-20261001-0020',
        at: '2026-10-01T05:10:00.000Z',
        gateId: csGate.id,
        contractId: order.id,
        consumerId: 'consumer-cs',
        receiptId: 'RC-20261001-0020',
        windowRevision: 1,
        clientVersion: '3.9.0',
        outcome: 'conflict_lost',
        detail: '调用方已在窗口「国庆后批次（2026-10 上）」先行获得放行，本窗口不再放行。',
        otherWindowId: windowId,
      },
    ],
    journal: [],
  };

  return [autumn, spring];
}
