import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell
} from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OverlayBootstrap, SaveResult } from "./shared";

const appName = "Softshot";
const primaryShortcut = "PrintScreen";
const backupShortcuts = ["Control+Shift+PrintScreen", "Control+Alt+S"] as const;

let tray: Tray | null = null;
let activeOverlay: BrowserWindow | null = null;
let printScreenUnavailable = false;
let registeredShortcuts: string[] = [];

const overlayDataByWebContents = new Map<number, OverlayBootstrap>();
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    capture();
  });

  app.whenReady().then(async () => {
    app.setName(appName);
    registerIpcHandlers();
    registerCaptureShortcuts();
    createTray();
    await showShortcutWarningIfNeeded();
    if (process.env.SOFTSHOT_CAPTURE_ON_READY === "1") {
      setTimeout(capture, 300);
    }
  });
}

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => undefined);

function registerCaptureShortcuts(): void {
  if (registerCaptureShortcut(primaryShortcut)) {
    registeredShortcuts = [primaryShortcut];
    return;
  }

  printScreenUnavailable = true;
  registeredShortcuts = backupShortcuts.filter(registerCaptureShortcut);
}

function registerCaptureShortcut(shortcut: string): boolean {
  return globalShortcut.register(shortcut, capture);
}

function capture(): void {
  debugLog("capture requested");
  void openOverlay().catch((error: unknown) => {
    void showError("Could not open the capture overlay.", error);
  });
}

async function showShortcutWarningIfNeeded(): Promise<void> {
  if (!printScreenUnavailable || process.env.SOFTSHOT_SKIP_SHORTCUT_WARNING === "1") {
    return;
  }

  const fallbackText = registeredShortcuts.length > 0
    ? `Softshot is still running. Use ${registeredShortcuts.join(" or ")} for now, or use Capture from the tray menu.`
    : "Softshot is still running, but no keyboard shortcut could be registered. Use Capture from the tray menu.";

  const result = await dialog.showMessageBox({
    type: "warning",
    title: appName,
    message: `${appName} could not register the ${primaryShortcut} key.`,
    detail: `${fallbackText}\n\nTo let Softshot use PrintScreen, turn off Windows Settings > Accessibility > Keyboard > Use the Print screen key to open screen capture, close other screenshot apps, then restart Softshot.`,
    buttons: ["Open settings", "OK"],
    defaultId: 1,
    cancelId: 1
  });

  if (result.response === 0) {
    await openKeyboardSettings();
  }
}

async function openKeyboardSettings(): Promise<void> {
  try {
    await shell.openExternal("ms-settings:easeofaccess-keyboard");
  } catch (error) {
    await showError("Could not open Windows keyboard settings.", error);
  }
}

function registerIpcHandlers(): void {
  ipcHandle("overlay:get-bootstrap", (event) => {
    const data = overlayDataByWebContents.get(event.sender.id);
    if (!data) {
      throw new Error("Missing overlay bootstrap data.");
    }

    return data;
  });

  ipcHandle("overlay:close", (event) => {
    closeSenderWindow(event);
  });

  ipcHandle("overlay:ready-to-show", (event) => {
    const overlay = BrowserWindow.fromWebContents(event.sender);
    if (!overlay || overlay.isDestroyed()) {
      return;
    }

    debugLog("overlay ready to show");
    overlay.show();
    overlay.setFullScreen(true);
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.focus();
  });

  ipcHandle("overlay:show-error", async (_event, message: string) => {
    await dialog.showMessageBox({
      type: "error",
      title: appName,
      message
    });
  });

  ipcHandle("capture:save-screenshot", async (event, dataUrl: string): Promise<SaveResult> => {
    const buffer = pngBufferFromDataUrl(dataUrl);
    const filePath = await writeCaptureFile("pictures", "png", buffer);
    clipboard.writeImage(nativeImage.createFromBuffer(buffer));
    notifySaved("Screenshot saved", filePath);
    closeSenderWindow(event);
    return { filePath };
  });

  ipcHandle("capture:copy-screenshot", (event, dataUrl: string): void => {
    const buffer = pngBufferFromDataUrl(dataUrl);
    clipboard.writeImage(nativeImage.createFromBuffer(buffer));
    closeSenderWindow(event);
  });

  ipcHandle("capture:save-video", async (event, bytes: Uint8Array): Promise<SaveResult> => {
    if (!bytes.byteLength) {
      throw new Error("Cannot save an empty recording.");
    }

    const filePath = await writeCaptureFile("videos", "webm", Buffer.from(bytes));
    notifySaved("Recording saved", filePath);
    closeSenderWindow(event);
    return { filePath };
  });
}

