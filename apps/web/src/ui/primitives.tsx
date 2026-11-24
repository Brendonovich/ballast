import { For, Show, createEffect, onCleanup, onMount, splitProps } from "solid-js";
import type { JSX } from "solid-js";

import { ChevronDownIcon, CloseIcon } from "./icons.tsx";

export const cx = (...values: ReadonlyArray<string | false | null | undefined>): string =>
  values.filter((value): value is string => typeof value === "string" && value.length > 0).join(" ");

export type ButtonVariant = "primary" | "neutral" | "outline" | "ghost" | "danger";
export type ButtonSize = "small" | "normal";

const buttonBase =
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-45";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-strong text-canvas hover:opacity-90",
  neutral:
    "bg-layer text-body shadow-[var(--v2-elevation-button-neutral)] hover:bg-layer-2",
  outline:
    "border border-edge-strong bg-transparent text-body hover:bg-hover",
  ghost: "bg-transparent text-muted hover:bg-hover hover:text-body",
  danger: "bg-[var(--v2-state-bg-danger)] text-danger hover:opacity-90",
};

const buttonSizes: Record<ButtonSize, string> = {
  small: "h-6 px-2 text-[12px]",
  normal: "h-7 px-2.5 text-[13px]",
};

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean | undefined;
  readonly icon?: JSX.Element | undefined;
}

export const Button = (props: ButtonProps): JSX.Element => {
  const [local, rest] = splitProps(props, [
    "variant",
    "size",
    "loading",
    "icon",
    "class",
    "children",
    "disabled",
    "type",
  ]);
  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      disabled={local.disabled === true || local.loading === true}
      class={cx(
        buttonBase,
        buttonVariants[local.variant ?? "neutral"],
        buttonSizes[local.size ?? "normal"],
        local.class,
      )}
    >
      <Show when={local.loading} fallback={local.icon}>
        <Spinner size={12} />
      </Show>
      {local.children}
    </button>
  );
};

export const IconButton = (props: {
  readonly label: string;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly variant?: ButtonVariant;
  readonly size?: "small" | "normal";
  readonly class?: string;
  readonly testId?: string;
  readonly children: JSX.Element;
}): JSX.Element => (
  <button
    type="button"
    aria-label={props.label}
    title={props.label}
    data-testid={props.testId}
    disabled={props.disabled}
    onClick={props.onClick}
    class={cx(
      "inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-45",
      buttonVariants[props.variant ?? "ghost"],
      props.size === "small" ? "size-6" : "size-7",
      props.class,
    )}
  >
    {props.children}
  </button>
);

export const Spinner = (props: { readonly size?: number; readonly class?: string }): JSX.Element => (
  <span
    class={cx("spinner inline-block shrink-0", props.class)}
    style={{ width: `${props.size ?? 13}px`, height: `${props.size ?? 13}px` }}
    aria-hidden="true"
  />
);

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const dotTone: Record<Tone, string> = {
  neutral: "bg-faint",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

/**
 * A raised pane on the window background, as in OpenCode's desktop app
 * (packages/app/src/session/session-frame.tsx): 10px corners, the base
 * background and the raised elevation, which draws the hairline border.
 */
export const surface = "rounded-[10px] bg-canvas shadow-[var(--v2-elevation-raised)]";

export const StatusDot = (props: {
  readonly tone: Tone;
  readonly pulse?: boolean;
  readonly class?: string;
}): JSX.Element => (
  <span
    aria-hidden="true"
    class={cx(
      "inline-block size-1.5 shrink-0 rounded-full",
      dotTone[props.tone],
      props.pulse === true && "animate-pulse",
      props.class,
    )}
  />
);

export const Status = (props: {
  readonly tone: Tone;
  readonly children: JSX.Element;
  readonly class?: string;
}): JSX.Element => (
  <span class={cx("inline-flex items-center gap-1.5 text-[12px] text-muted", props.class)}>
    <StatusDot tone={props.tone} />
    {props.children}
  </span>
);

export const PageHeader = (props: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly actions?: JSX.Element | undefined;
}): JSX.Element => (
  <header class="flex items-start justify-between gap-6">
    <div class="min-w-0">
      <h1 class="text-[20px] font-medium leading-7 tracking-[-0.02em] text-strong">
        {props.title}
      </h1>
      <Show when={props.description}>
        <p class="mt-1 text-[13px] text-muted">{props.description}</p>
      </Show>
    </div>
    <Show when={props.actions}>
      <div class="flex shrink-0 items-center gap-2">{props.actions}</div>
    </Show>
  </header>
);

export const Section = (props: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: JSX.Element;
  readonly children: JSX.Element;
  readonly class?: string;
}): JSX.Element => (
  <section class={cx("mt-8", props.class)}>
    <div class="flex items-end justify-between gap-4">
      <div>
        <h2 class="text-[14px] font-medium text-strong">{props.title}</h2>
        <Show when={props.description}>
          <p class="mt-1 text-[12px] text-muted">{props.description}</p>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class="flex shrink-0 items-center gap-2">{props.actions}</div>
      </Show>
    </div>
    <div class="mt-3">{props.children}</div>
  </section>
);

const inputClass =
  "h-7 w-full rounded-md bg-canvas px-2 text-[13px] text-body placeholder:text-faint shadow-[var(--v2-elevation-input)] outline-none transition-shadow hover:bg-hover focus:shadow-[0_0_0_1px_var(--v2-border-border-focus)] disabled:opacity-50";

