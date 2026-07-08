import { getCursorlessDesktopStream, stopTracks } from "./desktop-capture.js";
import { drawAnnotations } from "./overlay-drawing.js";
import type { Annotation } from "./overlay-model.js";
import type { Rect, VideoFps, VideoQuality } from "./shared.js";
import { videoFpsOptions, videoQualityHeights } from "./shared.js";
import { getSoftshotApi } from "./softshot-api.js";

const highQualityBitrate = 10_000_000;
const recordingTimesliceMs = 500;
const standardQualityBitrate = 5_000_000;
const highFpsBitrateMultiplier = 1.5;
const minimumVideoDimensionPx = 2;
const millisecondsPerSecond = 1000;
const supportedMimeTypes = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"] as const;

export interface RecordingSessionConfig {
  annotations: Annotation[];
  crop: Rect;
  fps: VideoFps;
  quality: VideoQuality;
}

export interface RecordingResult {
  durationSeconds: number;
  mimeType: string;
  recordingId: string;
}

export class RecordingSession {
  static async create(config: RecordingSessionConfig): Promise<RecordingSession> {
    const recordingFile = await getSoftshotApi().createRecordingFile();
    try {
      const sourceStream = await getCursorlessDesktopStream(config.fps);
      const sourceVideo = await createSourceVideo(sourceStream);
      const outputSize = videoOutputSize(config.crop, config.quality);
      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = outputSize.width;
      outputCanvas.height = outputSize.height;

      const outputContext = outputCanvas.getContext("2d");
      if (!outputContext) {
        throw new Error("Could not create the recording canvas.");
      }

      const outputStream = outputCanvas.captureStream(config.fps);
      const mimeType = supportedVideoMimeType();
      const recorder = new MediaRecorder(outputStream, {
        mimeType,
        videoBitsPerSecond: videoBitrate(config.quality, config.fps)
      });
      const session = new RecordingSession({
        crop: { ...config.crop },
        outputCanvas,
        outputContext,
        outputStream,
        mimeType,
        recorder,
        recordingId: recordingFile.id,
        sourceStream,
        sourceVideo
      });
      session.connectRecorder(config.annotations);
      return session;
    } catch (error) {
      await getSoftshotApi().discardRecordingFile(recordingFile.id);
      throw error;
    }
  }

  private animationHandle: number | null = null;
  private readonly crop: Rect;
  private isFinalized = false;
  private readonly outputCanvas: HTMLCanvasElement;
  private readonly outputContext: CanvasRenderingContext2D;
  private readonly outputStream: MediaStream;
  private readonly mimeType: string;
  private readonly recorder: MediaRecorder;
  private readonly recordingId: string;
  private recordingStartedAtMs: number | null = null;
  private readonly sourceStream: MediaStream;
  private readonly sourceVideo: HTMLVideoElement;
  private writeChain: Promise<void> = Promise.resolve();
  private writeError: unknown = null;

  private constructor(config: {
    crop: Rect;
    outputCanvas: HTMLCanvasElement;
    outputContext: CanvasRenderingContext2D;
    outputStream: MediaStream;
    mimeType: string;
    recorder: MediaRecorder;
    recordingId: string;
    sourceStream: MediaStream;
    sourceVideo: HTMLVideoElement;
  }) {
    this.crop = config.crop;
    this.outputCanvas = config.outputCanvas;
    this.outputContext = config.outputContext;
    this.outputStream = config.outputStream;
    this.mimeType = config.mimeType;
    this.recorder = config.recorder;
    this.recordingId = config.recordingId;
    this.sourceStream = config.sourceStream;
    this.sourceVideo = config.sourceVideo;
  }

