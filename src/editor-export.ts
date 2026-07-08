import type { VideoFps } from "./shared.js";
import { hasWebmCluster } from "./webm.js";

const minimumOutputDimensionPx = 2;
const trimToleranceSeconds = 0.04;
const supportedMimeTypes = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"] as const;

export interface TrimRange {
  end: number;
  start: number;
}

interface LoadedVideo {
  video: HTMLVideoElement;
}

export async function exportTrimmedVideo(
  sourceUrl: string,
  mimeType: string,
  fps: VideoFps,
  trimRange: TrimRange
): Promise<Uint8Array> {
  const loadedVideo = await createLoadedVideo(sourceUrl);
  return await recordVideoSegment(loadedVideo.video, mimeType, fps, trimRange);
}

async function createLoadedVideo(sourceUrl: string): Promise<LoadedVideo> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = sourceUrl;
  await waitForVideoMetadata(video);
  return { video };
}

async function playSegment(
  video: HTMLVideoElement,
  context: CanvasRenderingContext2D,
  trimRange: TrimRange,
  width: number,
  height: number
): Promise<void> {
  await seekVideo(video, trimRange.start);
  await video.play();

  await new Promise<void>((resolve) => {
    const drawFrame = (): void => {
      context.drawImage(video, 0, 0, width, height);

      if (video.currentTime >= trimRange.end || video.ended) {
        video.pause();
        resolve();
        return;
      }

      requestAnimationFrame(drawFrame);
    };

    drawFrame();
  });
}

async function recordVideoSegment(
  video: HTMLVideoElement,
  preferredMimeType: string,
  fps: VideoFps,
  trimRange: TrimRange
): Promise<Uint8Array> {
  const width = Math.max(minimumOutputDimensionPx, video.videoWidth);
  const height = Math.max(minimumOutputDimensionPx, video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create the video export canvas.");
  }

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: supportedVideoMimeType(preferredMimeType) });
  const chunks: Blob[] = [];
  const stopped = new Promise<Blob>((resolve) => {
    recorder.addEventListener("stop", () => {
      resolve(new Blob(chunks, { type: recorder.mimeType }));
    }, { once: true });
  });

  recorder.addEventListener("dataavailable", (event): void => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  recorder.start();
  await playSegment(video, context, trimRange, width, height);
  recorder.stop();

  const outputBlob = await stopped;
  stopTracks(stream);
  if (outputBlob.size === 0) {
    throw new Error("The trimmed recording did not contain any video data.");
  }

  const outputBytes = new Uint8Array(await outputBlob.arrayBuffer());
  if (!hasWebmCluster(outputBytes)) {
    throw new Error("The trimmed recording did not contain any video frames.");
  }

  return outputBytes;
}

async function seekVideo(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
  if (Math.abs(video.currentTime - timeSeconds) <= trimToleranceSeconds) {
    return;
  }

  await new Promise<void>((resolve) => {
    video.addEventListener("seeked", () => {
      resolve();
    }, { once: true });
    video.currentTime = timeSeconds;
  });
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function supportedVideoMimeType(preferredMimeType: string): string {
  if (MediaRecorder.isTypeSupported(preferredMimeType)) {
    return preferredMimeType;
  }

  const supported = supportedMimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
  if (!supported) {
    throw new Error("This system does not support WebM video export.");
  }

  return supported;
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
