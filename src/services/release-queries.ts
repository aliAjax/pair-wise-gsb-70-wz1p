import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  armFailNextCommit,
  closeWindow,
  getWindow,
  listWindows,
  openWindow,
  recoverWindow,
  resetVoidedGate,
  submitReceipt,
  type SubmitReceiptInput,
} from './release-service';

export const releaseKeys = {
  all: ['release-windows'] as const,
  detail: (id: string) => ['release-windows', id] as const,
};

export function useWindows() {
  return useQuery({
    queryKey: releaseKeys.all,
    queryFn: listWindows,
  });
}

export function useWindow(id: string) {
  return useQuery({
    queryKey: releaseKeys.detail(id),
    queryFn: () => getWindow(id),
    enabled: Boolean(id),
  });
}

export function useOpenWindow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; contractIds: string[] }) =>
      openWindow(input.name, input.contractIds),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: releaseKeys.all }),
  });
}

export function useCloseWindow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (windowId: string) => closeWindow(windowId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: releaseKeys.all }),
  });
}

export function useSubmitReceipt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SubmitReceiptInput) => submitReceipt(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: releaseKeys.all }),
  });
}

export function useResetGate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { windowId: string; gateId: string }) =>
      resetVoidedGate(input.windowId, input.gateId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: releaseKeys.all }),
  });
}

export function useRecoverWindow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (windowId: string) => recoverWindow(windowId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: releaseKeys.all }),
  });
}

export function useArmFailNextCommit() {
  return useMutation({
    mutationFn: async () => {
      armFailNextCommit();
    },
  });
}