async function openOverlay(): Promise<void> {
  if (activeOverlay && !activeOverlay.isDestroyed()) {
    debugLog("focusing existing overlay");
    activeOverlay.focus();
    return;
  }

  debugLog("creating overlay");
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const source = await getDesktopSourceForDisplay(display.id, display.bounds.width, display.bounds.height, display.scaleFactor);
  const imageDataUrl = source.thumbnail.toDataURL();
  debugLog(`captured thumbnail ${source.thumbnail.getSize().width}x${source.thumbnail.getSize().height}`);

  const overlay = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: true,
    fullscreen: true,
    fullscreenable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#050506",
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  overlay.setFullScreen(true);
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setContentProtection(true);
  wireOverlayDiagnostics(overlay);

  activeOverlay = overlay;
  const overlayWebContentsId = overlay.webContents.id;
  const readinessTimeout = setTimeout(() => {
    if (overlay.isDestroyed() || overlay.isVisible()) {
      return;
    }

    debugLog("overlay readiness timed out");
    overlay.close();
    void showError("Could not open the capture overlay.", new Error("The overlay did not become ready in time."));
  }, 3000);

  overlay.once("show", () => {
    clearTimeout(readinessTimeout);
  });

  overlayDataByWebContents.set(overlayWebContentsId, {
    sourceId: source.id,
    imageDataUrl,
    displayBounds: {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height
    },
    scaleFactor: display.scaleFactor
  });

  overlay.on("closed", () => {
    clearTimeout(readinessTimeout);
    debugLog("overlay closed");
    overlayDataByWebContents.delete(overlayWebContentsId);
    if (activeOverlay === overlay) {
      activeOverlay = null;
    }
  });

  await overlay.loadFile(path.join(app.getAppPath(), "src", "overlay.html"));
  debugLog("overlay html loaded");
}

async function getDesktopSourceForDisplay(
  displayId: number,
  width: number,
  height: number,
  scaleFactor: number
) {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    fetchWindowIcons: false,
    thumbnailSize: {
      width: Math.round(width * scaleFactor),
      height: Math.round(height * scaleFactor)
    }
  });

  const source = sources.find((candidate) => candidate.display_id === String(displayId));
  if (source) {
    return requireUsableThumbnail(source);
  }

  if (sources.length === 1) {
    return requireUsableThumbnail(sources[0]);
  }

  const availableIds = sources.map((candidate) => candidate.display_id || "(empty)").join(", ");
  throw new Error(`Could not match display ${displayId} to a screen source. Available display ids: ${availableIds}.`);
}

function requireUsableThumbnail<T extends Electron.DesktopCapturerSource>(source: T): T {
  const size = source.thumbnail.getSize();
  if (source.thumbnail.isEmpty() || size.width <= 0 || size.height <= 0) {
    throw new Error(`Could not capture a frozen frame for ${source.name}.`);
  }

  return source;
}

function wireOverlayDiagnostics(overlay: BrowserWindow): void {
  if (process.env.SOFTSHOT_DEBUG !== "1") {
    return;
  }

  overlay.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    debugLog(`renderer console level=${level} ${sourceId}:${line} ${message}`);
  });

  overlay.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    debugLog(`renderer did-fail-load code=${errorCode} description=${errorDescription} url=${validatedUrl}`);
  });

  overlay.webContents.on("render-process-gone", (_event, details) => {
    debugLog(`renderer gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
}

function debugLog(message: string): void {
  if (process.env.SOFTSHOT_DEBUG !== "1") {
    return;
  }

  console.log(`[softshot] ${message}`);
}

async function writeCaptureFile(folderName: "pictures" | "videos", extension: "png" | "webm", data: Buffer): Promise<string> {
  const targetDirectory = path.join(app.getPath(folderName), appName);
  await mkdir(targetDirectory, { recursive: true });

  const filePath = path.join(targetDirectory, `Softshot ${timestamp()}.${extension}`);
  await writeFile(filePath, data);
  return filePath;
}

function pngBufferFromDataUrl(dataUrl: string): Buffer {
  if (!dataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("Screenshots must be PNG data URLs.");
  }

  return Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
}

function closeSenderWindow(event: Electron.IpcMainInvokeEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) {
    return;
  }

  window.close();
}

function createTray(): void {
  tray = new Tray(createTrayImage());
  tray.setToolTip(`${appName} - ${currentShortcutLabel()}`);
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
}

function trayMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Capture",
      accelerator: registeredShortcuts[0],
      click: capture
    }
  ];

  if (printScreenUnavailable) {
    template.push(
      {
        label: `${primaryShortcut} unavailable`,
        enabled: false
      },
      {
        label: "Open keyboard settings",
        click: () => {
          void openKeyboardSettings();
        }
      }
    );
  }

  template.push(
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit()
    }
  );

  return template;
}

function createTrayImage() {
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect x="4" y="7" width="24" height="18" rx="5" fill="#111827"/>
      <path d="M11 7l2-3h6l2 3" fill="#111827"/>
      <rect x="8" y="11" width="16" height="10" rx="3" fill="#38bdf8"/>
      <circle cx="16" cy="16" r="4" fill="#0f172a"/>
    </svg>
  `);

  const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
  image.setTemplateImage(false);
  return image;
}

function notifySaved(title: string, filePath: string): void {
  if (!Notification.isSupported()) {
    return;
  }

  new Notification({
    title,
    body: filePath
  }).show();
}

async function showError(message: string, error?: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : undefined;
  await dialog.showMessageBox({
    type: "error",
    title: appName,
    message,
    detail
  });
}

function currentShortcutLabel(): string {
  return registeredShortcuts.length > 0 ? registeredShortcuts.join(" or ") : "tray capture";
}

function timestamp(): string {
  const value = new Date();
  const pad = (part: number) => part.toString().padStart(2, "0");

  return [
    value.getFullYear(),
    pad(value.getMonth() + 1),
    pad(value.getDate())
  ].join("-") + " " + [
    pad(value.getHours()),
    pad(value.getMinutes()),
    pad(value.getSeconds())
  ].join(".");
}

function ipcHandle<T extends unknown[], R>(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: T) => R | Promise<R>
): void {
  ipcMain.handle(channel, listener);
}