export const TextInput = (props: JSX.InputHTMLAttributes<HTMLInputElement>): JSX.Element => (
  <input {...props} class={cx(inputClass, props.class)} />
);

export const SelectInput = (
  props: JSX.SelectHTMLAttributes<HTMLSelectElement> & { readonly children: JSX.Element },
): JSX.Element => {
  const [local, rest] = splitProps(props, ["class", "children"]);
  let element: HTMLSelectElement | undefined;
  createEffect(() => {
    const value = rest.value;
    if (element !== undefined && value !== undefined) element.value = String(value);
  });
  return (
    <div class="relative min-w-0">
      <select ref={element} {...rest} class={cx(inputClass, "appearance-none pr-7", local.class)}>
        {local.children}
      </select>
      <ChevronDownIcon
        size={12}
        class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint"
      />
    </div>
  );
};

export const Switch = (props: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly label: string;
}): JSX.Element => (
  <button
    type="button"
    role="switch"
    aria-checked={props.checked}
    aria-label={props.label}
    disabled={props.disabled}
    onClick={() => props.onChange(!props.checked)}
    class={cx(
      "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-40",
      props.checked ? "bg-accent" : "bg-[var(--v2-border-border-strong)]",
    )}
  >
    <span
      class={cx(
        "absolute size-3 rounded-full bg-white shadow-sm transition-transform",
        props.checked ? "translate-x-[14px]" : "translate-x-[2px]",
      )}
    />
  </button>
);

export const Field = (props: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly children: JSX.Element;
  readonly class?: string;
}): JSX.Element => (
  <div class={cx("space-y-1", props.class)}>
    <span class="block text-[12px] text-muted">{props.label}</span>
    {props.children}
    <Show when={props.error}>
      <p class="text-[11px] text-danger">{props.error}</p>
    </Show>
    <Show when={props.hint}>
      <p class="text-[11px] text-faint">{props.hint}</p>
    </Show>
  </div>
);

export interface TabItem {
  readonly id: string;
  readonly label: string;
}

export const Tabs = (props: {
  readonly items: ReadonlyArray<TabItem>;
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly class?: string;
}): JSX.Element => (
  <div
    role="tablist"
    aria-label="Script sections"
    class={cx("flex items-center gap-4 border-b border-edge", props.class)}
  >
    <For each={props.items}>
      {(item) => (
        <button
          type="button"
          role="tab"
          aria-selected={props.value === item.id}
          data-testid={`tab-${item.id}`}
          onClick={() => props.onChange(item.id)}
          class={cx(
            "relative -mb-px h-9 border-b text-[13px] transition-colors",
            props.value === item.id
              ? "border-strong text-strong"
              : "border-transparent text-muted hover:text-body",
          )}
        >
          {item.label}
        </button>
      )}
    </For>
  </div>
);

const focusableSelector =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const Dialog = (props: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly onClose: () => void;
  readonly children: JSX.Element;
  readonly footer?: JSX.Element;
  readonly width?: "sm" | "md";
}): JSX.Element => {
  let panel: HTMLDivElement | undefined;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key !== "Tab" || panel === undefined) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  onMount(() => {
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
    queueMicrotask(() => panel?.querySelector<HTMLElement>(focusableSelector)?.focus());
  });

  return (
    <div
      class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[var(--v2-overlay-simple-overlay-scrim)] p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        class={cx(
          "animate-in w-full rounded-lg border border-edge-strong bg-layer shadow-[var(--v2-elevation-overlay)]",
          props.width === "sm" ? "max-w-sm" : "max-w-md",
        )}
      >
        <header class="flex items-start justify-between gap-4 px-4 pb-3 pt-4">
          <div class="min-w-0">
            <h2 class="text-[14px] font-medium text-strong">{props.title}</h2>
            <Show when={props.description}>
              <p class="mt-1 text-[12px] text-muted">{props.description}</p>
            </Show>
          </div>
          <IconButton label="Close" onClick={props.onClose}>
            <CloseIcon size={14} />
          </IconButton>
        </header>
        <div class="px-4 pb-4">{props.children}</div>
        <Show when={props.footer}>
          <footer class="flex items-center justify-end gap-2 border-t border-edge px-4 py-3">
            {props.footer}
          </footer>
        </Show>
      </div>
    </div>
  );
};

export const ConfirmDialog = (props: {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly pending?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): JSX.Element => (
  <Dialog
    title={props.title}
    description={props.description}
    onClose={props.onCancel}
    width="sm"
    footer={
      <>
        <Button size="normal" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="normal" variant="danger" loading={props.pending} onClick={props.onConfirm}>
          {props.confirmLabel}
        </Button>
      </>
    }
  >
    <p class="text-[12px] text-muted">This action cannot be undone.</p>
  </Dialog>
);

export const EmptyState = (props: {
  readonly title: string;
  readonly description?: string;
  readonly action?: JSX.Element;
  readonly class?: string;
}): JSX.Element => (
  <div class={cx("py-16 text-center", props.class)}>
    <p class="text-[13px] text-muted">{props.title}</p>
    <Show when={props.description}>
      <p class="mx-auto mt-1 max-w-sm text-[12px] text-faint">{props.description}</p>
    </Show>
    <Show when={props.action}>
      <div class="mt-4 flex justify-center">{props.action}</div>
    </Show>
  </div>
);

