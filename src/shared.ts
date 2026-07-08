export type CaptureMode = "screenshot" | "video";
export type DrawingTool = "select" | "pen" | "arrow";
export type VideoQuality = "720p" | "1080p";
export type VideoFps = 30 | 60;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayBootstrap {
  sourceId: string;
  imageDataUrl: string;
  displayBounds: Rect;
  scaleFactor: number;
}

export interface SaveResult {
  filePath: string;
}

export interface SoftshotApi {
  getBootstrap(): Promise<OverlayBootstrap>;
  saveScreenshot(dataUrl: string): Promise<SaveResult>;
  copyScreenshot(dataUrl: string): Promise<void>;
  saveVideo(bytes: Uint8Array): Promise<SaveResult>;
  readyToShow(): Promise<void>;
  closeOverlay(): Promise<void>;
  showError(message: string): Promise<void>;
}
