import { Show, createContext, useContext } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { Portal } from "solid-js/web";

/**
 * The project window has one top bar. The shell owns it; the project screen
 * owns its actions (Start/Stop, the sidebar toggle) and renders them into
 * this slot so there is no second header row.
 */
export const TopBarSlotContext = createContext<Accessor<HTMLElement | undefined>>(
  () => undefined,
);

/** The top bar's centered slot, for the project's View / Develop switch. */
export const TopBarCenterContext = createContext<Accessor<HTMLElement | undefined>>(
  () => undefined,
);

/** The top bar's far-right slot, for the project sidebar toggle. */
export const TopBarEndContext = createContext<Accessor<HTMLElement | undefined>>(
  () => undefined,
);

export const TopBarActions = (props: { readonly children: JSX.Element }): JSX.Element => {
  const slot = useContext(TopBarSlotContext);
  return (
    <Show when={slot()}>
      {(element) => (
        <Portal mount={element()}>
          <div class="flex h-7 items-center gap-1">
            {props.children}
            <span class="ml-1 h-4 w-px bg-[var(--v2-border-border-base)]" aria-hidden="true" />
          </div>
        </Portal>
      )}
    </Show>
  );
};

export const TopBarEnd = (props: { readonly children: JSX.Element }): JSX.Element => {
  const slot = useContext(TopBarEndContext);
  return (
    <Show when={slot()}>
      {(element) => <Portal mount={element()}>{props.children}</Portal>}
    </Show>
  );
};

export const TopBarCenter = (props: { readonly children: JSX.Element }): JSX.Element => {
  const slot = useContext(TopBarCenterContext);
  return (
    <Show when={slot()}>
      {(element) => <Portal mount={element()}>{props.children}</Portal>}
    </Show>
  );
};
