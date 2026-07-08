import { getCanvasContext, getRequiredElement, loadImage } from "./overlay-dom.js";
import { drawAnnotations, drawArrow, drawSelectionFrame } from "./overlay-drawing.js";
import {
  clampPointToRect,
  defaultCaptureMode,
  defaultDrawingTool,
  defaultPenColor,
  defaultVideoQuality,
  distance,
  eventPoint,
  isPointInRect,
  minimumArrowLengthPx,
  minimumSelectionSizePx,
  normalizeArrow,
  normalizeRect
} from "./overlay-model.js";
import { RecordingHudController } from "./recording-hud.js";
import { RecordingSession } from "./recording-session.js";
import { videoFpsOptions } from "./shared.js";
import type {
  Annotation,
  ArrowAnnotation,
  DragState,
  PenAnnotation,
  Point,
  VideoButtonState
} from "./overlay-model.js";
import type { CaptureMode, OverlayBootstrap, Rect, VideoFps, VideoQuality } from "./shared.js";

const canvasContextError = "Could not create the overlay drawing context.";
const copyShortcutKey = "c";
const defaultDevicePixelRatio = 1;
const dimColor = "rgba(0, 0, 0, 0.44)";
const enterKey = "Enter";
const escapeKey = "Escape";
const frameScale = { x: 1, y: 1 };
const screenshotCanvasContextError = "Could not create the screenshot canvas.";
const spaceKey = " ";
const toolbarPulseDurationMs = 160;
const videoButtonAnimationDurationMs = 220;
const zeroPoint = { x: 0, y: 0 };
const countdownValues = [3, 2, 1, 0] as const;
const countdownStepMs = 1000;
const countdownZeroHoldMs = 500;
const runIdIncrement = 1;
const videoButtonPopKeyframes = [
  { transform: "scale(1)" },
  { transform: "scale(1.08)" },
  { transform: "scale(1)" }
] satisfies Keyframe[];

class OverlayApp {
  private readonly arrowButton = getRequiredElement("arrow-button", HTMLButtonElement);
  private readonly canvas = getRequiredElement("annotation-canvas", HTMLCanvasElement);
  private readonly closeButton = getRequiredElement("close-button", HTMLButtonElement);
  private readonly colorButton = getRequiredElement("color-button", HTMLButtonElement);
  private readonly colorMenu = getRequiredElement("color-menu", HTMLDivElement);
  private readonly context = getCanvasContext(this.canvas, canvasContextError);
  private readonly penButton = getRequiredElement("pen-button", HTMLButtonElement);
  private readonly recordingHud = new RecordingHudController();
  private readonly screenImage = getRequiredElement("screen-image", HTMLImageElement);
  private readonly screenshotButton = getRequiredElement("screenshot-button", HTMLButtonElement);
  private readonly settingsButton = getRequiredElement("settings-button", HTMLButtonElement);
  private readonly settingsMenu = getRequiredElement("settings-menu", HTMLDivElement);
  private readonly videoButton = getRequiredElement("video-button", HTMLButtonElement);
  private activeTool = defaultDrawingTool;
  private annotations: Annotation[] = [];
  private bootstrap: OverlayBootstrap | null = null;
  private captureMode: CaptureMode = defaultCaptureMode;
  private countdownRunId = 0;
  private dragState: DragState = null;
  private fps: VideoFps = videoFpsOptions.high;
  private isCountingDown = false;
  private isRecording = false;
  private isRenderQueued = false;
  private quality: VideoQuality = defaultVideoQuality;
  private recordingSession: RecordingSession | null = null;
  private selectedColor = defaultPenColor;
  private selection: Rect | null = null;

  async initialize(): Promise<void> {
    try {
      this.bootstrap = await window.softshot.getBootstrap();
      await loadImage(this.screenImage, this.bootstrap.imageDataUrl, "Timed out loading the frozen screen image.");
      this.resizeCanvas();
      this.bindEvents();
      this.syncToolbar();
      await this.renderOnce();
      await window.softshot.readyToShow();
    } catch (error) {
      await this.reportError("Could not prepare the capture overlay.", error);
      await this.closeOverlay();
    }
  }

  private bindEvents(): void {
    addEventListener("resize", (): void => {
      this.resizeCanvas();
      this.recordingHud.refresh();
      this.requestRender();
    });
    this.bindPointerEvents();
    this.bindKeyboardEvents();
    this.bindToolbarEvents();
    this.bindMenuEvents();
  }

