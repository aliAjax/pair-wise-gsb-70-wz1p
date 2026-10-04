import type { ApiContract } from './contract';
import { CHANGE_KIND_LABELS } from './contract';
import { stableChecksum } from '../lib/utils';

/** 调用方放行门状态：待回执 / 已放行 / 待核 / 已作废 / 未获放行（窗口竞争落败） */
export type GateState =
  | 'pending'
  | 'released'
  | 'verifying'
  | 'voided'
  | 'conflict';

export type GateHistoryType =
  | 'created'
  | 'released'
  | 'voided'
  | 'verifying'
  | 'conflict'
  | 'reset'
  | 'window_closed';

export interface GateHistoryEvent {
  at: string;
  revision: number;
  type: GateHistoryType;
  detail: string;
}

/** 待核回执：修订号对不上或旧回执缺修订号时留存，不阻塞同批其他调用方 */
export interface PendingReceipt {
  receiptId: string;
  windowRevision: number | null;
  clientVersion: string;
  receivedAt: string;
  note: string;
}

/** 已放行依据：随放行时刻固定，后续差异作废不会清除 */
export interface ReleaseBasis {
  releasedAt: string;
  receiptId: string;
  revision: number;
  revisionLabel: string;
  clientVersion: string;
  contractVersion: string;
  diffSignature: string;
  diffSummary: string;
}

export interface ReleaseGate {
  id: string;
  windowId: string;
  contractId: string;
  contractName: string;
  consumerId: string;
  consumerName: string;
  consumerOwner: string;
  environment: string;
  clientVersionAtFreeze: string;
  state: GateState;
  /** 该门最近一次核算对应的窗口修订号 */
  scopeRevision: number;
  note: string;
  basis?: ReleaseBasis;
  pendingReceipt?: PendingReceipt;
  history: GateHistoryEvent[];
}

export interface WindowRevision {
  revision: number;
  at: string;
  reason: string;
  changedContractId?: string;
  changedContractName?: string;
  diffSummary: string;
}

/** 开窗时冻结的参与契约差异范围 */
export interface WindowScope {
  contractId: string;
  contractName: string;
  contractVersion: string;
  frozenSignature: string;
  frozenSummary: string;
  currentSignature: string;
  currentSummary: string;
}

export type ReceiptOutcome =
  | 'accepted'
  | 'duplicate'
  | 'revision_mismatch'
  | 'legacy_pending'
  | 'conflict_lost'
  | 'already_released'
  | 'invalid_state';

export interface ReceiptAttempt {
  id: string;
  at: string;
  gateId?: string;
  contractId: string;
  consumerId: string;
  receiptId: string;
  windowRevision: number | null;
  clientVersion: string;
  outcome: ReceiptOutcome;
  detail: string;
  otherWindowId?: string;
}

/** 两阶段提交的准备记录：commit 失败后可从完整窗口重放 */
export interface JournalEntry {
  id: string;
  windowId: string;
  gateId: string;
  input: {
    windowId: string;
    contractId: string;
    consumerId: string;
    receiptId: string;
    windowRevision: number | null;
    clientVersion: string;
  };
  preparedAt: string;
  committed: boolean;
}

export interface ReleaseWindow {
  id: string;
  name: string;
  openedAt: string;
  closedAt?: string;
  status: 'open' | 'closed';
  revision: number;
  revisions: WindowRevision[];
  scopes: WindowScope[];
  gates: ReleaseGate[];
  attempts: ReceiptAttempt[];
  journal: JournalEntry[];
}

export const GATE_STATE_LABELS: Record<GateState, string> = {
  pending: '待回执',
  released: '已放行',
  verifying: '待核',
  voided: '已作废',
  conflict: '未获放行',
};

export const RECEIPT_OUTCOME_LABELS: Record<ReceiptOutcome, string> = {
  accepted: '已放行',
  duplicate: '重复回执（只算一次）',
  revision_mismatch: '修订号不符·待核',
  legacy_pending: '旧回执缺修订号·待核',
  conflict_lost: '其他窗口已先行放行',
  already_released: '已放行（幂等返回）',
  invalid_state: '当前状态不可受理',
};

export function gateIdentity(
  windowId: string,
  contractId: string,
  consumerId: string,
): string {
  return `gate-${windowId}-${contractId}-${consumerId}`;
}

/**
 * 差异签名只覆盖参与方真正约定的内容：OpenAPI 文本 + 每条差异的路径/方法/类型/前后值。
 * 评审状态、影响说明、豁免等流程信息不进签名，评审动作不会误作废调用方。
 */
export function computeContractDiff(contract: ApiContract): {
  signature: string;
  summary: string;
} {
  const changeFingerprint = contract.changes
    .map((change) =>
      [change.path, change.method, change.kind, change.before, change.after].join('§'),
    )
    .join('|');
  const signature = stableChecksum(`${contract.openapi}∥${changeFingerprint}`);
  const kinds = Array.from(new Set(contract.changes.map((change) => change.kind)));
  const summary = contract.changes.length
    ? `${contract.changes.length} 项差异：${kinds
        .map((kind) => CHANGE_KIND_LABELS[kind])
        .join('、')}`
    : '无登记差异（仅 OpenAPI 定义）';
  return { signature, summary };
}

export interface WindowRollup {
  total: number;
  released: number;
  pending: number;
  verifying: number;
  voided: number;
  conflict: number;
  uncommitted: number;
  progress: number;
}

export function rollupWindow(
  window: ReleaseWindow,
  scopeContractId?: string,
): WindowRollup {
  const gates = window.gates.filter(
    (gate) => !scopeContractId || gate.contractId === scopeContractId,
  );
  const count = (state: GateState) =>
    gates.filter((gate) => gate.state === state).length;
  const total = gates.length;
  const released = count('released');
  const uncommitted = window.journal.filter(
    (entry) =>
      !entry.committed &&
      (!scopeContractId ||
        window.gates.some(
          (gate) => gate.id === entry.gateId && gate.contractId === scopeContractId,
        )),
  ).length;
  return {
    total,
    released,
    pending: count('pending'),
    verifying: count('verifying'),
    voided: count('voided'),
    conflict: count('conflict'),
    uncommitted,
    progress: total ? Math.round((released / total) * 100) : 100,
  };
}

/** 发布页、契约详情、报告共用的行级视图 */
export interface GateRow {
  gate: ReleaseGate;
  scope: WindowScope;
  scopeChanged: boolean;
}

export function gateRows(window: ReleaseWindow, scopeContractId?: string): GateRow[] {
  return window.gates
    .filter((gate) => !scopeContractId || gate.contractId === scopeContractId)
    .map((gate) => {
      const scope = window.scopes.find((item) => item.contractId === gate.contractId);
      const fallback: WindowScope = scope ?? {
        contractId: gate.contractId,
        contractName: gate.contractName,
        contractVersion: '-',
        frozenSignature: '-',
        frozenSummary: '范围已缺失',
        currentSignature: '-',
        currentSummary: '范围已缺失',
      };
      return {
        gate,
        scope: fallback,
        scopeChanged: fallback.frozenSignature !== fallback.currentSignature,
      };
    });
}
