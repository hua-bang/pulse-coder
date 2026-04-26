import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DEFAULT_TOAST_DURATION_MS, SHORTCUT_SECTIONS } from '../../constants/interaction';
import type { ConfirmOptions, ToastInput, ToastRecord } from '../../types/ui-interaction';
import './index.css';

interface AppShellContextValue {
  notify: (toast: ToastInput) => string;
  updateToast: (id: string, patch: Partial<Omit<ToastRecord, 'id' | 'createdAt'>>) => void;
  dismissToast: (id: string) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  shortcutsOpen: boolean;
  isOverlayOpen: boolean;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

export const AppShellProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmOptions | null>(null);
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null);
  const toastCounterRef = useRef(0);
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const scheduleDismiss = useCallback((id: string, autoCloseMs?: number) => {
    const existing = toastTimersRef.current.get(id);
    if (existing) {
      clearTimeout(existing);
      toastTimersRef.current.delete(id);
    }

    if (!autoCloseMs || autoCloseMs <= 0) return;

    const timer = setTimeout(() => {
      dismissToast(id);
    }, autoCloseMs);
    toastTimersRef.current.set(id, timer);
  }, [dismissToast]);

  const notify = useCallback((toast: ToastInput) => {
    const id = `toast-${Date.now()}-${toastCounterRef.current++}`;
    const autoCloseMs = toast.autoCloseMs ?? (toast.tone === 'loading' ? 0 : DEFAULT_TOAST_DURATION_MS);
    const record: ToastRecord = {
      id,
      createdAt: Date.now(),
      ...toast,
      autoCloseMs,
    };
    setToasts((prev) => [...prev, record]);
    scheduleDismiss(id, autoCloseMs);
    return id;
  }, [scheduleDismiss]);

  const updateToast = useCallback((id: string, patch: Partial<Omit<ToastRecord, 'id' | 'createdAt'>>) => {
    setToasts((prev) => prev.map((toast) => (
      toast.id === id
        ? { ...toast, ...patch }
        : toast
    )));
    if (Object.prototype.hasOwnProperty.call(patch, 'autoCloseMs')) {
      scheduleDismiss(id, patch.autoCloseMs);
    }
  }, [scheduleDismiss]);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    if (confirmResolverRef.current) {
      confirmResolverRef.current(false);
    }
    confirmResolverRef.current = resolve;
    setConfirmState(options);
  }), []);

  const closeConfirm = useCallback((accepted: boolean) => {
    setConfirmState(null);
    const resolve = confirmResolverRef.current;
    confirmResolverRef.current = null;
    resolve?.(accepted);
  }, []);

  const openShortcuts = useCallback(() => {
    setShortcutsOpen(true);
  }, []);

  const closeShortcuts = useCallback(() => {
    setShortcutsOpen(false);
  }, []);

  useEffect(() => () => {
    if (confirmResolverRef.current) {
      confirmResolverRef.current(false);
      confirmResolverRef.current = null;
    }
    for (const timer of toastTimersRef.current.values()) {
      clearTimeout(timer);
    }
    toastTimersRef.current.clear();
  }, []);

  const isOverlayOpen = shortcutsOpen || Boolean(confirmState);

  const value = useMemo<AppShellContextValue>(() => ({
    notify,
    updateToast,
    dismissToast,
    confirm,
    openShortcuts,
    closeShortcuts,
    shortcutsOpen,
    isOverlayOpen,
  }), [notify, updateToast, dismissToast, confirm, openShortcuts, closeShortcuts, shortcutsOpen, isOverlayOpen]);

  return (
    <AppShellContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
      {confirmState && (
        <ConfirmDialog
          options={confirmState}
          onCancel={() => closeConfirm(false)}
          onConfirm={() => closeConfirm(true)}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsDialog onClose={closeShortcuts} />
      )}
    </AppShellContext.Provider>
  );
};

