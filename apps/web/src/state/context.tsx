import { createContext, useContext } from "solid-js";
import type { JSX } from "solid-js";

import type { AgentStore } from "./store.ts";

const AgentStoreContext = createContext<AgentStore>();

export const AgentStoreProvider = (props: {
  readonly store: AgentStore;
  readonly children: JSX.Element;
}): JSX.Element => (
  <AgentStoreContext.Provider value={props.store}>{props.children}</AgentStoreContext.Provider>
);

export const useAgent = (): AgentStore => {
  const store = useContext(AgentStoreContext);
  if (store === undefined) {
    throw new Error("useAgent must be used inside <AgentStoreProvider>");
  }
  return store;
};
