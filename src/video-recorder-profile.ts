import type { RecordingEncoder, VideoFileExtension, VideoFps } from "./shared.js";
import { hardwareVideoCodecs } from "./video-codecs.js";

export interface VideoRecorderProfile {
  encoder: RecordingEncoder;
  fileExtension: VideoFileExtension;
  hardwareVideoCodec: string | null;
  mimeType: string;
}

const audioBitrate = 192_000;
const audioChannelCount = 2;
const audioSampleRate = 48_000;

const compatibilityMimeTypes = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"] as const;
const compatibilityAudioMimeTypes = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm"
] as const;

export async function selectVideoRecorderProfile(
  width: number,
  height: number,
  fps: VideoFps,
  bitrate: number,
  hasAudio: boolean
): Promise<VideoRecorderProfile> {
  if (typeof VideoEncoder !== "undefined") {
    const hardwareVideoCodec = await supportedHardwareVideoCodec(width, height, fps, bitrate);
    let isAudioSupported = !hasAudio;
    if (hasAudio && typeof AudioEncoder !== "undefined") {
      const audioSupport = await AudioEncoder.isConfigSupported({
        bitrate: audioBitrate,
        codec: "mp4a.40.2",
        numberOfChannels: audioChannelCount,
        sampleRate: audioSampleRate
      });
      isAudioSupported = audioSupport.supported ?? false;
    }
    if (hardwareVideoCodec && isAudioSupported) {
      const hardwareVideoMimeType = `video/mp4;codecs=${hardwareVideoCodec}`;
      return {
        encoder: "hardware",
        fileExtension: "mp4",
        hardwareVideoCodec,
        mimeType: hasAudio ? `${hardwareVideoMimeType},mp4a.40.2` : hardwareVideoMimeType
      };
    }
  }

  const mimeTypes = hasAudio ? compatibilityAudioMimeTypes : compatibilityMimeTypes;
  const mimeType = mimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!mimeType) {
    throw new Error("This system does not support screen recording through MediaRecorder.");
  }

  return {
    encoder: "compatibility",
    fileExtension: "webm",
    hardwareVideoCodec: null,
    mimeType
  };
}

async function supportedHardwareVideoCodec(
  width: number,
  height: number,
  fps: VideoFps,
  bitrate: number
): Promise<string | null> {
  for (const codec of hardwareVideoCodecs) {
    const support = await VideoEncoder.isConfigSupported({
      bitrate,
      codec,
      framerate: fps,
      hardwareAcceleration: "prefer-hardware",
      height,
      latencyMode: "realtime",
      width
    });
    if (support.supported) {
      return codec;
    }
  }

  return null;
}
