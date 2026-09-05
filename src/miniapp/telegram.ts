/**
 * Telegram Mini App chrome: WebApp typings, the native BackButton stack, the
 * unsaved-changes guard, and confirm/haptic helpers shared by every screen.
 */
import { useEffect, useRef } from "react";

export interface TelegramWebApp {
  readonly initData: string;
  readonly colorScheme: "light" | "dark";
  readonly BackButton?: {
    readonly isVisible: boolean;
    show(): void;
    hide(): void;
    onClick(listener: () => void): void;
    offClick(listener: () => void): void;
  };
  ready(): void;
  expand(): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  showConfirm?(message: string, callback: (confirmed: boolean) => void): void;
  onEvent(event: "themeChanged", listener: () => void): void;
  offEvent(event: "themeChanged", listener: () => void): void;
  readonly HapticFeedback?: {
    notificationOccurred(type: "error" | "success" | "warning"): void;
  };
}

declare global {
  interface Window {
    readonly Telegram?: { readonly WebApp: TelegramWebApp };
  }
}

const telegramApp = window.Telegram?.WebApp;
export const webApp = telegramApp?.initData ? telegramApp : undefined;
export const telegramReady = webApp !== undefined && webApp.initData.length > 0;
export const nativeTelegramNavigation = telegramReady && webApp?.BackButton !== undefined;

export function notifyHaptic(type: "error" | "success" | "warning"): void {
  webApp?.HapticFeedback?.notificationOccurred(type);
}

interface NativeBackEntry {
  readonly handler: () => void;
}

/** UI layers mount in stacking order, so the last registered handler wins. */
const nativeBackStack: NativeBackEntry[] = [];
const unsavedScopes = new Set<symbol>();
let nativeBackListening = false;
let beforeUnloadListening = false;
let closingConfirmationEnabled = false;

function handleNativeBack(): void {
  nativeBackStack.at(-1)?.handler();
}

function syncNativeBackButton(): void {
  const backButton = nativeTelegramNavigation ? webApp?.BackButton : undefined;
  if (backButton === undefined) return;
  if (nativeBackStack.length > 0) {
    if (!nativeBackListening) {
      backButton.onClick(handleNativeBack);
      nativeBackListening = true;
    }
    backButton.show();
    return;
  }
  if (nativeBackListening) {
    backButton.offClick(handleNativeBack);
    nativeBackListening = false;
  }
  backButton.hide();
}

export function useTelegramBackButton(handler: (() => void) | undefined): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabled = handler !== undefined && nativeTelegramNavigation;
  useEffect(() => {
    if (!enabled) return;
    const entry: NativeBackEntry = { handler: () => handlerRef.current?.() };
    nativeBackStack.push(entry);
    syncNativeBackButton();
    return () => {
      const index = nativeBackStack.indexOf(entry);
      if (index !== -1) nativeBackStack.splice(index, 1);
      syncNativeBackButton();
    };
  }, [enabled]);
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}

function syncUnsavedChangesGuard(): void {
  const dirty = unsavedScopes.size > 0;
  if (dirty && !beforeUnloadListening) {
    window.addEventListener("beforeunload", handleBeforeUnload);
    beforeUnloadListening = true;
  } else if (!dirty && beforeUnloadListening) {
    window.removeEventListener("beforeunload", handleBeforeUnload);
    beforeUnloadListening = false;
  }

  if (!telegramReady) return;
  if (dirty && !closingConfirmationEnabled) {
    webApp?.enableClosingConfirmation?.();
    closingConfirmationEnabled = true;
  } else if (!dirty && closingConfirmationEnabled) {
    webApp?.disableClosingConfirmation?.();
    closingConfirmationEnabled = false;
  }
}

export function useUnsavedChanges(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const id = Symbol("unsaved-changes");
    unsavedScopes.add(id);
    syncUnsavedChangesGuard();
    return () => {
      unsavedScopes.delete(id);
      syncUnsavedChangesGuard();
    };
  }, [dirty]);
}

export function confirmDiscardChanges(message = "Discard your unsaved changes?"): Promise<boolean> {
  if (telegramReady && webApp?.showConfirm !== undefined) {
    return new Promise((resolve) => {
      try {
        webApp?.showConfirm?.(message, resolve);
      } catch {
        resolve(window.confirm(message));
      }
    });
  }
  return Promise.resolve(window.confirm(message));
}

export function navigateWithUnsavedGuard(action: () => void): void {
  if (unsavedScopes.size === 0) {
    action();
    return;
  }
  void confirmDiscardChanges().then((confirmed) => {
    if (confirmed) action();
  });
}