  private bindKeyboardEvents(): void {
    addEventListener("keydown", (event): void => {
      if (event.key === escapeKey) {
        this.closeOverlay().catch((error: unknown): Promise<void> => this.reportError("Could not close the overlay.", error));
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === copyShortcutKey) {
        event.preventDefault();
        this.copyScreenshot().catch((error: unknown): Promise<void> => this.reportError("Could not copy the screenshot.", error));
        return;
      }

      if (event.key === enterKey && this.captureMode === "screenshot") {
        this.saveScreenshot().catch((error: unknown): Promise<void> => this.reportError("Could not save the screenshot.", error));
        return;
      }

      if (event.key === spaceKey && this.captureMode === "video") {
        event.preventDefault();
        this.toggleRecording().catch((error: unknown): Promise<void> => this.reportError("Could not toggle recording.", error));
      }
    });
  }

  private bindMenuEvents(): void {
    this.colorMenu.addEventListener("click", (event): void => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-color]");
      if (!button) {
        return;
      }

      this.selectedColor = button.dataset.color ?? this.selectedColor;
      this.syncToolbar();
      this.requestRender();
    });

    this.settingsMenu.addEventListener("click", (event): void => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-quality], [data-fps]");
      if (!button || this.isRecording || this.isCountingDown) {
        return;
      }

      this.updateRecordingSetting(button);
      this.syncToolbar();
    });

    addEventListener("pointerdown", (event): void => {
      if (!(event.target as HTMLElement).closest(".toolbar")) {
        this.closeMenus();
      }
    });
  }

  private bindPointerEvents(): void {
    addEventListener("pointerdown", (event): void => {
      this.onPointerDown(event);
    });
    addEventListener("pointermove", (event): void => {
      this.onPointerMove(event);
    });
    addEventListener("pointerup", (event): void => {
      this.onPointerUp(event);
    });
    addEventListener("pointercancel", (): void => {
      this.cancelDrag();
    });
  }

  private bindToolbarEvents(): void {
    document.querySelector(".toolbar")?.addEventListener("pointerdown", (event): void => {
      event.stopPropagation();
    });
    this.screenshotButton.addEventListener("click", (): void => {
      this.onScreenshotButtonClick();
    });
    this.videoButton.addEventListener("click", (): void => {
      this.onVideoButtonClick();
    });
    this.penButton.addEventListener("click", (): void => {
      this.selectTool("pen");
    });
    this.arrowButton.addEventListener("click", (): void => {
      this.selectTool("arrow");
    });
    this.colorButton.addEventListener("click", (): void => {
      this.settingsMenu.hidden = true;
      this.colorMenu.hidden = !this.colorMenu.hidden;
    });
    this.settingsButton.addEventListener("click", (): void => {
      this.colorMenu.hidden = true;
      this.settingsMenu.hidden = !this.settingsMenu.hidden;
    });
    this.closeButton.addEventListener("click", (): void => {
      this.closeOverlay().catch((error: unknown): Promise<void> => this.reportError("Could not close the overlay.", error));
    });
  }

  private cancelCountdown(): void {
    this.countdownRunId += runIdIncrement;
    this.isCountingDown = false;
    this.recordingHud.clearCountdown();
    this.syncToolbar();
    this.requestRender();
  }

  private cancelDrag(): void {
    this.dragState = null;
    this.requestRender();
  }

  private closeMenus(): void {
    this.colorMenu.hidden = true;
    this.settingsMenu.hidden = true;
  }

  private async closeOverlay(): Promise<void> {
    if (this.isCountingDown) {
      this.cancelCountdown();
    }

    if (this.isRecording) {
      await this.stopRecording();
      return;
    }

    await window.softshot.closeOverlay();
  }

  private async copyScreenshot(): Promise<void> {
    const dataUrl = this.renderSelectionDataUrl();
    if (!dataUrl) {
      return;
    }

    await window.softshot.copyScreenshot(dataUrl);
  }

  private drawCurrentArrow(): void {
    if (this.dragState?.kind !== "arrow") {
      return;
    }

    drawArrow(this.context, {
      color: this.selectedColor,
      from: this.dragState.start,
      kind: "arrow",
      to: this.dragState.current
    });
  }

  private enterVideoMode(): void {
    this.captureMode = "video";
    this.activeTool = "select";
    this.syncToolbar();
  }

  private async finishRecording(bytes: Uint8Array): Promise<void> {
    this.recordingSession?.stopTracks();
    this.recordingSession = null;
    this.isRecording = false;
    this.recordingHud.stopRecording();
    this.syncToolbar();
    await window.softshot.saveVideo(bytes);
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.shouldIgnorePointerDown(event)) {
      return;
    }

    const point = eventPoint(event);
    if (!this.selection || this.activeTool === "select") {
      this.startSelectionDrag(point, event.pointerId);
      return;
    }

    if (!isPointInRect(point, this.selection)) {
      this.activeTool = "select";
      this.startSelectionDrag(point, event.pointerId);
      this.syncToolbar();
      return;
    }

    this.startAnnotationDrag(point, event.pointerId);
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.dragState) {
      return;
    }

    const point = eventPoint(event);
    if (this.dragState.kind === "select") {
      this.dragState.current = point;
    } else if (this.dragState.kind === "pen") {
      this.dragState.annotation.points.push(clampPointToRect(point, this.selection));
    } else {
      this.dragState.current = clampPointToRect(point, this.selection);
    }

    this.requestRender();
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.dragState) {
      return;
    }

    const completedDrag = this.dragState;
    this.dragState = null;
    this.releasePointerCapture(event.pointerId);
    this.finishDrag(completedDrag);
    this.syncToolbar();
    this.requestRender();
  }

  private onScreenshotButtonClick(): void {
    this.closeMenus();
    this.captureMode = "screenshot";
    this.activeTool = "select";
    this.syncToolbar();

    if (this.selection) {
      this.saveScreenshot().catch((error: unknown): Promise<void> => this.reportError("Could not save the screenshot.", error));
    }
  }

  private onVideoButtonClick(): void {
    this.closeMenus();
    if (this.captureMode !== "video") {
      this.enterVideoMode();
      return;
    }

    this.toggleRecording().catch((error: unknown): Promise<void> => this.reportError("Could not toggle recording.", error));
  }

  private pulseToolbar(): void {
    const toolbar = document.querySelector<HTMLElement>(".toolbar");
    if (!toolbar) {
      return;
    }

    toolbar.animate(
      [
        { transform: "translateX(-50%) scale(1)" },
        { transform: "translateX(-50%) scale(1.035)" },
        { transform: "translateX(-50%) scale(1)" }
      ],
      { duration: toolbarPulseDurationMs, easing: "ease-out" }
    );
  }

  private releasePointerCapture(pointerId: number): void {
    if (this.canvas.hasPointerCapture(pointerId)) {
      this.canvas.releasePointerCapture(pointerId);
    }
  }

  private render(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.context.clearRect(zeroPoint.x, zeroPoint.y, width, height);
    this.context.fillStyle = dimColor;
    this.context.fillRect(zeroPoint.x, zeroPoint.y, width, height);
    this.renderSelection();
    drawAnnotations(this.context, this.annotations, { clip: this.selection, offset: zeroPoint, scale: frameScale });
    this.drawCurrentArrow();
    this.recordingHud.refresh();
  }

  private renderOnce(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame((): void => {
        this.render();
        resolve();
      });
    });
  }

  private renderSelection(): void {
    const activeSelection = this.dragState?.kind === "select"
      ? normalizeRect(this.dragState.start, this.dragState.current)
      : this.selection;
    if (!activeSelection) {
      return;
    }

    this.context.clearRect(activeSelection.x, activeSelection.y, activeSelection.width, activeSelection.height);
    drawSelectionFrame(this.context, activeSelection, this.isRecording || this.isCountingDown);
  }

  private renderSelectionDataUrl(): string | null {
    if (!this.selection) {
      this.pulseToolbar();
      return null;
    }

    const output = document.createElement("canvas");
    const imageScaleX = this.screenImage.naturalWidth / window.innerWidth;
    const imageScaleY = this.screenImage.naturalHeight / window.innerHeight;
    output.width = Math.max(defaultDevicePixelRatio, Math.round(this.selection.width * imageScaleX));
    output.height = Math.max(defaultDevicePixelRatio, Math.round(this.selection.height * imageScaleY));

    const outputContext = getCanvasContext(output, screenshotCanvasContextError);
    outputContext.drawImage(
      this.screenImage,
      this.selection.x * imageScaleX,
      this.selection.y * imageScaleY,
      this.selection.width * imageScaleX,
      this.selection.height * imageScaleY,
      zeroPoint.x,
      zeroPoint.y,
      output.width,
      output.height
    );
    drawAnnotations(outputContext, this.annotations, {
      clip: this.selection,
      offset: { x: this.selection.x, y: this.selection.y },
      scale: {
        x: output.width / this.selection.width,
        y: output.height / this.selection.height
      }
    });
    return output.toDataURL("image/png");
  }

  private reportError(message: string, error: unknown): Promise<void> {
    const detail = error instanceof Error ? `${message}\n\n${error.message}` : message;
    return window.softshot.showError(detail);
  }

  private requestRender(): void {
    if (this.isRenderQueued) {
      return;
    }

    this.isRenderQueued = true;
    requestAnimationFrame((): void => {
      this.isRenderQueued = false;
      this.render();
    });
  }

  private resizeCanvas(): void {
    const ratio = window.devicePixelRatio || defaultDevicePixelRatio;
    this.canvas.width = Math.round(window.innerWidth * ratio);
    this.canvas.height = Math.round(window.innerHeight * ratio);
    this.canvas.style.width = `${String(window.innerWidth)}px`;
    this.canvas.style.height = `${String(window.innerHeight)}px`;
    this.context.setTransform(ratio, zeroPoint.x, zeroPoint.y, ratio, zeroPoint.x, zeroPoint.y);
  }

  private async saveScreenshot(): Promise<void> {
    const dataUrl = this.renderSelectionDataUrl();
    if (!dataUrl) {
      return;
    }

    await window.softshot.saveScreenshot(dataUrl);
  }

  private selectTool(tool: "arrow" | "pen"): void {
    this.closeMenus();
    this.activeTool = tool;
    this.syncToolbar();
  }

  private setVideoButtonState(state: VideoButtonState): void {
    const previousState = this.videoButton.dataset.state;
    this.videoButton.dataset.state = state;

    for (const icon of this.videoButton.querySelectorAll<HTMLElement>("[data-video-icon]")) {
      icon.classList.toggle("active", icon.dataset.videoIcon === state);
    }

    if (previousState && previousState !== state) {
      this.videoButton.animate(videoButtonPopKeyframes, {
        duration: videoButtonAnimationDurationMs,
        easing: "cubic-bezier(0.2, 0.85, 0.28, 1.2)"
      });
    }
  }

  private shouldIgnorePointerDown(event: PointerEvent): boolean {
    return Boolean(
      (event.target as HTMLElement).closest(".toolbar")
      || this.isCountingDown
      || (this.isRecording && this.activeTool === "select")
    );
  }

  private startAnnotationDrag(point: Point, pointerId: number): void {
    if (this.activeTool === "pen") {
      const annotation: PenAnnotation = {
        color: this.selectedColor,
        kind: "pen",
        points: [point]
      };
      this.annotations.push(annotation);
      this.dragState = { annotation, kind: "pen" };
    } else {
      this.dragState = { current: point, kind: "arrow", start: point };
    }

    this.canvas.setPointerCapture(pointerId);
    this.requestRender();
  }

  private async startRecording(): Promise<void> {
    if (!this.bootstrap || !this.selection || this.isRecording) {
      return;
    }

    try {
      this.captureMode = "video";
      this.isRecording = true;
      this.syncToolbar();
      this.recordingHud.showRecordingPending();
      this.requestRender();
      this.recordingSession = await RecordingSession.create({
        annotations: this.annotations,
        crop: this.selection,
        fps: this.fps,
        quality: this.quality,
        sourceId: this.bootstrap.sourceId
      });
      this.recordingSession.start();
      this.recordingHud.startRecordingTimer();
    } catch (error) {
      this.isRecording = false;
      this.recordingSession?.stopTracks();
      this.recordingSession = null;
      this.recordingHud.stopRecording();
      this.syncToolbar();
      await this.reportError("Could not start the recording.", error);
    }
  }

  private async startRecordingCountdown(): Promise<void> {
    if (!this.selection || this.isRecording || this.isCountingDown) {
      return;
    }

    this.countdownRunId += runIdIncrement;
    const runId = this.countdownRunId;
    this.isCountingDown = true;
    this.syncToolbar();

    for (const value of countdownValues) {
      if (this.shouldStopCountdown(runId)) {
        return;
      }

      this.recordingHud.setCountdown(value);
      this.requestRender();
      await delay(value === 0 ? countdownZeroHoldMs : countdownStepMs);
    }

    if (this.shouldStopCountdown(runId)) {
      return;
    }

    this.isCountingDown = false;
    this.recordingHud.clearCountdown();
    await this.startRecording();
  }

  private startSelectionDrag(point: Point, pointerId: number): void {
    this.dragState = { current: point, kind: "select", start: point };
    this.canvas.setPointerCapture(pointerId);
    this.requestRender();
  }

  private async stopRecording(): Promise<void> {
    if (!this.recordingSession) {
      return;
    }

    const session = this.recordingSession;
    const bytes = await session.stop();
    await this.finishRecording(bytes);
  }

  private syncToolbar(): void {
    const videoState = this.videoButtonState();
    this.screenshotButton.classList.toggle("active", this.captureMode === "screenshot");
    this.videoButton.classList.toggle("active", this.captureMode === "video");
    this.videoButton.classList.toggle("recording", this.isRecording || this.isCountingDown);
    this.videoButton.title = this.videoButtonTitle(videoState);
    this.videoButton.setAttribute("aria-label", this.videoButton.title);
    this.setVideoButtonState(videoState);
    this.penButton.classList.toggle("active", this.activeTool === "pen");
    this.arrowButton.classList.toggle("active", this.activeTool === "arrow");
    document.documentElement.style.setProperty("--accent", this.selectedColor);
    this.syncColorMenu();
    this.syncSettingsMenu();
  }

  private syncColorMenu(): void {
    for (const button of this.colorMenu.querySelectorAll<HTMLButtonElement>("[data-color]")) {
      button.classList.toggle("selected", button.dataset.color === this.selectedColor);
    }
  }

  private syncSettingsMenu(): void {
    for (const button of this.settingsMenu.querySelectorAll<HTMLButtonElement>("[data-quality]")) {
      button.classList.toggle("selected", button.dataset.quality === this.quality);
    }

    for (const button of this.settingsMenu.querySelectorAll<HTMLButtonElement>("[data-fps]")) {
      button.classList.toggle("selected", Number(button.dataset.fps) === this.fps);
    }
  }

  private async toggleRecording(): Promise<void> {
    this.enterVideoMode();

    if (this.isRecording) {
      await this.stopRecording();
      return;
    }

    if (this.isCountingDown) {
      this.cancelCountdown();
      return;
    }

    if (!this.selection) {
      this.syncToolbar();
      this.pulseToolbar();
      return;
    }

    await this.startRecordingCountdown();
  }

  private updateRecordingSetting(button: HTMLButtonElement): void {
    const { fps, quality } = button.dataset;
    if (quality === "720p" || quality === "1080p") {
      this.quality = quality;
    }

    if (fps === "30" || fps === "60") {
      this.fps = Number(fps) as VideoFps;
    }
  }

  private videoButtonState(): VideoButtonState {
    if (this.isRecording || this.isCountingDown) {
      return "stop";
    }

    if (this.captureMode === "video" && this.selection) {
      return "start";
    }

    return "video";
  }

  private videoButtonTitle(state: VideoButtonState): string {
    if (state === "stop") {
      return this.isCountingDown ? "Cancel countdown" : "Stop recording";
    }

    if (state === "start") {
      return "Start recording";
    }

    return "Video";
  }

  private finishDrag(completedDrag: Exclude<DragState, null>): void {
    if (completedDrag.kind === "select") {
      this.finishSelectionDrag(completedDrag.start, completedDrag.current);
    } else if (completedDrag.kind === "arrow") {
      this.finishArrowDrag(completedDrag);
    }
  }

  private finishArrowDrag(completedDrag: { current: Point; start: Point }): void {
    const arrow = normalizeArrow({
      color: this.selectedColor,
      from: completedDrag.start,
      kind: "arrow",
      to: completedDrag.current
    }, this.selection);
    if (distance(arrow.from, arrow.to) >= minimumArrowLengthPx) {
      this.annotations.push(arrow);
    }
  }

  private finishSelectionDrag(start: Point, current: Point): void {
    const nextSelection = normalizeRect(start, current);
    if (nextSelection.width < minimumSelectionSizePx || nextSelection.height < minimumSelectionSizePx) {
      return;
    }

    this.selection = nextSelection;
    this.annotations = [];
    this.activeTool = "select";
    this.recordingHud.setSelection(this.selection);
  }

  private shouldStopCountdown(runId: number): boolean {
    return !this.isCountingDown || runId !== this.countdownRunId;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const overlayApp = new OverlayApp();
await overlayApp.initialize();
