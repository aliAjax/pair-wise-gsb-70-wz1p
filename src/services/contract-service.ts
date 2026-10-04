import { seedContracts } from '../data/seed';
import type {
  ApiContract,
  ContractChange,
  ContractVersion,
  ReviewState,
} from '../models/contract';
import { stableChecksum, formatDateTime } from '../lib/utils';
import { syncContractChange } from './release-service';
import {
  gateRows,
  rollupWindow,
  type ReleaseWindow,
} from '../models/release';

const STORAGE_KEY = 'pair-wise-gsb-70-contracts';
const LATENCY = 180;

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function wait(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, LATENCY));
}

export async function listContracts(): Promise<ApiContract[]> {
  await wait();
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      return JSON.parse(stored) as ApiContract[];
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  persistContracts(seedContracts);
  return clone(seedContracts);
}

export async function getContract(id: string): Promise<ApiContract | undefined> {
  const contracts = await listContracts();
  return contracts.find((contract) => contract.id === id);
}

export async function saveContract(updated: ApiContract): Promise<ApiContract> {
  const contracts = await listContracts();
  const exists = contracts.some((contract) => contract.id === updated.id);
  const saved = { ...updated, updatedAt: new Date().toISOString() };
  const next = exists
    ? contracts.map((contract) => (contract.id === updated.id ? saved : contract))
    : [saved, ...contracts];
  persistContracts(next);
  // 差异范围（OpenAPI 或差异条目）一旦改动，开放窗口中依赖它且未放行的调用方作废重算
  await syncContractChange(saved.id, saved);
  await wait();
  return clone(saved);
}

export async function reviewChange(
  contractId: string,
  changeId: string,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
): Promise<ApiContract> {
  const contracts = await listContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }

  const updated: ApiContract = {
    ...contract,
    status: contract.status === 'draft' ? 'review' : contract.status,
    changes: contract.changes.map((change) =>
      change.id === changeId
        ? {
            ...change,
            reviewState,
            reviewer,
            reviewComment: comment,
            reviewedAt: new Date().toISOString(),
          }
        : change,
    ),
  };
  persistContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

export async function bulkReviewChanges(
  selections: Array<{ contractId: string; changeId: string }>,
  reviewState: ReviewState,
  reviewer: string,
  comment: string,
): Promise<ApiContract[]> {
  const contracts = await listContracts();
  const selected = new Set(selections.map((item) => `${item.contractId}:${item.changeId}`));
  const updated = contracts.map((contract) => ({
    ...contract,
    status:
      selected.has(`${contract.id}:${contract.changes[0]?.id}`) && contract.status === 'draft'
        ? ('review' as const)
        : contract.status,
    changes: contract.changes.map((change) =>
      selected.has(`${contract.id}:${change.id}`)
        ? {
            ...change,
            reviewState,
            reviewer,
            reviewComment: comment,
            reviewedAt: new Date().toISOString(),
          }
        : change,
    ),
  }));
  persistContracts(updated);
  await wait();
  return clone(updated);
}

export async function updateContractOpenApi(
  contractId: string,
  openapi: string,
): Promise<ApiContract> {
  const contracts = await listContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }
  const updated = { ...contract, openapi, updatedAt: new Date().toISOString() };
  persistContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await syncContractChange(contractId, updated);
  await wait();
  return clone(updated);
}

export async function addExemption(
  contractId: string,
  changeId: string,
  reason: string,
): Promise<ApiContract> {
  const contracts = await listContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }
  const exemption = {
    id: `ex-${Date.now()}`,
    changeId,
    scope: contract.changes.find((item) => item.id === changeId)?.path ?? '未指定',
    reason,
    approvedBy: '当前评审人',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
  const updated: ApiContract = {
    ...contract,
    exemptions: [...contract.exemptions, exemption],
    changes: contract.changes.map((change) =>
      change.id === changeId ? { ...change, reviewState: 'exemption' } : change,
    ),
  };
  persistContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

export async function freezeVersion(
  contractId: string,
  version: string,
  notes: string,
): Promise<ApiContract> {
  const contracts = await listContracts();
  const contract = contracts.find((item) => item.id === contractId);
  if (!contract) {
    throw new Error('契约不存在');
  }

  const release: ContractVersion = {
    id: `ver-${Date.now()}`,
    contractId,
    version,
    releasedAt: new Date().toISOString(),
    checksum: stableChecksum(contract.openapi),
    notes,
    changeIds: contract.changes.map((change) => change.id),
    openapi: contract.openapi,
  };
  const updated: ApiContract = {
    ...contract,
    version,
    status: 'frozen',
    versions: [release, ...contract.versions],
  };
  persistContracts(contracts.map((item) => (item.id === contractId ? updated : item)));
  await wait();
  return clone(updated);
}

export function generateExampleRequest(contract: ApiContract, change?: ContractChange): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contract.openapi);
  } catch {
    parsed = null;
  }
  const openapi = parsed as
    | {
        paths?: Record<string, Record<string, { summary?: string }>>;
      }
    | null;
  const candidates = openapi?.paths ? Object.entries(openapi.paths) : [];
  const selectedPath = change?.path ?? candidates[0]?.[0] ?? '/resource';
  const selectedMethod = (
    change?.method ??
    (candidates[0]?.[1] ? Object.keys(candidates[0][1])[0] : 'get')
  ).toUpperCase();
  const fields = change
    ? [change.after.replace(/^新增|移除|变为/g, '').trim()]
    : ['orderId: ORD-20260929-001', 'requestId: req-local-demo'];

  return JSON.stringify(
    {
      method: selectedMethod,
      url: `https://api.example.com${selectedPath.replace('{orderId}', 'ORD-20260929-001').replace('{paymentId}', 'PAY-90218').replace('{userId}', 'U-1024')}`,
      headers: {
        Authorization: 'Bearer <token>',
        'X-Client-Version': contract.version,
      },
      body:
        selectedMethod === 'GET'
          ? undefined
          : Object.fromEntries(
              fields.map((field) => {
                const [key, value] = field.split(':').map((item) => item.trim());
                return [key || 'field', value || 'value'];
              }),
            ),
    },
    null,
    2,
  );
}

