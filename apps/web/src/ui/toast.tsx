import { For, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { CloseIcon } from "./icons.tsx";

interface ToastItem {
  readonly id: number;
  readonly title: string;
  readonly message?: string;
}

const [errors, setErrors] = createSignal<ReadonlyArray<ToastItem>>([]);
let nextId = 1;

const dismiss = (id: number): void => {
  setErrors((current) => current.filter((item) => item.id !== id));
};

export const toast = {
  error: (title: string, message?: string): void => {
    const item: ToastItem = {
      id: nextId++,
      title,
      ...(message === undefined || message === "" ? {} : { message }),
    };
    setErrors((current) => [...current.slice(-2), item]);
    setTimeout(() => dismiss(item.id), 7_000);
  },
};

export const ErrorToasts = (): JSX.Element => (
  <div
    class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[320px] flex-col gap-2"
    aria-live="assertive"
  >
    <For each={errors()}>
      {(item) => (
        <div
          class="animate-in pointer-events-auto rounded-md border border-[var(--v2-state-border-danger)] bg-[var(--v2-state-bg-danger)] px-3 py-2.5 text-[12px] text-[var(--v2-state-fg-danger)] shadow-[var(--v2-elevation-floating)]"
          role="alert"
        >
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <p class="font-medium">{item.title}</p>
              {item.message !== undefined && (
                <p class="mt-0.5 break-words opacity-90">{item.message}</p>
              )}
            </div>
            <button
              type="button"
              class="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
              aria-label="Dismiss error"
              onClick={() => dismiss(item.id)}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        </div>
      )}
    </For>
  </div>
);
