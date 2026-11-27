import { HashRouter, Route, useParams } from "@solidjs/router";
import { Show } from "solid-js";
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
import { ProjectConnectionsScreen } from "./screens/ProjectSectionScreen.tsx";

/**
 * Re-scoping a window changes only the route's project id. Remount the
 * workspace so every pane (source, logs, outline) starts from the new project.
 */
const ProjectRoute = (): JSX.Element => {
  const params = useParams<{ projectId?: string }>();
  return (
    <Show when={params.projectId} keyed>
      {(projectId) => <ProjectScreen projectId={projectId} />}
    </Show>
  );
};

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
      <Route path="/projects/:projectId" component={ProjectRoute} />
      <Route path="/connections" component={ConnectionsScreen} />
      <Route path="/settings" component={SettingsScreen} />
      <Route path="*" component={ProjectsScreen} />
    </HashRouter>
    <ErrorToasts />
  </AgentStoreProvider>
);