export function buildChangeReport(
  contract: ApiContract,
  windows: ReleaseWindow[] = [],
): string {
  const involvedWindows = windows.filter((window) =>
    window.scopes.some((scope) => scope.contractId === contract.id),
  );
  const lines = [
    `# ${contract.name} ${contract.version} 契约变更报告`,
    '',
    `- 领域：${contract.domain}`,
    `- 负责人：${contract.owner}`,
    `- 状态：${contract.status}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 变更明细',
    ...contract.changes.flatMap((change) => [
      `### ${change.method} ${change.path} - ${change.kind}`,
      `- 兼容性：${change.compatibility}`,
      `- 变更前：${change.before}`,
      `- 变更后：${change.after}`,
      `- 判定依据：${change.rationale}`,
      `- 调用方影响：${change.impactStatement || '未填写'}`,
      `- 迁移方案：${change.migrationPlan || '未填写'}`,
      `- 评审结论：${change.reviewState}`,
      '',
    ]),
    '## 调用方',
    ...contract.consumers.map(
      (consumer) =>
        `- ${consumer.name} / ${consumer.owner} / ${consumer.environment} / ${consumer.clientVersion}`,
    ),
    '',
    '## 发布窗口与分批放行',
    ...(involvedWindows.length
      ? involvedWindows.flatMap((window) => {
          const rollup = rollupWindow(window, contract.id);
          const scope = window.scopes.find((item) => item.contractId === contract.id);
          const section = [
            `### 窗口 ${window.name}（${window.status === 'open' ? '开窗中' : '已关窗'}，修订 ${window.revision}）`,
            `- 开窗时间：${formatDateTime(window.openedAt)}`,
            scope
              ? `- 冻结差异：${scope.frozenSummary}（签名 ${scope.frozenSignature.slice(0, 8)}）`
              : '- 冻结差异：缺失',
            scope && scope.frozenSignature !== scope.currentSignature
              ? `- 当前差异：${scope.currentSummary}（签名 ${scope.currentSignature.slice(0, 8)}），差异已变更，未放行调用方已作废重算；已放行调用方保留依据`
              : '- 当前差异与开窗冻结一致',
            `- 放行汇总：已放行 ${rollup.released}/${rollup.total}，待回执 ${rollup.pending}，待核 ${rollup.verifying}，作废 ${rollup.voided}，未获放行 ${rollup.conflict}`,
          ];
          gateRows(window, contract.id).forEach(({ gate }) => {
            const stateText = {
              pending: '待回执',
              released: '已放行',
              verifying: '待核',
              voided: '已作废待重算',
              conflict: '未获放行（其他窗口先到）',
            }[gate.state];
            let line = `- ${gate.consumerName}（${gate.clientVersionAtFreeze}）：${stateText}`;
            if (gate.basis) {
              line += `；放行依据 回执 ${gate.basis.receiptId} / ${gate.basis.revisionLabel} / 客户端 ${gate.basis.clientVersion} / 放行于 ${formatDateTime(gate.basis.releasedAt)}`;
            }
            if (gate.pendingReceipt) {
              line += `；待核回执 ${gate.pendingReceipt.receiptId}（修订号 ${gate.pendingReceipt.windowRevision ?? '缺失'}，客户端 ${gate.pendingReceipt.clientVersion}）`;
            }
            section.push(line);
          });
          section.push('');
          return section;
        })
      : ['- 该契约尚未加入任何发布窗口', '']),
    '',
    '## 豁免记录',
    ...(contract.exemptions.length
      ? contract.exemptions.map(
          (item) => `- ${item.scope}：${item.reason}（至 ${item.expiresAt}）`,
        )
      : ['- 无']),
  ];
  return lines.join('\n');
}

export function diffVersionSummary(contract: ApiContract): string {
  const previous = contract.versions[0];
  if (!previous) {
    return '无可比较的历史正式版本。';
  }
  return [
    `上一版 ${previous.version}`,
    `发布于 ${formatDateTime(previous.releasedAt)}`,
    `校验值 ${previous.checksum}`,
    `本版变更 ${contract.changes.length} 项`,
  ].join('\n');
}

function persistContracts(contracts: ApiContract[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contracts));
}