  private connectRecorder(annotations: Annotation[]): void {
    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        this.queueChunkWrite(event.data);
      }
    });

    this.recorder.addEventListener("start", () => {
      this.drawFrameWithAnnotations(annotations);
    });
  }

  private drawFrame(): void {
    const sourceScaleX = this.sourceVideo.videoWidth / window.innerWidth;
    const sourceScaleY = this.sourceVideo.videoHeight / window.innerHeight;
    this.outputContext.clearRect(0, 0, this.outputCanvas.width, this.outputCanvas.height);
    this.outputContext.drawImage(
      this.sourceVideo,
      this.crop.x * sourceScaleX,
      this.crop.y * sourceScaleY,
      this.crop.width * sourceScaleX,
      this.crop.height * sourceScaleY,
      0,
      0,
      this.outputCanvas.width,
      this.outputCanvas.height
    );
  }

  private drawFrameWithAnnotations(annotations: Annotation[]): void {
    this.drawFrame();
    drawAnnotations(this.outputContext, annotations, {
      clip: this.crop,
      offset: { x: this.crop.x, y: this.crop.y },
      scale: {
        x: this.outputCanvas.width / this.crop.width,
        y: this.outputCanvas.height / this.crop.height
      }
    });
    this.animationHandle = requestAnimationFrame((): void => {
      this.drawFrameWithAnnotations(annotations);
    });
  }

  private recordingDurationSeconds(stoppedAtMs: number): number {
    if (this.recordingStartedAtMs === null) {
      return 0;
    }

    return Math.max(0, (stoppedAtMs - this.recordingStartedAtMs) / millisecondsPerSecond);
  }

  private async flushWrites(): Promise<void> {
    await this.writeChain;
    if (this.writeError) {
      throw new Error("Could not write the recording file.", { cause: this.writeError });
    }
  }

  private queueChunkWrite(blob: Blob): void {
    const previousWrite = this.writeChain;
    this.writeChain = this.writeQueuedChunk(previousWrite, blob);
  }

  private async stopRecorderIfActive(): Promise<void> {
    if (this.recorder.state === "inactive") {
      await this.flushWrites();
      return;
    }

    const stopped = new Promise<void>((resolve) => {
      this.recorder.addEventListener(
        "stop",
        () => {
          resolve();
        },
        { once: true }
      );
    });
    this.recorder.stop();
    await stopped;
    await this.flushWrites();
  }

  private async writeBlobChunk(blob: Blob): Promise<void> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await getSoftshotApi().appendRecordingFileChunk(this.recordingId, bytes);
  }

  private async writeQueuedChunk(previousWrite: Promise<void>, blob: Blob): Promise<void> {
    await previousWrite;
    if (this.writeError) {
      return;
    }

    try {
      await this.writeBlobChunk(blob);
    } catch (error) {
      this.writeError = error;
    }
  }

  async discard(): Promise<void> {
    await this.stopRecorderIfActive();
    this.stopTracks();

    if (this.isFinalized) {
      return;
    }

    await getSoftshotApi().discardRecordingFile(this.recordingId);
    this.isFinalized = true;
  }

  start(): void {
    this.recordingStartedAtMs = performance.now();
    this.drawFrame();
    this.recorder.start(recordingTimesliceMs);
  }

  async stop(): Promise<RecordingResult> {
    if (this.recorder.state === "inactive") {
      return {
        durationSeconds: 0,
        mimeType: this.mimeType,
        recordingId: this.recordingId
      };
    }

    const durationSeconds = this.recordingDurationSeconds(performance.now());
    await this.stopRecorderIfActive();
    this.isFinalized = true;
    return {
      durationSeconds,
      mimeType: this.mimeType,
      recordingId: this.recordingId
    };
  }

  stopTracks(): void {
    if (this.animationHandle !== null) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }

    stopTracks(this.sourceStream);
    stopTracks(this.outputStream);
  }
}

async function createSourceVideo(sourceStream: MediaStream): Promise<HTMLVideoElement> {
  const sourceVideo = document.createElement("video");
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  sourceVideo.srcObject = sourceStream;
  await sourceVideo.play();
  await waitForVideoMetadata(sourceVideo);
  return sourceVideo;
}

function supportedVideoMimeType(): string {
  const supported = supportedMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
  if (!supported) {
    throw new Error("This system does not support WebM screen recording through MediaRecorder.");
  }

  return supported;
}

function videoBitrate(selectedQuality: VideoQuality, selectedFps: VideoFps): number {
  const base = selectedQuality === "720p" ? standardQualityBitrate : highQualityBitrate;
  return selectedFps === videoFpsOptions.high ? Math.round(base * highFpsBitrateMultiplier) : base;
}

function videoOutputSize(rect: Rect, selectedQuality: VideoQuality): { height: number; width: number } {
  const targetHeight = selectedQuality === "720p" ? videoQualityHeights.low : videoQualityHeights.high;
  const aspect = rect.width / rect.height;
  return {
    height: targetHeight,
    width: Math.max(minimumVideoDimensionPx, Math.round(targetHeight * aspect))
  };
}

async function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    video.addEventListener("loadedmetadata", () => {
      resolve();
    }, { once: true });
  });
}
