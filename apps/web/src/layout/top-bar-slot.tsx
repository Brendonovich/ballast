import { Show, createContext, useContext } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { Portal } from "solid-js/web";

/**
 * The project window has one top bar. The shell owns it; the project screen
 * owns its actions (sidebar toggle, Restart, Start/Stop) and renders them into
 * this slot so there is no second header row.
 */
export const TopBarSlotContext = createContext<Accessor<HTMLElement | undefined>>(
  () => undefined,
);

export const TopBarActions = (props: { readonly children: JSX.Element }): JSX.Element => {
  const slot = useContext(TopBarSlotContext);
  return (
    <Show when={slot()}>
      {(element) => (
        <Portal mount={element()}>
          <div class="flex items-center gap-1">
            {props.children}
            <span class="mx-1 h-4 w-px bg-[var(--v2-border-border-base)]" aria-hidden="true" />
          </div>
        </Portal>
      )}
    </Show>
  );
};
