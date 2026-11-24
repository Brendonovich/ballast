import { HashRouter, Route } from "@solidjs/router";
import type { JSX } from "solid-js";

import type { AgentStore } from "./state/store.ts";
import { AgentStoreProvider } from "./state/context.tsx";
import { AppShell } from "./layout/AppShell.tsx";
import { ErrorToasts } from "./ui/toast.tsx";
import { ProjectsScreen } from "./screens/ProjectsScreen.tsx";
import { ProjectScreen } from "./screens/ProjectScreen.tsx";
import { ArtifactWindowScreen } from "./screens/ArtifactWindowScreen.tsx";
import { ConnectionsScreen } from "./screens/ConnectionsScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import {
  ProjectConnectionsScreen,
  ProjectSettingsScreen,
} from "./screens/ProjectSectionScreen.tsx";

export const App = (props: { readonly store: AgentStore }): JSX.Element => (
  <AgentStoreProvider store={props.store}>
    <HashRouter root={AppShell}>
      <Route path="/" component={ProjectsScreen} />
      <Route path="/projects" component={ProjectsScreen} />
      <Route
        path="/projects/:projectId/artifacts/:artifact"
        component={ArtifactWindowScreen}
      />
      <Route path="/projects/:projectId/connections" component={ProjectConnectionsScreen} />
      <Route path="/projects/:projectId/settings" component={ProjectSettingsScreen} />
      <Route path="/projects/:projectId" component={ProjectScreen} />
      <Route path="/connections" component={ConnectionsScreen} />
      <Route path="/settings" component={SettingsScreen} />
      <Route path="*" component={ProjectsScreen} />
    </HashRouter>
    <ErrorToasts />
  </AgentStoreProvider>
);
