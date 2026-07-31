import { describe, expect, it } from "vitest";
import {
  applyTextCase,
  aspectRatioLabel,
  createTextWatermark,
  effectiveLayerSize,
  isSupportedVideo,
  overallProgress,
  parseProgress,
  resizedLayerDimensions,
  resizedLayerSize,
  rotatedLayerAngle,
  type VideoJob,
} from "./lib";

describe("parseProgress", () => {
  it("parses integer and decimal percentages", () => {
    expect(parseProgress("\r[=====] 42%")).toBe(0.42);
    expect(parseProgress("frame 20 67.5%")).toBe(0.675);
  });

  it("uses the latest percentage in a stream chunk", () => {
    expect(parseProgress("10%\r11%\r12%")).toBe(0.12);
  });

  it("ignores ordinary log text", () => {
    expect(parseProgress("Opening clip.mp4")).toBeUndefined();
  });
});

describe("queue helpers", () => {
  it("accepts supported video extensions case-insensitively", () => {
    expect(isSupportedVideo("C:\\clips\\sample.MP4")).toBe(true);
    expect(isSupportedVideo("/clips/sample.mov")).toBe(false);
    expect(isSupportedVideo("/clips/sample.png")).toBe(false);
  });

  it("combines finished jobs and current progress", () => {
    const jobs: VideoJob[] = [
      {
        id: "1",
        inputPath: "a.mp4",
        state: "succeeded",
        progress: 1,
        detail: "",
        attempt: 1,
      },
      {
        id: "2",
        inputPath: "b.mp4",
        state: "running",
        progress: 0.5,
        detail: "",
        attempt: 1,
      },
    ];
    expect(overallProgress(jobs)).toBe(0.75);
  });
});

describe("watermark editor geometry", () => {
  it("shows the reduced aspect ratio of the selected video", () => {
    expect(aspectRatioLabel(720, 1280)).toBe("9:16");
    expect(aspectRatioLabel(1920, 1080)).toBe("16:9");
  });

  it("resizes layers proportionally within editor limits", () => {
    expect(resizedLayerSize(0.2, 100, 150)).toBeCloseTo(0.3);
    expect(resizedLayerSize(0.2, 100, 1000)).toBe(0.8);
    expect(resizedLayerSize(0.2, 100, 1)).toBe(0.03);
  });

  it("resizes width and height independently, with optional aspect locking", () => {
    const unlocked = resizedLayerDimensions(
      0.2, 0.1, 100, 0, 1000, 500, "width", false,
    );
    expect(unlocked.width).toBeCloseTo(0.3);
    expect(unlocked.height).toBeCloseTo(0.1);
    const locked = resizedLayerDimensions(
      0.2, 0.1, 100, 0, 1000, 500, "width", true,
    );
    expect(locked.width).toBeCloseTo(0.3);
    expect(locked.height).toBeCloseTo(0.15);
  });

  it("rotates layers across the angle boundary", () => {
    expect(rotatedLayerAngle(0, 170, -170)).toBe(20);
    expect(rotatedLayerAngle(170, 0, 30)).toBe(-160);
  });

  it("applies the selected text capitalization", () => {
    expect(applyTextCase("hello JV studio", "uppercase")).toBe(
      "HELLO JV STUDIO",
    );
    expect(applyTextCase("HELLO jv STUDIO", "lowercase")).toBe(
      "hello jv studio",
    );
    expect(applyTextCase("hello jv studio", "capitalize")).toBe(
      "Hello Jv Studio",
    );
  });

  it("combines text size with the layer scale", () => {
    const layer = createTextWatermark(1);
    expect(effectiveLayerSize(layer)).toBeCloseTo(0.18);
    layer.fontSize = 128;
    expect(effectiveLayerSize(layer)).toBeCloseTo(0.36);
  });
});
