import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReviewState } from '../models/contract';
import {
  addExemption,
  bulkReviewChanges,
  freezeVersion,
  getContract,
  listContracts,
  reviewChange,
  saveContract,
  updateContractOpenApi,
} from './contract-service';
import { releaseKeys } from './release-queries';

export const contractKeys = {
  all: ['contracts'] as const,
  detail: (id: string) => ['contracts', id] as const,
};

/**
 * 契约差异保存后会联动开放中的发布窗口（未放行门作废重算），
 * 因此这些 mutation 同时失效发布窗口缓存。
 */
function invalidateContractAndReleases(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: contractKeys.all });
  queryClient.invalidateQueries({ queryKey: releaseKeys.all });
}

export function useContracts() {
  return useQuery({
    queryKey: contractKeys.all,
    queryFn: listContracts,
  });
}

export function useContract(id: string) {
  return useQuery({
    queryKey: contractKeys.detail(id),
    queryFn: () => getContract(id),
    enabled: Boolean(id),
  });
}

export function useReviewChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      contractId: string;
      changeId: string;
      state: ReviewState;
      reviewer: string;
      comment: string;
    }) =>
      reviewChange(
        input.contractId,
        input.changeId,
        input.state,
        input.reviewer,
        input.comment,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useBulkReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      selections: Array<{ contractId: string; changeId: string }>;
      state: ReviewState;
      reviewer: string;
      comment: string;
    }) =>
      bulkReviewChanges(
        input.selections,
        input.state,
        input.reviewer,
        input.comment,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useUpdateOpenApi() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; openapi: string }) =>
      updateContractOpenApi(input.contractId, input.openapi),
    onSuccess: () => invalidateContractAndReleases(queryClient),
  });
}

export function useSaveContract() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveContract,
    onSuccess: () => invalidateContractAndReleases(queryClient),
  });
}

export function useAddExemption() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; changeId: string; reason: string }) =>
      addExemption(input.contractId, input.changeId, input.reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useFreezeVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; version: string; notes: string }) =>
      freezeVersion(input.contractId, input.version, input.notes),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}
