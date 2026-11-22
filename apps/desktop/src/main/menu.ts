import { Menu, app, shell, type MenuItemConstructorOptions } from "electron";

export interface MenuActions {
  readonly show: () => void;
  readonly showLogs: () => void;
  readonly restartService: () => void;
  readonly stopService: () => void;
  readonly installService: () => void;
  readonly checkForUpdates: () => void;
  readonly installUpdate: () => void;
}

export function installApplicationMenu(actions: MenuActions): void {
  const isMac = process.platform === "darwin";
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
      label: "Ballast",
      submenu: [
        { label: "Open Ballast", accelerator: "CmdOrCtrl+O", click: actions.show },
        { type: "separator" },
        { label: "Restart Ballast Service", click: actions.restartService },
        { label: "Stop Ballast Service", click: actions.stopService },
        { label: "Install Background Service…", click: actions.installService },
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
