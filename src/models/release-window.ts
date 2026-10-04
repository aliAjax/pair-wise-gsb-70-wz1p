import { stableChecksum } from '../lib/utils';

/**
 * 发布窗口：把“契约版本 + 调用方 + 发布时间窗”接成按调用方分批放行。
 *
 * 开窗时冻结参与契约、差异范围（changeIds）、契约版本与差异签名；窗口存活期间，
 * 被冻结契约的差异若发生修改，窗口 revision 递增，只把依赖该契约且尚未放行的
 * 调用方置为“作废待重算”，已放行的调用方保留放行依据（basisRevision）。
 *
 * 本模块是纯函数领域核心：所有 apply* 都不修改入参，返回的状态可直接整体持久化。
 */

export type WindowStatus = 'open' | 'closed';
export type ParticipantState =
  | 'pending' // 等待调用方回传验收回执
  | 'cleared' // 已放行，保留放行依据
  | 'verifying' // 回执修订号对不上（或缺修订号的旧回执），先待核
  | 'voided'; // 差异已改，作废重算，等待新修订号回执

export interface FrozenContractScope {
  contractId: string;
  contractName: string;
  /** 开窗时冻结的契约版本号 */
  version: string;
  /** 开窗时冻结的差异范围 */
  changeIds: string[];
  /** 差异范围的冻结签名，用于识别“某份契约的差异一改” */
  scopeSignature: string;
}

export interface AcceptanceReceipt {
  id: string;
  consumerId: string;
  /** 回执自带的窗口修订号；旧回执可能缺省（undefined），按规则先待核 */
  windowRevision?: number;
  clientVersion: string;
  receivedAt: string;
  /** 同一份回执只计一次的去重键：同一窗口、同一调用方、同一修订号、同一客户端版本 */
  dedupeKey: string;
}

export interface WindowParticipant {
  id: string;
  consumerId: string;
  consumerName: string;
  owner: string;
  contractId: string;
  /** 本次放行依据的修订号；已放行后即使窗口再修订也保留 */
  basisRevision?: number;
  state: ParticipantState;
  /** 该参与方收到过的全部回执（重复回执也留痕，但只计一次） */
  receipts: AcceptanceReceipt[];
  /** 决定当前状态的那份已计数回执 */
  countedReceiptId?: string;
  /** 被哪份契约的差异变更作废，用于差异范围展示 */
  voidedByContractId?: string;
  voidedAt?: string;
  /** 被其他窗口先到先得而拒绝时记录对方窗口 */
  claimConflictWindowId?: string;
  updatedAt: string;
}

export interface WindowEvent {
  id: string;
  opId: string;
  type:
    | 'opened'
    | 'revision_bumped'
    | 'receipt_accepted'
    | 'receipt_duplicate'
    | 'receipt_verifying'
    | 'receipt_conflict'
    | 'participant_voided'
    | 'closed';
  at: string;
  consumerId?: string;
  contractId?: string;
  revision?: number;
  detail: string;
}

/**
 * 操作日志：保存失败后，完整窗口快照里仍带有未完成操作，应用恢复时从快照重放。
 * 同一 opId 天然幂等——重放不会生成第二份放行记录。
 */
export interface JournalEntry {
  opId: string;
  kind: 'open' | 'receipt' | 'close';
  at: string;
  payload: unknown;
}

