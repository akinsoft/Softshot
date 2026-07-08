import { contextBridge, ipcRenderer } from "electron";
import type { OverlayBootstrap, SaveResult, SoftshotApi } from "./shared";

const api: SoftshotApi = {
  getBootstrap: () => ipcRenderer.invoke("overlay:get-bootstrap") as Promise<OverlayBootstrap>,
  saveScreenshot: (dataUrl: string) =>
    ipcRenderer.invoke("capture:save-screenshot", dataUrl) as Promise<SaveResult>,
  copyScreenshot: (dataUrl: string) => ipcRenderer.invoke("capture:copy-screenshot", dataUrl) as Promise<void>,
  saveVideo: (bytes: Uint8Array) =>
    ipcRenderer.invoke("capture:save-video", bytes) as Promise<SaveResult>,
  readyToShow: () => ipcRenderer.invoke("overlay:ready-to-show") as Promise<void>,
  closeOverlay: () => ipcRenderer.invoke("overlay:close") as Promise<void>,
  showError: (message: string) => ipcRenderer.invoke("overlay:show-error", message) as Promise<void>
};

contextBridge.exposeInMainWorld("softshot", api);
