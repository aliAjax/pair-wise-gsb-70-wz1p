import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  closeWindow,
  listWindows,
  openWindow,
  recoverWindows,
  setFailNextSave,
  submitReceipt,
  type OpenWindowRequest,
  type SubmitReceiptRequest,
} from './window-service';

export const windowKeys = {
  all: ['release-windows'] as const,
};

export function useWindows() {
  return useQuery({
    queryKey: windowKeys.all,
    queryFn: listWindows,
  });
}

export function useOpenWindow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: OpenWindowRequest) => openWindow(request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: windowKeys.all }),
  });
}

export function useSubmitReceipt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: SubmitReceiptRequest) => submitReceipt(request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: windowKeys.all }),
  });
}

export function useCloseWindow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (windowId: string) => closeWindow(windowId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: windowKeys.all }),
  });
}

export function useRecoverWindows() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => recoverWindows(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: windowKeys.all }),
  });
}

export function useSetFailNextSave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fail: boolean) => setFailNextSave(fail),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: windowKeys.all }),
  });
}