export interface ReleaseWindow {
  id: string;
  name: string;
  status: WindowStatus;
  /** 窗口修订号：开窗为 1，冻结范围中任一契约差异变化即 +1 */
  revision: number;
  opensAt: string;
  closesAt: string;
  frozenContracts: FrozenContractScope[];
  participants: WindowParticipant[];
  events: WindowEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface WindowState {
  windows: ReleaseWindow[];
  /**
   * 全局先到先得索引：consumerId -> 首个放行成功的窗口 id。
   * 两个窗口同时提交同一调用方时，只有先到者能放行。
   */
  claims: Record<string, string>;
  /** 已应用操作的 opId 集合，重放与重复提交的去重依据 */
  appliedOps: string[];
  /** 未完成（保存失败）的操作日志，恢复时重放 */
  journal: JournalEntry[];
  /** 供演示：下一次保存强制失败一次 */
  failNextSave: boolean;
  /** 最近一次“保存失败后恢复”的说明，供页面展示 */
  lastRecovery?: string;
}

export interface ReceiptInput {
  consumerId: string;
  windowRevision?: number;
  clientVersion: string;
}

export const PARTICIPANT_STATE_LABELS: Record<ParticipantState, string> = {
  pending: '待回执',
  cleared: '已放行',
  verifying: '待核对',
  voided: '作废重算',
};

export function emptyWindowState(): WindowState {
  return { windows: [], claims: {}, appliedOps: [], journal: [], failNextSave: false };
}

type ChangeLike = {
  id: string;
  kind: string;
  before: string;
  after: string;
};

export function scopeSignatureFor(changes: Array<Pick<ChangeLike, 'id' | 'before' | 'after' | 'kind'>>): string {
  const material = changes
    .map((change) => `${change.id}|${change.kind}|${change.before}|${change.after}`)
    .sort()
    .join('\n');
  return stableChecksum(material || 'empty-scope');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

let eventSeq = 0;
function nowIso(): string {
  return new Date().toISOString();
}
let idSeq = 0;
function uniqueId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq}-${Math.random().toString(36).slice(2, 6)}`;
}

function pushEvent(
  window: ReleaseWindow,
  event: Omit<WindowEvent, 'id' | 'at'>,
): void {
  eventSeq += 1;
  window.events.push({ id: `evt-${Date.now()}-${eventSeq}`, at: nowIso(), ...event });
}

function receiptDedupeKey(windowId: string, input: ReceiptInput): string {
  return [windowId, input.consumerId, input.windowRevision ?? 'none', input.clientVersion].join(':');
}

export interface OpenWindowInput {
  opId: string;
  name: string;
  opensAt: string;
  closesAt: string;
  contracts: Array<{
    contractId: string;
    contractName: string;
    version: string;
    changeIds: string[];
    changes: ChangeLike[];
  }>;
  participants: Array<{
    consumerId: string;
    consumerName: string;
    owner: string;
    contractId: string;
  }>;
}

/** 开窗：冻结参与契约与差异范围，参与方进入待回执。重复 opId 直接返回原状态。 */
export function applyOpenWindow(prev: WindowState, input: OpenWindowInput): WindowState {
  if (prev.appliedOps.includes(input.opId)) {
    return prev;
  }
  const state = clone(prev);
  const id = uniqueId('win');
  const window: ReleaseWindow = {
    id,
    name: input.name,
    status: 'open',
    revision: 1,
    opensAt: input.opensAt,
    closesAt: input.closesAt,
    frozenContracts: input.contracts.map((contract) => ({
      contractId: contract.contractId,
      contractName: contract.contractName,
      version: contract.version,
      changeIds: [...contract.changeIds],
      scopeSignature: scopeSignatureFor(
        contract.changes.filter((change) => contract.changeIds.includes(change.id)),
      ),
    })),
    participants: input.participants.map((participant, index) => ({
      id: `${id}-p-${index + 1}`,
      consumerId: participant.consumerId,
      consumerName: participant.consumerName,
      owner: participant.owner,
      contractId: participant.contractId,
      state: 'pending' as const,
      receipts: [],
      updatedAt: nowIso(),
    })),
    events: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  pushEvent(window, {
    opId: input.opId,
    type: 'opened',
    detail: `开窗冻结 ${input.contracts.length} 份契约、${input.participants.length} 个调用方，修订号 r1。`,
  });
  state.windows = [window, ...state.windows];
  state.appliedOps.push(input.opId);
  return state;
}

export type ReceiptOutcome = 'accepted' | 'duplicate' | 'verifying' | 'conflict';

export interface ApplyReceiptInput {
  opId: string;
  windowId: string;
  receipt: ReceiptInput;
}

export interface ReceiptResult {
  outcome: ReceiptOutcome;
  detail: string;
  /** 冲突时胜出的窗口 id（先到者） */
  claimOwnerWindowId?: string;
}

/**
 * 提交验收回执：
 * - 重复回执（窗口/调用方/修订号/客户端版本一致）只计一次；
 * - 修订号对不上或缺修订号（旧回执）→ 待核，不产生放行，也不挡住同批其他调用方；
 * - 全局先到先得：同一调用方已被其他窗口放行 → 冲突拒绝，不产生放行记录；
 * - 其余情况按当前修订号放行，记录放行依据。
 */
export function applyReceipt(
  prev: WindowState,
  input: ApplyReceiptInput,
): { state: WindowState; result: ReceiptResult } {
  if (prev.appliedOps.includes(input.opId)) {
    return {
      state: prev,
      result: { outcome: 'duplicate', detail: '该回执操作已处理过（操作重放，幂等返回）。' },
    };
  }

  const state = clone(prev);
  const window = state.windows.find((item) => item.id === input.windowId);
  if (!window) {
    return { state: prev, result: { outcome: 'conflict', detail: '发布窗口不存在。' } };
  }
  const participant = window.participants.find(
    (item) => item.consumerId === input.receipt.consumerId,
  );
  if (!participant) {
    return { state: prev, result: { outcome: 'conflict', detail: '该调用方不在本窗口参与名单。' } };
  }

  const now = nowIso();
  const key = receiptDedupeKey(input.windowId, input.receipt);
  const receipt: AcceptanceReceipt = {
    id: uniqueId('rcp'),
    consumerId: input.receipt.consumerId,
    windowRevision: input.receipt.windowRevision,
    clientVersion: input.receipt.clientVersion,
    receivedAt: now,
    dedupeKey: key,
  };
  participant.receipts.push(receipt);

  // 同一窗口内重复回执只算一次（作废后用新修订号重新提交不算重复）。
  const alreadyCounted = participant.receipts.some(
    (item) => item.dedupeKey === key && item.id !== receipt.id,
  );
  if (alreadyCounted) {
    pushEvent(window, {
      opId: input.opId,
      type: 'receipt_duplicate',
      consumerId: input.receipt.consumerId,
      detail: `重复回执只计一次：${input.receipt.clientVersion}（修订号 ${
        input.receipt.windowRevision ?? '缺失'
      }）。`,
    });
    window.updatedAt = now;
    state.appliedOps.push(input.opId);
    return {
      state,
      result: { outcome: 'duplicate', detail: '重复回执，本窗口内只计一次，不改变放行状态。' },
    };
  }

  // 修订号缺失（旧回执）或与窗口当前修订号不一致 → 先待核；不影响同批其他参与方。
  const revisionMismatch =
    input.receipt.windowRevision === undefined ||
    input.receipt.windowRevision !== window.revision;
  if (revisionMismatch) {
    participant.state = 'verifying';
    participant.countedReceiptId = receipt.id;
    participant.updatedAt = now;
    pushEvent(window, {
      opId: input.opId,
      type: 'receipt_verifying',
      consumerId: input.receipt.consumerId,
      revision: input.receipt.windowRevision,
      detail:
        input.receipt.windowRevision === undefined
          ? `旧回执缺少修订号，先待核（回执客户端 ${input.receipt.clientVersion}）。`
          : `回执修订号 r${input.receipt.windowRevision} 与窗口 r${window.revision} 不一致，先待核。`,
    });
    window.updatedAt = now;
    state.appliedOps.push(input.opId);
    return {
      state,
      result: {
        outcome: 'verifying',
        detail:
          input.receipt.windowRevision === undefined
            ? '旧回执缺少修订号，已进入待核，不影响同批其他调用方。'
            : `修订号对不上（回执 r${input.receipt.windowRevision} / 窗口 r${window.revision}），先待核。`,
      },
    };
  }

  // 先到先得：该调用方是否已被别的窗口放行。
  const claimOwner = state.claims[input.receipt.consumerId];
  if (claimOwner && claimOwner !== input.windowId) {
    participant.state = 'verifying';
    participant.claimConflictWindowId = claimOwner;
    participant.countedReceiptId = receipt.id;
    participant.updatedAt = now;
    pushEvent(window, {
      opId: input.opId,
      type: 'receipt_conflict',
      consumerId: input.receipt.consumerId,
      detail: `同一调用方已被窗口 ${claimOwner} 先行放行，本窗口拒绝，不生成放行记录。`,
    });
    window.updatedAt = now;
    state.appliedOps.push(input.opId);
    return {
      state,
      result: {
        outcome: 'conflict',
        detail: `该调用方已由先提交的窗口 ${claimOwner} 放行，本窗口不再放行。`,
        claimOwnerWindowId: claimOwner,
      },
    };
  }

  // 放行：记录依据（修订号 + 客户端版本 + 回执 id）。
  participant.state = 'cleared';
  participant.basisRevision = window.revision;
  participant.countedReceiptId = receipt.id;
  participant.claimConflictWindowId = undefined;
  participant.voidedByContractId = undefined;
  participant.voidedAt = undefined;
  participant.updatedAt = now;
  state.claims[input.receipt.consumerId] = input.windowId;
  pushEvent(window, {
    opId: input.opId,
    type: 'receipt_accepted',
    consumerId: input.receipt.consumerId,
    revision: window.revision,
    detail: `按窗口 r${window.revision} 放行，客户端 ${input.receipt.clientVersion}，依据保留。`,
  });
  window.updatedAt = now;
  state.appliedOps.push(input.opId);
  return { state, result: { outcome: 'accepted', detail: `验收通过，按 r${window.revision} 放行。` } };
}

/**
 * 差异漂移检测：把开窗冻结的差异范围与当前契约的差异比较。
 * 只有落在冻结 changeIds 内的差异被改（内容变化或删除）才算“某份契约的差异一改”：
 * 窗口修订号 +1，仅作废依赖该契约且尚未放行的参与方；已放行的保留依据。
 * 对同一状态重复调用是稳定的：签名没变就原样返回。
 */
export function syncWindowScopes(
  prev: WindowState,
  current: Array<{ contractId: string; changes: ChangeLike[] }>,
): WindowState {
  const state = clone(prev);
  let changed = false;

  for (const window of state.windows) {
    if (window.status !== 'open') continue;
    let bumped = false;
    let affectedContracts = 0;

    for (const scope of window.frozenContracts) {
      const live = current.find((item) => item.contractId === scope.contractId);
      if (!live) continue;
      const inScope = live.changes.filter((change) => scope.changeIds.includes(change.id));
      const signature = scopeSignatureFor(inScope);
      if (signature === scope.scopeSignature) continue;

      scope.scopeSignature = signature;
      // 差异被删除的项移出冻结范围；仍存在的保留。
      scope.changeIds = scope.changeIds.filter((id) =>
        inScope.some((change) => change.id === id),
      );
      if (!bumped) {
        window.revision += 1;
        bumped = true;
      }
      affectedContracts += 1;
      changed = true;

      // 只作废依赖它且没放行的调用方；已放行（cleared）保留依据。
      for (const participant of window.participants) {
        if (participant.contractId !== scope.contractId) continue;
        if (participant.state === 'cleared' || participant.state === 'voided') continue;
        participant.state = 'voided';
        participant.voidedByContractId = scope.contractId;
        participant.voidedAt = nowIso();
        participant.updatedAt = nowIso();
        pushEvent(window, {
          opId: `sync-${window.id}-${scope.contractId}-${window.revision}`,
          type: 'participant_voided',
          consumerId: participant.consumerId,
          contractId: scope.contractId,
          revision: window.revision,
          detail: `契约 ${scope.contractName} 差异已改（窗口 r${window.revision}），未放行参与方作废重算。`,
        });
      }
    }

    if (bumped) {
      pushEvent(window, {
        opId: `sync-${window.id}-${window.revision}`,
        type: 'revision_bumped',
        revision: window.revision,
        detail: `冻结范围中 ${affectedContracts} 份契约差异变化，窗口修订到 r${window.revision}；已放行调用方保留依据。`,
      });
      window.updatedAt = nowIso();
    }
  }

  return changed ? state : prev;
}

export interface CloseWindowInput {
  opId: string;
  windowId: string;
}

/** 关窗：仍有未放行/待核/作废的参与方时不允许关闭。 */
export function applyCloseWindow(
  prev: WindowState,
  input: CloseWindowInput,
): { state: WindowState; ok: boolean; detail: string } {
  if (prev.appliedOps.includes(input.opId)) {
    return { state: prev, ok: true, detail: '关窗操作已处理过（幂等返回）。' };
  }
  const state = clone(prev);
  const window = state.windows.find((item) => item.id === input.windowId);
  if (!window) {
    return { state: prev, ok: false, detail: '发布窗口不存在。' };
  }
  const outstanding = window.participants.filter((item) => item.state !== 'cleared');
  if (outstanding.length > 0) {
    return {
      state: prev,
      ok: false,
      detail: `仍有 ${outstanding.length} 个调用方未放行（待回执/待核/作废重算），不能关窗。`,
    };
  }
  window.status = 'closed';
  window.updatedAt = nowIso();
  pushEvent(window, {
    opId: input.opId,
    type: 'closed',
    detail: '全部调用方已分批放行，窗口关闭，放行依据归档。',
  });
  state.appliedOps.push(input.opId);
  return { state, ok: true, detail: '窗口已关闭。' };
}

/** 窗口维度的汇总，发布页/契约详情/报告共用同一份结果。 */
export function windowSummary(window: ReleaseWindow): {
  total: number;
  cleared: number;
  pending: number;
  verifying: number;
  voided: number;
  progress: number;
  allCleared: boolean;
} {
  const total = window.participants.length;
  const count = (state: ParticipantState) =>
    window.participants.filter((item) => item.state === state).length;
  const cleared = count('cleared');
  return {
    total,
    cleared,
    pending: count('pending'),
    verifying: count('verifying'),
    voided: count('voided'),
    progress: total ? Math.round((cleared / total) * 100) : 0,
    allCleared: total > 0 && cleared === total,
  };
}

/** 从完整窗口快照重放未完成的操作日志；已应用的 opId 会被跳过，不产生第二份放行记录。 */
export function replayPendingJournal(prev: WindowState): WindowState {
  const pending = prev.journal;
  if (!pending.length) return prev;
  let state = clone(prev);
  let replayed = 0;
  for (const entry of pending) {
    if (state.appliedOps.includes(entry.opId)) continue;
    if (entry.kind === 'open') {
      state = applyOpenWindow(state, entry.payload as OpenWindowInput);
    } else if (entry.kind === 'receipt') {
      state = applyReceipt(state, entry.payload as ApplyReceiptInput).state;
    } else if (entry.kind === 'close') {
      state = applyCloseWindow(state, entry.payload as CloseWindowInput).state;
    }
    replayed += 1;
  }
  state.journal = [];
  state.lastRecovery = `已从完整窗口快照恢复并重放 ${replayed} 条未完成操作（幂等，未生成重复放行记录）。`;
  return state;
}
