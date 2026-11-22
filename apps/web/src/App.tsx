import { HashRouter, Route } from "@solidjs/router";
import type { JSX } from "solid-js";

import type { AgentStore } from "./state/store.ts";
import { AgentStoreProvider } from "./state/context.tsx";
import { AppShell } from "./layout/AppShell.tsx";
import { ErrorToasts } from "./ui/toast.tsx";
import { ScriptsScreen } from "./screens/ScriptsScreen.tsx";
import { ScriptDetailScreen } from "./screens/ScriptDetailScreen.tsx";
import { ConnectionsScreen } from "./screens/ConnectionsScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";

export const App = (props: { readonly store: AgentStore }): JSX.Element => (
  <AgentStoreProvider store={props.store}>
    <HashRouter root={AppShell}>
      <Route path="/" component={ScriptsScreen} />
      <Route path="/scripts" component={ScriptsScreen} />
      <Route path="/scripts/:projectId/:scriptId" component={ScriptDetailScreen} />
      <Route path="/connections" component={ConnectionsScreen} />
      <Route path="/settings" component={SettingsScreen} />
      <Route path="*" component={ScriptsScreen} />
    </HashRouter>
    <ErrorToasts />
  </AgentStoreProvider>
);
