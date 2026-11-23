import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { BRIDGE_CHANNELS, BRIDGE_VERSION, type BallastBridge, type ServiceStatus, type UpdateState } from "../bridge.ts";

const bridge: BallastBridge = {
  version: BRIDGE_VERSION,
  service: {
    status: () => ipcRenderer.invoke(BRIDGE_CHANNELS.serviceStatus),
    start: () => ipcRenderer.invoke(BRIDGE_CHANNELS.serviceStart),
    stop: () => ipcRenderer.invoke(BRIDGE_CHANNELS.serviceStop),
    restart: () => ipcRenderer.invoke(BRIDGE_CHANNELS.serviceRestart),
  },
  permissions: {
    status: () => ipcRenderer.invoke(BRIDGE_CHANNELS.permissionsStatus),
    requestAccessibility: () => ipcRenderer.invoke(BRIDGE_CHANNELS.permissionsRequestAccessibility),
  },
  update: {
    status: () => ipcRenderer.invoke(BRIDGE_CHANNELS.updateStatus),
    install: () => ipcRenderer.invoke(BRIDGE_CHANNELS.updateInstall),
  },
  app: {
    info: () => ipcRenderer.invoke(BRIDGE_CHANNELS.appInfo),
    openUi: () => ipcRenderer.invoke(BRIDGE_CHANNELS.appOpenUi),
    retry: () => ipcRenderer.invoke(BRIDGE_CHANNELS.appRetry),
    showLogs: () => ipcRenderer.invoke(BRIDGE_CHANNELS.appShowLogs),
    openExternal: (url: string) => ipcRenderer.invoke(BRIDGE_CHANNELS.appOpenExternal, url),
    pickDirectory: () => ipcRenderer.invoke(BRIDGE_CHANNELS.appPickDirectory),
  },
  events: {
    onServiceStatus(listener: (status: ServiceStatus) => void) {
      const handler = (_event: IpcRendererEvent, status: ServiceStatus) => listener(status);
      ipcRenderer.on(BRIDGE_CHANNELS.serviceStatusEvent, handler);
      return () => {
        ipcRenderer.removeListener(BRIDGE_CHANNELS.serviceStatusEvent, handler);
      };
    },
    onUpdateStatus(listener: (state: UpdateState) => void) {
      const handler = (_event: IpcRendererEvent, state: UpdateState) => listener(state);
      ipcRenderer.on(BRIDGE_CHANNELS.updateStatusEvent, handler);
      return () => {
        ipcRenderer.removeListener(BRIDGE_CHANNELS.updateStatusEvent, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld("ballast", bridge);
