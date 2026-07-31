export type JobState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface VideoJob {
  id: string;
  inputPath: string;
  outputPath?: string;
  state: JobState;
  progress: number;
  detail: string;
  attempt: number;
  phase?: "remove" | "post";
}

export interface LogEntry {
  id: string;
  time: Date;
  level: "INFO" | "OK" | "ERROR";
  filename?: string;
  message: string;
}

export interface CliOutput {
  jobId: string;
  stream: "stdout" | "stderr";
  text: string;
}

export interface ProcessResult {
  exitCode: number;
  outputExists: boolean;
  cancelled: boolean;
}

export interface SystemCapabilities {
  os: string;
  arch: string;
  cpuCores: number;
  memoryGb: number;
  gpuSummary: string;
  metalSupported: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
  bundledFfmpegPath?: string;
  bundledFfprobePath?: string;
  ffmpegVersion?: string;
  bundledCliPath?: string;
  standardUpscaleAvailable: boolean;
  aiUpscaleAvailable: boolean;
  hardwareEncoder?: string;
}

export interface VideoInfo {
  width: number;
  height: number;
  duration: number;
}

export interface HistoryItem {
  id: string;
  inputPath: string;
  outputPath?: string;
  operation: "remove" | "watermark" | "upscale";
  status: "imported" | "processing" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

export interface WatermarkPreset {
  id: string;
  title: string;
  layersJson: string;
  createdAt: number;
  updatedAt: number;
}

export type WatermarkKind = "text" | "image";
export type WatermarkTextCase =
  | "none"
  | "capitalize"
  | "uppercase"
  | "lowercase";
export type WatermarkTextAlign = "left" | "center" | "right";
export type WatermarkMotion =
  | "static"
  | "right-to-left"
  | "left-to-right"
  | "top-to-bottom"
  | "bottom-to-top"
  | "diagonal"
  | "bounce";

export interface WatermarkLayer {
  id: string;
  kind: WatermarkKind;
  name: string;
  text: string;
  fontFamily: string;
  fontSize: number;
  textCase: WatermarkTextCase;
  textAlign: WatermarkTextAlign;
  lineHeight: number;
  padding: number;
  imagePath?: string;
  imageDataUrl?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  size: number;
  lockAspectRatio: boolean;
  opacity: number;
  rotation: number;
  startSeconds: number;
  endSeconds: number;
  motion: WatermarkMotion;
  zIndex: number;
  color: string;
  bold: boolean;
  shadow: boolean;
  outline: boolean;
  runtimePath?: string;
}

export function createTextWatermark(index: number): WatermarkLayer {
  return {
    id: crypto.randomUUID(),
    kind: "text",
    name: `Text ${index}`,
    text: "Your watermark",
    fontFamily: "Arial",
    fontSize: 64,
    textCase: "none",
    textAlign: "center",
    lineHeight: 1.2,
    padding: 12,
    x: 0.85,
    y: 0.9,
    width: 0.3,
    height: 0.12,
    size: 0.18,
    lockAspectRatio: false,
    opacity: 0.7,
    rotation: 0,
    startSeconds: 0,
    endSeconds: 0,
    motion: "static",
    zIndex: index,
    color: "#ffffff",
    bold: true,
    shadow: true,
    outline: false,
  };
}

export const VIDEO_EXTENSIONS = new Set(["mp4"]);

export function filename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function extension(path: string): string {
  const name = filename(path);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isSupportedVideo(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extension(path));
}

export function parseProgress(text: string): number | undefined {
  const matches = [
    ...text.matchAll(/(?<!\d)(100(?:\.0+)?|[0-9]?[0-9](?:\.[0-9]+)?)\s*%/g),
  ];
  const last = matches.at(-1);
  if (!last) return undefined;
  const value = Number(last[1]) / 100;
  return Math.min(Math.max(value, 0), 1);
}

export function overallProgress(jobs: VideoJob[]): number {
  if (jobs.length === 0) return 0;
  const total = jobs.reduce((sum, job) => {
    const finished = ["succeeded", "failed", "cancelled"].includes(job.state);
    return sum + (finished ? 1 : job.progress);
  }, 0);
  return total / jobs.length;
}

export function aspectRatioLabel(width: number, height: number): string {
  const validWidth = Math.max(1, Math.round(width));
  const validHeight = Math.max(1, Math.round(height));
  let left = validWidth;
  let right = validHeight;
  while (right !== 0) {
    [left, right] = [right, left % right];
  }
  return `${validWidth / left}:${validHeight / left}`;
}

export function resizedLayerSize(
  startSize: number,
  startDistance: number,
  currentDistance: number,
): number {
  if (startDistance <= 0 || !Number.isFinite(currentDistance)) return startSize;
  return Math.min(Math.max(startSize * (currentDistance / startDistance), 0.03), 0.8);
}

export type ResizeAxis = "width" | "height" | "both";

export function resizedLayerDimensions(
  startWidth: number,
  startHeight: number,
  deltaX: number,
  deltaY: number,
  canvasWidth: number,
  canvasHeight: number,
  axis: ResizeAxis,
  lockAspectRatio: boolean,
): { width: number; height: number } {
  const proposedWidth = startWidth + deltaX / Math.max(canvasWidth, 1);
  const proposedHeight = startHeight + deltaY / Math.max(canvasHeight, 1);

  if (lockAspectRatio) {
    const widthScale = proposedWidth / Math.max(startWidth, 0.001);
    const heightScale = proposedHeight / Math.max(startHeight, 0.001);
    const scale =
      axis === "width"
        ? widthScale
        : axis === "height"
          ? heightScale
          : Math.abs(widthScale - 1) >= Math.abs(heightScale - 1)
            ? widthScale
            : heightScale;
    const maximumScale = Math.min(1 / startWidth, 1 / startHeight);
    const minimumScale = Math.max(0.04 / startWidth, 0.03 / startHeight);
    const clampedScale = Math.min(Math.max(scale, minimumScale), maximumScale);
    return {
      width: startWidth * clampedScale,
      height: startHeight * clampedScale,
    };
  }

  return {
    width:
      axis === "height"
        ? startWidth
        : Math.min(Math.max(proposedWidth, 0.04), 1),
    height:
      axis === "width"
        ? startHeight
        : Math.min(Math.max(proposedHeight, 0.03), 1),
  };
}

export function rotatedLayerAngle(
  startRotation: number,
  startPointerAngle: number,
  currentPointerAngle: number,
): number {
  let delta = currentPointerAngle - startPointerAngle;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  let result = Math.round(startRotation + delta);
  while (result > 180) result -= 360;
  while (result < -180) result += 360;
  return result;
}

export function applyTextCase(
  value: string,
  textCase: WatermarkTextCase,
): string {
  if (textCase === "uppercase") return value.toLocaleUpperCase();
  if (textCase === "lowercase") return value.toLocaleLowerCase();
  if (textCase === "capitalize") {
    return value
      .toLocaleLowerCase()
      .replace(/(^|[\s\p{P}])(\p{L})/gu, (_match, prefix, letter) =>
        `${prefix}${String(letter).toLocaleUpperCase()}`,
      );
  }
  return value;
}

export function effectiveLayerSize(layer: WatermarkLayer): number {
  const fontScale =
    layer.kind === "text"
      ? Math.min(Math.max(layer.fontSize || 64, 12), 200) / 64
      : 1;
  return Math.min(Math.max(layer.size * fontScale, 0.02), 1);
}
