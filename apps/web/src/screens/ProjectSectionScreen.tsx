import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";

import { useAgent } from "../state/context.tsx";
import { projectPath } from "../lib/routes.ts";
import type { ProjectSection } from "../lib/routes.ts";
import { ArrowLeftIcon } from "../ui/icons.tsx";
import { cx, surface } from "../ui/primitives.tsx";
import { ConnectionsScreen } from "./ConnectionsScreen.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Connections or Settings inside a project window. The route keeps the
 * project id, so the window stays scoped to its project.
 */
const ProjectSectionScreen = (props: { readonly section: ProjectSection }): JSX.Element => {
  const store = useAgent();
  const navigate = useNavigate();
  const params = useParams<{ projectId?: string }>();
  const projectId = (): string => safeDecode(params.projectId ?? "");
  const name = (): string => store.project(projectId())?.name ?? "project";

  return (
    <div class="h-full p-2" data-testid="project-section" data-section={props.section}>
      <div class={cx("h-full overflow-y-auto", surface)}>
        <div class="mx-auto w-full max-w-[880px] px-8 pb-8 pt-4">
          <button
            type="button"
            data-testid="project-back"
            class="-ml-2 mb-4 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-body"
            onClick={() => navigate(projectPath(projectId()))}
          >
            <ArrowLeftIcon size={13} />
            <span class="max-w-[320px] truncate">Back to {name()}</span>
          </button>
          {props.section === "connections" ? <ConnectionsScreen /> : <SettingsScreen />}
        </div>
      </div>
    </div>
  );
};

export const ProjectConnectionsScreen = (): JSX.Element => (
  <ProjectSectionScreen section="connections" />
);

export const ProjectSettingsScreen = (): JSX.Element => (
  <ProjectSectionScreen section="settings" />
);