export const useAppShell = (): AppShellContextValue => {
  const context = useContext(AppShellContext);
  if (!context) {
    throw new Error('useAppShell must be used within AppShellProvider');
  }
  return context;
};

const ToastViewport = ({
  toasts,
  onDismiss,
}: {
  toasts: ToastRecord[];
  onDismiss: (id: string) => void;
}) => (
  <div className="shell-toast-region" aria-live="polite" aria-atomic="true">
    {toasts.map((toast) => (
      <article key={toast.id} className={`shell-toast shell-toast--${toast.tone}`}>
        <span className="shell-toast__icon" aria-hidden="true">
          <ToastIcon tone={toast.tone} />
        </span>
        <div className="shell-toast__body">
          <div className="shell-toast__title">{toast.title}</div>
          {toast.description && (
            <div className="shell-toast__description">{toast.description}</div>
          )}
        </div>
        <button
          type="button"
          className="shell-toast__close"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      </article>
    ))}
  </div>
);

const ToastIcon = ({ tone }: { tone: ToastRecord['tone'] }) => {
  if (tone === 'loading') {
    return <span className="shell-spinner" />;
  }

  if (tone === 'error') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M7 4.2v3.5M7 9.6h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  if (tone === 'success') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M4.2 7.2l1.8 1.8 3.8-4.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 6.1v3M7 4.1h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
};

const ConfirmDialog = ({
  options,
  onCancel,
  onConfirm,
}: {
  options: ConfirmOptions;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        onConfirm();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, onConfirm]);

  const intent = options.intent ?? 'default';

  return (
    <div
      className="shell-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="shell-dialog" role="dialog" aria-modal="true" aria-labelledby="shell-confirm-title">
        <div className="shell-dialog__header">
          <div className={`shell-dialog__eyebrow${intent === 'danger' ? ' shell-dialog__eyebrow--danger' : ''}`}>
            {intent === 'danger' ? 'Confirm destructive action' : 'Confirm action'}
          </div>
          <h2 className="shell-dialog__title" id="shell-confirm-title">{options.title}</h2>
        </div>
        {options.description && (
          <div className="shell-dialog__description">{options.description}</div>
        )}
        <div className="shell-dialog__footer">
          <button type="button" className="shell-dialog__button" onClick={onCancel}>
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={`shell-dialog__button${intent === 'danger' ? ' shell-dialog__button--danger' : ' shell-dialog__button--primary'}`}
            onClick={onConfirm}
          >
            {options.confirmLabel ?? 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
};

const ShortcutsDialog = ({ onClose }: { onClose: () => void }) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="shell-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="shell-dialog shell-dialog--wide" role="dialog" aria-modal="true" aria-labelledby="shell-shortcuts-title">
        <div className="shell-dialog__header">
          <div className="shell-dialog__eyebrow">Keyboard shortcuts</div>
          <h2 className="shell-dialog__title" id="shell-shortcuts-title">Move faster across the canvas</h2>
        </div>
        <div className="shell-shortcuts__intro">
          The canvas supports a small set of global shortcuts. They stay intentionally lightweight so creation and navigation remain predictable.
        </div>
        <div className="shell-shortcuts">
          <div className="shell-shortcuts__grid">
            {SHORTCUT_SECTIONS.map((section) => (
              <section key={section.title} className="shell-shortcuts__section">
                <div className="shell-shortcuts__section-title">{section.title}</div>
                <div className="shell-shortcuts__list">
                  {section.items.map((item) => (
                    <div key={`${section.title}-${item.combo}`} className="shell-shortcuts__item">
                      <div className="shell-shortcuts__combo" aria-label={item.combo}>
                        {item.combo.split(/\s*\+\s*/).map((part) => (
                          <span key={`${item.combo}-${part}`} className="shell-shortcuts__key">{part}</span>
                        ))}
                      </div>
                      <div className="shell-shortcuts__item-description">{item.description}</div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
        <div className="shell-dialog__footer">
          <button type="button" className="shell-dialog__button shell-dialog__button--primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
