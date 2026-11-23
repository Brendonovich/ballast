import { Menu, app, shell, type MenuItemConstructorOptions } from "electron";
import type { ProjectMenuItem } from "../bridge.ts";

export interface MenuActions {
  readonly show: () => void;
  readonly newWindow: () => void;
  readonly openProject: (projectId: string) => void;
  readonly showLogs: () => void;
  readonly restartService: () => void;
  readonly stopService: () => void;
  readonly startService: () => void;
  readonly checkForUpdates: () => void;
  readonly installUpdate: () => void;
}

export function installApplicationMenu(
  actions: MenuActions,
  projects: ReadonlyArray<ProjectMenuItem>,
): void {
  const isMac = process.platform === "darwin";
  const projectItems: MenuItemConstructorOptions[] =
    projects.length === 0
      ? [{ label: "No Projects", enabled: false }]
      : projects.map((project) => ({
          label: project.name,
          click: () => actions.openProject(project.id),
        }));
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+N",
          click: () => actions.newWindow(),
        },
        { type: "separator" },
        { label: "Open Project", submenu: projectItems },
        { type: "separator" },
        ...(isMac ? [] : [{ role: "close" as const }]),
      ],
    },
    {
      label: "Ballast",
      submenu: [
        { label: "Open Ballast", accelerator: "CmdOrCtrl+O", click: actions.show },
        { type: "separator" },
        { label: "Start Ballast Service", click: actions.startService },
        { label: "Restart Ballast Service", click: actions.restartService },
        { label: "Stop Ballast Service", click: actions.stopService },
        { type: "separator" },
        { label: "Show Logs", click: actions.showLogs },
        { label: "Check for Updates…", click: actions.checkForUpdates },
        { label: "Install Update", click: actions.installUpdate },
        ...(isMac ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [{ role: "front" as const }] : [{ role: "close" as const }]),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Ballast on GitHub",
          click: () => {
            void shell.openExternal("https://github.com/brendonovich/ballast");
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
