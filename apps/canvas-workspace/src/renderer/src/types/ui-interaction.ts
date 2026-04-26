export type ToastTone = 'success' | 'error' | 'loading' | 'info';

export interface ToastInput {
  tone: ToastTone;
  title: string;
  description?: string;
  autoCloseMs?: number;
}

export interface ToastRecord extends ToastInput {
  id: string;
  createdAt: number;
}

export type ConfirmIntent = 'default' | 'danger';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  intent?: ConfirmIntent;
}

export interface ShortcutItem {
  combo: string;
  description: string;
}

export interface ShortcutSection {
  title: string;
  items: ShortcutItem[];
}

export interface CanvasNodeRenameRequest {
  workspaceId: string;
  nodeId: string;
  title: string;
}
