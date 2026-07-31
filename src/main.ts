import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import appPackage from "../package.json";
import {
  applyTextCase,
  aspectRatioLabel,
  createTextWatermark,
  effectiveLayerSize,
  filename,
  isSupportedVideo,
  overallProgress,
  parseProgress,
  resizedLayerDimensions,
  rotatedLayerAngle,
  type CliOutput,
  type HistoryItem,
  type LogEntry,
  type ProcessResult,
  type SystemCapabilities,
  type VideoInfo,
  type VideoJob,
  type WatermarkLayer,
  type WatermarkPreset,
  type ResizeAxis,
} from "./lib";
import googleFontFamilies from "./google-fonts.json";
import "./styles.css";

const UPSTREAM_REPOSITORY =
  "https://github.com/allenk/GeminiWatermarkTool";
const VIDEO_ENGINE_REPOSITORY =
  "https://github.com/allenk/VeoWatermarkRemover";
const APP_REPOSITORY = "https://github.com/jsonpreet/JV-Studio";
const LATEST_RELEASE_API =
  "https://api.github.com/repos/jsonpreet/JV-Studio/releases/latest";
const AUTHOR_X_PROFILE = "https://x.com/jsonpreet";
const APP_VERSION = `v${appPackage.version}`;
const GITHUB_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .7A11.3 11.3 0 0 0 8.4 22.8c.6.1.8-.2.8-.6v-2.2c-3.4.7-4.1-1.4-4.1-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6A4.7 4.7 0 0 1 5.8 8.4c-.1-.3-.5-1.6.1-3.3 0 0 1-.3 3.4 1.3a11.8 11.8 0 0 1 6.2 0C17.9 4.8 19 5.1 19 5.1c.6 1.7.2 3 .1 3.3a4.7 4.7 0 0 1 1.3 3.3c0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6A11.3 11.3 0 0 0 12 .7Z"/></svg>`;
const X_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.9 2.3h3.7l-8.1 9.3L24 21.7h-7.4l-5.8-7.6-6.7 7.6H.4l8.7-9.9L0 2.3h7.6l5.2 6.9 6.1-6.9Zm-1.3 17.6h2L6.5 4H4.4l13.2 15.9Z"/></svg>`;
const SYSTEM_FONT_FAMILIES = [
  "Arial",
  "Helvetica",
  "Georgia",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
] as const;
const GOOGLE_FONT_SET = new Set<string>(googleFontFamilies);
const loadedFontPromises = new Map<string, Promise<void>>();
const POSITION_PRESETS = [
  { id: "top-left", label: "Top left", x: 0.05, y: 0.05 },
  { id: "top-center", label: "Top center", x: 0.5, y: 0.05 },
  { id: "top-right", label: "Top right", x: 0.95, y: 0.05 },
  { id: "center-left", label: "Center left", x: 0.05, y: 0.5 },
  { id: "center", label: "Center", x: 0.5, y: 0.5 },
  { id: "center-right", label: "Center right", x: 0.95, y: 0.5 },
  { id: "bottom-left", label: "Bottom left", x: 0.05, y: 0.95 },
  { id: "bottom-center", label: "Bottom center", x: 0.5, y: 0.95 },
  { id: "bottom-right", label: "Bottom right", x: 0.95, y: 0.95 },
] as const;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root not found");

let jobs: VideoJob[] = [];
let logs: LogEntry[] = [];
let layers: WatermarkLayer[] = [];
let cliPath = localStorage.getItem("cliPath") ?? "";
let outputFolder =
  localStorage.getItem("outputFolder") ??
  localStorage.getItem("freeOutputFolder") ??
  "";
let ffmpegPath = localStorage.getItem("ffmpegPath") ?? "";
let useLegacy = localStorage.getItem("useLegacy") === "true";
let useML = localStorage.getItem("useML") === "true";
let upscale = Number(localStorage.getItem("upscale") ?? "1");
let encoderMode = localStorage.getItem("encoderMode") ?? "auto";
type AppTheme = "system" | "light" | "dark";
let appTheme =
  ((localStorage.getItem("appTheme") ??
    localStorage.getItem("freeAppTheme")) as AppTheme | null) ?? "system";
if (!( ["system", "light", "dark"] as AppTheme[]).includes(appTheme)) {
  appTheme = "system";
}
type ToolMode = "remove" | "watermark" | "upscale";
type AppPage = ToolMode | "library";
let activePage = (localStorage.getItem("activePage") as AppPage) ?? "remove";
if (!["remove", "watermark", "library"].includes(activePage)) {
  activePage = "remove";
}
let historyItems: HistoryItem[] = [];
let watermarkPresets: WatermarkPreset[] = [];
let showProcessingLogs =
  localStorage.getItem("showProcessingLogs") === "true" ||
  localStorage.getItem("freeShowProcessingLogs") === "true";
let removeTab: "videos" | "logs" = "videos";
let historyViewMode =
  (localStorage.getItem("historyViewMode") as "list" | "grid") ?? "list";
if (historyViewMode !== "list" && historyViewMode !== "grid") historyViewMode = "list";
type ThumbnailState = {
  status: "loading" | "ready" | "failed";
  dataUrl?: string;
};
const videoThumbnails = new Map<string, ThumbnailState>();
const thumbnailQueue: string[] = [];
let activeThumbnailWorkers = 0;
let thumbnailRenderTimer: number | undefined;
let activePresetId = "";
let presetTitle = "Untitled watermark";
let capabilities: SystemCapabilities | undefined;
let running = false;
let stopRequested = false;
let dropActive = false;
let currentStatus = "Add videos to begin";
let historyFilter: "all" | "completed" | "imported" = "all";

let editorOpen = false;
let selectedLayerId = "";
let previewDataUrl = "";
let previewInfo: VideoInfo | undefined;
let previewFilename = "";
let editorGesture:
  | {
      type: "move";
      layerId: string;
      offsetX: number;
      offsetY: number;
    }
  | {
      type: "resize";
      layerId: string;
      axis: ResizeAxis;
      startPointerX: number;
      startPointerY: number;
      startWidth: number;
      startHeight: number;
    }
  | {
      type: "rotate";
      layerId: string;
      centerX: number;
      centerY: number;
      startPointerAngle: number;
      startRotation: number;
    }
  | undefined;

try {
  const storedLayers = JSON.parse(
    localStorage.getItem("watermarkLayers") ?? "[]",
  ) as WatermarkLayer[];
  if (Array.isArray(storedLayers)) {
    layers = storedLayers.map(normalizeWatermarkLayer);
    selectedLayerId = layers[0]?.id ?? "";
  }
} catch {
  layers = [];
}

app.innerHTML = `
  <main class="app-layout">
    <aside class="sidebar">
      <div class="sidebar-brand" aria-label="JV Studio">
        <img class="brand-mark" src="/app-icon.png" alt="" aria-hidden="true" />
        <strong>JV<br />Studio</strong>
      </div>
      <nav class="tool-nav" aria-label="Video tools">
        <button data-tool="remove" class="tool-nav-item">
          <span class="nav-icon" aria-hidden="true">✦</span>
          <span>Watermark<br />Remove</span>
        </button>
        <button data-tool="watermark" class="tool-nav-item">
          <span class="nav-icon" aria-hidden="true">T</span>
          <span>Custom<br />Watermark</span>
        </button>
        <button data-tool="library" class="tool-nav-item">
          <span class="nav-icon" aria-hidden="true">▦</span>
          <span>Library</span>
        </button>
      </nav>
      <div class="sidebar-footer">
        <div id="active-settings" class="active-settings hidden" aria-label="Active non-default settings"></div>
        <div class="sidebar-social-links" aria-label="Jsonpreet links">
          <button id="sidebar-github" class="sidebar-social-link" title="JV Studio on GitHub">${GITHUB_ICON}<span>GitHub</span></button>
          <button id="sidebar-x" class="sidebar-social-link" title="Jsonpreet on X">${X_ICON}<span>jsonpreet</span></button>
        </div>
        <div id="system-badge" class="system-badge">Checking system…</div>
        <button id="open-settings" class="tool-nav-item compact">
          <span class="nav-icon" aria-hidden="true">⚙</span>
          <span>Settings</span>
        </button>
      </div>
    </aside>

    <section class="shell">
      <header class="app-header">
        <div class="header-copy">
          <div class="title-row">
            <h1>JV Studio</h1>
            <button id="about-inline" class="about-link">About</button>
          </div>
          <p id="tool-subtitle">Remove visible watermarks from multiple videos.</p>
          <div class="app-credit">
            <span>Free edition</span>
            <button id="author-link" class="author-link" title="x.com/jsonpreet">By Jsonpreet ${X_ICON}</button>
            <span id="app-version">${APP_VERSION}</span>
          </div>
        </div>
        <button id="add-videos" class="button secondary">Add videos</button>
      </header>

      <section id="workspace-bar" class="workspace-bar">
        <div class="workspace-copy">
          <span id="tool-kicker" class="eyebrow">Watermark removal</span>
          <h2 id="tool-title">Remove watermarks</h2>
          <p id="tool-description">Add Omini or Veo clips and process them locally.</p>
        </div>
        <button id="choose-output" class="output-card">
          <span class="eyebrow">Output folder</span>
          <strong id="output-value">Choose a folder</strong>
          <span class="chevron">›</span>
        </button>
      </section>

      <section id="tool-controls" class="tool-controls">
        <div id="watermark-panel" class="mode-panel hidden">
          <button id="open-editor" class="button primary">Create watermark</button>
          <div>
            <strong id="active-preset-label">Unsaved watermark · <span id="layer-count">0</span> layers</strong>
            <span class="control-hint">Choose a saved watermark or create a reusable design.</span>
          </div>
          <div id="watermark-preset-list" class="watermark-preset-list"></div>
        </div>

        <div id="upscale-panel" class="mode-panel hidden">
          <label class="upscale-control">Output size
            <select id="upscale-option">
              <option value="1">Choose quality</option>
              <option value="2">2× High quality</option>
              <option value="4">4× Maximum size</option>
            </select>
          </label>
          <span class="control-hint">Uses local hardware acceleration when available. Originals stay untouched.</span>
        </div>
      </section>

      <section id="queue-section" class="queue-section">
        <div class="section-heading">
          <div><h2 id="queue-title">Queue</h2><span id="file-count">0 files</span></div>
          <div>
            <button id="videos-tab" class="text-button tab-button active">Videos</button>
            <button id="logs-tab" class="text-button tab-button hidden">Logs <span id="logs-tab-count">0</span></button>
            <button id="clear-finished" class="text-button">Clear finished</button>
            <button id="clear-all" class="text-button">Clear all</button>
          </div>
        </div>
        <div id="queue" class="queue"></div>
      </section>

      <section id="activity-section" class="activity-section">
        <div class="section-heading">
          <div><h2>Activity</h2><span id="log-count">0 messages</span></div>
        </div>
        <div id="activity-log" class="activity-log"></div>
      </section>

      <footer id="batch-footer" class="footer">
        <div class="overall">
          <div><strong id="current-status">Add videos to begin</strong><span id="completed-summary">0 of 0</span></div>
          <progress id="overall-progress" max="1" value="0"></progress>
        </div>
        <button id="retry-failed" class="button secondary">Retry failed</button>
        <button id="cancel" class="button danger hidden">Cancel</button>
        <button id="start" class="button primary">Start</button>
      </footer>

      <section id="library-page" class="library-page hidden">
        <header class="library-header">
          <div><span class="eyebrow">Local history</span><h2>Your video library</h2><p>Recent imports and completed outputs stored privately on this computer.</p></div>
          <div class="library-filters">
            <button class="filter-chip active" data-history-filter="all">All</button>
            <button class="filter-chip" data-history-filter="completed">Completed</button>
            <button class="filter-chip" data-history-filter="imported">Imported</button>
            <button id="clear-library" class="text-button danger-text">Clear library</button>
            <div class="view-toggle" aria-label="Library view">
              <button class="view-toggle-button" data-history-view="list" aria-label="List view">☷</button>
              <button class="view-toggle-button" data-history-view="grid" aria-label="Grid view">▦</button>
            </div>
          </div>
        </header>
        <div id="history-list" class="history-list"></div>
      </section>
    </section>
  </main>

  <div id="about-modal" class="modal hidden" role="dialog" aria-modal="true" aria-label="About JV Studio">
    <section class="info-dialog">
      <header class="info-header">
        <img class="brand-mark" src="/app-icon.png" alt="" aria-hidden="true" />
        <div>
          <h2>JV Studio</h2>
          <p>By Jsonpreet · <span id="about-version">${APP_VERSION}</span></p>
        </div>
        <button id="close-about" class="icon-button" aria-label="Close About">×</button>
      </header>
      <div class="info-content">
        <p>A local desktop workspace for removing watermarks and adding custom branding to Omini and Veo videos.</p>
        <div class="credit-card">
          <span class="eyebrow">Open-source attribution</span>
          <strong>GeminiWatermarkTool · Video engine v0.6.4</strong>
          <p>Includes GeminiWatermarkTool-Video and watermark-removal technology created by Allen Kuo (<code>allenk</code>) under the upstream MIT terms.</p>
          <button id="about-repository" class="button secondary">GitHub repository ↗</button>
          <button id="about-x" class="button secondary">x.com/jsonpreet ↗</button>
          <button id="open-upstream" class="button secondary">View original repository ↗</button>
          <button id="open-video-upstream" class="button secondary">View video engine repository ↗</button>
        </div>
        <small>Original repository: github.com/allenk/GeminiWatermarkTool</small>
        <small>Video engine: github.com/allenk/VeoWatermarkRemover</small>
        <small>Independent project. Not affiliated with or endorsed by Google.</small>
      </div>
      <footer class="info-footer"><button id="done-about" class="button primary">Done</button></footer>
    </section>
  </div>

  <div id="settings-modal" class="modal hidden" role="dialog" aria-modal="true" aria-label="Settings">
    <section class="settings-dialog">
      <header class="info-header">
        <div><h2>Settings</h2><p>Advanced tools and application information</p></div>
        <button id="close-settings" class="icon-button" aria-label="Close Settings">×</button>
      </header>
      <div class="settings-content">
        <section class="settings-group">
          <div><h3>Advanced processing</h3><p>Optional compatibility and encoding controls.</p></div>
          <label class="settings-toggle"><span><b>Show processing logs</b><small>Add a Logs tab below Watermark Remove for live engine output.</small></span><input id="show-processing-logs" type="checkbox" ${showProcessingLogs ? "checked" : ""} /></label>
          <label class="settings-toggle"><span><b>Legacy watermark profile</b><small>For older Veo text watermarks</small></span><input id="legacy-option" type="checkbox" /></label>
          <label class="settings-toggle"><span><b>ML assist</b><small>Use the removal engine's optional cleanup</small></span><input id="ml-option" type="checkbox" /></label>
          <label class="settings-toggle"><span><b>Encoder</b><small>Hardware is faster; software may improve compatibility</small></span>
            <select id="encoder-option"><option value="auto">Auto hardware</option><option value="software">Software quality</option></select>
          </label>
        </section>
        <section class="settings-group">
          <div><h3>Appearance</h3><p>Use the system appearance or choose a consistent app theme.</p></div>
          <label class="settings-toggle"><span><b>Theme</b><small>Applied immediately across the complete interface.</small></span>
            <select id="app-theme"><option value="system" ${appTheme === "system" ? "selected" : ""}>System</option><option value="light" ${appTheme === "light" ? "selected" : ""}>Light</option><option value="dark" ${appTheme === "dark" ? "selected" : ""}>Dark</option></select>
          </label>
        </section>
        <section class="settings-group">
          <div class="settings-group-header">
            <span><h3>Application</h3><p>Version information, updates, and project details.</p></span>
          </div>
          <div class="settings-row static"><span><b>Current version</b><small>The installed JV Studio Free release.</small></span><span id="settings-version">${APP_VERSION}</span></div>
          <button id="check-updates" class="settings-row"><span><b>Check for updates</b><small id="update-detail">Check the official GitHub Releases channel.</small></span><span id="update-action">Check now</span></button>
          <button id="open-repository" class="settings-row"><span><b>GitHub repository</b><small>Source code, releases, issues, and documentation.</small></span><span>Open</span></button>
          <button id="settings-about" class="settings-row"><span><b>About JV Studio</b><small>Author, attribution, and open-source information.</small></span><span>View</span></button>
        </section>
      </div>
      <footer class="info-footer"><button id="done-settings" class="button primary">Done</button></footer>
    </section>
  </div>

  <div id="editor-modal" class="modal hidden" role="dialog" aria-modal="true" aria-label="Custom watermark editor">
    <section class="editor-dialog">
      <header class="editor-header">
        <div>
          <input id="preset-title" class="preset-title-input" type="text" value="Untitled watermark" aria-label="Watermark name" />
          <p id="preview-label">Choose a queued video to load a preview.</p>
        </div>
        <button id="close-editor" class="icon-button" aria-label="Close editor">×</button>
      </header>
      <div class="editor-body">
        <div class="preview-column">
          <div id="preview-stage" class="preview-stage">
            <div id="preview-placeholder">Add a video, then open the editor.</div>
            <div id="preview-canvas" class="preview-canvas hidden">
              <img id="preview-image" alt="Video preview frame" />
              <div id="preview-overlays"></div>
              <span id="preview-mode-badge" class="preview-mode-badge">Static frame</span>
            </div>
          </div>
          <div class="preview-toolbar">
            <button id="add-text-layer" class="button secondary">+ Text</button>
            <button id="add-image-layer" class="button secondary">+ Image</button>
            <span>Drag to move · side handles resize width or height · corner resizes both · round handle rotates</span>
          </div>
        </div>
        <aside class="layer-sidebar">
          <div id="layer-tabs" class="layer-tabs"></div>
          <div id="layer-controls" class="layer-controls"></div>
        </aside>
      </div>
      <footer class="editor-footer">
        <span>Motion and timing are applied independently to every layer.</span>
        <div>
          <button id="save-preset" class="button secondary">Save watermark</button>
          <button id="done-editor" class="button primary">Done</button>
        </div>
      </footer>
    </section>
  </div>
  <datalist id="font-family-list">
    ${SYSTEM_FONT_FAMILIES.map((family) => `<option value="${family}" label="System font"></option>`).join("")}
    ${googleFontFamilies.map((family) => `<option value="${escapeHtml(family)}"></option>`).join("")}
  </datalist>
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};

const queueElement = byId<HTMLDivElement>("queue");
const logElement = byId<HTMLDivElement>("activity-log");
const startButton = byId<HTMLButtonElement>("start");
const cancelButton = byId<HTMLButtonElement>("cancel");
const retryButton = byId<HTMLButtonElement>("retry-failed");
const showProcessingLogsOption = byId<HTMLInputElement>("show-processing-logs");
const legacyOption = byId<HTMLInputElement>("legacy-option");
const mlOption = byId<HTMLInputElement>("ml-option");
const upscaleOption = byId<HTMLSelectElement>("upscale-option");
const encoderOption = byId<HTMLSelectElement>("encoder-option");
const editorModal = byId<HTMLDivElement>("editor-modal");
const presetTitleInput = byId<HTMLInputElement>("preset-title");

void getVersion()
  .then((version) => {
    byId("app-version").textContent = `v${version}`;
    byId("about-version").textContent = `v${version}`;
    byId("settings-version").textContent = `v${version}`;
  })
  .catch(() => {
    // The packaged app supplies the authoritative version.
  });

legacyOption.checked = useLegacy;
mlOption.checked = useML;
showProcessingLogsOption.checked = showProcessingLogs;
upscaleOption.value = String(upscale);
encoderOption.value = encoderMode;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function thumbnailMarkup(path: string): string {
  const thumbnail = videoThumbnails.get(path);
  return thumbnail?.status === "ready" && thumbnail.dataUrl
    ? `<img class="video-thumbnail" src="${escapeHtml(thumbnail.dataUrl)}" alt="" draggable="false" />`
    : `<span class="video-thumbnail-placeholder" aria-hidden="true">▶</span>`;
}

function scheduleThumbnailRender(): void {
  if (thumbnailRenderTimer !== undefined) return;
  thumbnailRenderTimer = window.setTimeout(() => {
    thumbnailRenderTimer = undefined;
    render();
  }, 60);
}

function runThumbnailQueue(): void {
  if (!ffmpegPath) return;
  while (activeThumbnailWorkers < 2 && thumbnailQueue.length > 0) {
    const path = thumbnailQueue.shift();
    if (!path) continue;
    activeThumbnailWorkers += 1;
    void invoke<string>("video_thumbnail", {
      ffmpegPath,
      inputPath: path,
    })
      .then((dataUrl) => {
        videoThumbnails.set(path, { status: "ready", dataUrl });
      })
      .catch(() => {
        videoThumbnails.set(path, { status: "failed" });
      })
      .finally(() => {
        activeThumbnailWorkers -= 1;
        scheduleThumbnailRender();
        runThumbnailQueue();
      });
  }
}

function ensureVideoThumbnails(paths: string[]): void {
  if (!ffmpegPath) return;
  for (const path of new Set(paths)) {
    if (!path || videoThumbnails.has(path)) continue;
    videoThumbnails.set(path, { status: "loading" });
    thumbnailQueue.push(path);
  }
  runThumbnailQueue();
}

function stateLabel(job: VideoJob): string {
  return {
    pending: "Waiting",
    running: "Processing",
    succeeded: "Done",
    failed: "Failed",
    cancelled: "Cancelled",
  }[job.state];
}

function stateIcon(job: VideoJob): string {
  return {
    pending: "◷",
    running: "◌",
    succeeded: "✓",
    failed: "!",
    cancelled: "×",
  }[job.state];
}

function isToolPage(page: AppPage = activePage): page is ToolMode {
  return page !== "library";
}

function effectiveLayers(): WatermarkLayer[] {
  return activePage === "watermark" ? layers : [];
}

function effectiveUpscale(): number {
  return activePage === "upscale" ? upscale : 1;
}

function needsPostProcessing(): boolean {
  return effectiveUpscale() > 1 || effectiveLayers().length > 0;
}

function serializableLayers(): WatermarkLayer[] {
  return layers.map(
    ({ imageDataUrl: _imageDataUrl, runtimePath: _runtimePath, ...layer }) =>
      layer,
  );
}

function normalizeWatermarkLayer(layer: WatermarkLayer): WatermarkLayer {
  const legacyWidth = Number.isFinite(layer.width)
    ? layer.width
    : effectiveLayerSize(layer);
  return {
    ...layer,
    fontFamily: layer.fontFamily || "Arial",
    fontSize: Number.isFinite(layer.fontSize) ? layer.fontSize : 64,
    textCase: layer.textCase || "none",
    textAlign: ["left", "center", "right"].includes(layer.textAlign)
      ? layer.textAlign
      : "center",
    lineHeight: Number.isFinite(layer.lineHeight)
      ? Math.min(Math.max(layer.lineHeight, 0.8), 2)
      : 1.2,
    padding: Number.isFinite(layer.padding)
      ? Math.min(Math.max(layer.padding, 0), 80)
      : 12,
    width: Math.min(Math.max(legacyWidth, 0.04), 1),
    height: Number.isFinite(layer.height)
      ? Math.min(Math.max(layer.height, 0.03), 1)
      : layer.kind === "text"
        ? 0.12
        : 0.18,
    lockAspectRatio:
      typeof layer.lockAspectRatio === "boolean"
        ? layer.lockAspectRatio
        : layer.kind === "image",
    runtimePath: undefined,
    imageDataUrl: undefined,
  };
}

function persistLayers(): void {
  const serializable = serializableLayers();
  localStorage.setItem("watermarkLayers", JSON.stringify(serializable));
}

function canStart(): boolean {
  if (!isToolPage()) return false;
  const removeWatermark = activePage === "remove";
  const hasWork = removeWatermark || needsPostProcessing();
  const dependenciesReady =
    (!removeWatermark || Boolean(cliPath)) &&
    (!needsPostProcessing() || Boolean(ffmpegPath));
  return (
    !running &&
    hasWork &&
    dependenciesReady &&
    Boolean(outputFolder) &&
    jobs.some((job) => job.state === "pending")
  );
}

const toolCopy: Record<
  ToolMode,
  { kicker: string; title: string; subtitle: string; description: string }
> = {
  remove: {
    kicker: "Watermark removal",
    title: "Remove watermarks",
    subtitle: "Remove visible watermarks from multiple videos.",
    description: "Add Omini or Veo clips and process them locally.",
  },
  watermark: {
    kicker: "Custom watermark",
    title: "Brand your videos",
    subtitle: "Design reusable text and image watermarks visually.",
    description: "Position, animate, and apply multiple watermark layers.",
  },
  upscale: {
    kicker: "Video enhancement",
    title: "Upscale video quality",
    subtitle: "Increase video resolution with local hardware acceleration.",
    description: "Choose 2× or 4× output while preserving the original clip.",
  },
};

function operationLabel(operation: HistoryItem["operation"]): string {
  return {
    remove: "Watermark removed",
    watermark: "Custom watermark",
    upscale: "Upscaled",
  }[operation];
}

interface WatermarkMediaItem {
  path: string;
  status: HistoryItem["status"] | VideoJob["state"];
  source: "Added" | "Generated";
  updatedAt: number;
}

function watermarkMediaItems(): WatermarkMediaItem[] {
  const items = new Map<string, WatermarkMediaItem>();
  for (const item of historyItems) {
    if (isSupportedVideo(item.inputPath)) {
      items.set(item.inputPath, {
        path: item.inputPath,
        status: item.status,
        source: "Added",
        updatedAt: item.updatedAt,
      });
    }
    if (item.outputPath && isSupportedVideo(item.outputPath)) {
      items.set(item.outputPath, {
        path: item.outputPath,
        status: item.status,
        source: "Generated",
        updatedAt: item.updatedAt,
      });
    }
  }
  for (const job of jobs) {
    items.set(job.inputPath, {
      path: job.inputPath,
      status: job.state,
      source: "Added",
      updatedAt: Date.now(),
    });
  }
  return [...items.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function renderWatermarkPresets(): void {
  byId("active-preset-label").innerHTML =
    `${escapeHtml(activePresetId ? presetTitle : "Unsaved watermark")} · <span id="layer-count">${layers.length}</span> layers`;
  byId("watermark-preset-list").innerHTML = watermarkPresets.length
    ? watermarkPresets
        .slice(0, 5)
        .map(
          (preset) => `
            <button class="preset-chip ${preset.id === activePresetId ? "active" : ""}" data-preset-id="${preset.id}">
              ${escapeHtml(preset.title)}
            </button>`,
        )
        .join("")
    : `<span class="empty-presets">No saved watermarks yet</span>`;
}

function renderWatermarkMedia(): void {
  const media = watermarkMediaItems();
  const selectedPaths = new Set(jobs.map((job) => job.inputPath));
  queueElement.classList.add("watermark-media-grid");
  queueElement.innerHTML = `
    <button class="watermark-upload-card" data-add-watermark-videos>
      <span>＋</span>
      <strong>Add videos</strong>
      <small>Upload one or multiple MP4 clips</small>
    </button>
    ${media
      .map((item) => {
        const encodedPath = encodeURIComponent(item.path);
        const selected = selectedPaths.has(item.path);
        return `
          <article class="watermark-media-card ${selected ? "selected" : ""}">
            <label class="media-check">
              <input type="checkbox" data-media-select="${encodedPath}" ${selected ? "checked" : ""} />
              <span>${selected ? "Selected" : "Select"}</span>
            </label>
            <button class="media-preview" data-edit-video="${encodedPath}">
              ${thumbnailMarkup(item.path)}
              <span class="media-play" aria-hidden="true">▶</span>
              <strong title="${escapeHtml(item.path)}">${escapeHtml(filename(item.path))}</strong>
              <small>${item.source} · ${String(item.status).replaceAll("_", " ")}</small>
            </button>
          </article>`;
      })
      .join("")}
    ${
      media.length === 0
        ? `<div class="watermark-media-empty"><strong>Your video library is empty</strong><span>Add videos to design and apply a watermark.</span></div>`
        : ""
    }`;
}

function renderHistory(): void {
  const visible = historyItems.filter((item) => {
    if (historyFilter === "all") return true;
    return item.status === historyFilter;
  });
  const historyList = byId("history-list");
  historyList.classList.toggle("grid-view", historyViewMode === "grid");
  historyList.classList.toggle("list-view", historyViewMode === "list");
  document.querySelectorAll<HTMLElement>("[data-history-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.historyView === historyViewMode);
  });
  document.querySelectorAll<HTMLElement>("[data-history-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.historyFilter === historyFilter);
  });
  historyList.innerHTML =
    visible.length > 0
      ? visible
          .map(
            (item) => {
              const videoPath = item.outputPath || item.inputPath;
              return `
              <article class="history-card">
                <div class="history-thumb">${thumbnailMarkup(videoPath)}</div>
                <div class="history-main">
                  <strong>${escapeHtml(filename(videoPath))}</strong>
                  <span>${operationLabel(item.operation)} · ${new Date(item.updatedAt).toLocaleString()}</span>
                  <small title="${escapeHtml(videoPath)}">${escapeHtml(videoPath)}</small>
                </div>
                <span class="history-status ${item.status}">${item.status}</span>
              </article>`;
            },
          )
          .join("")
      : `<div class="library-empty"><span>▦</span><strong>No videos here yet</strong><p>Imported clips and completed outputs will appear automatically.</p></div>`;
}

function render(): void {
  byId("output-value").textContent = outputFolder || "Choose a folder";
  byId("system-badge").textContent = capabilities
    ? `${ffmpegPath ? "✓" : "!"} ${capabilities.gpuSummary || capabilities.arch}`
    : "Checking system…";
  const activeSettings = [
    useLegacy
      ? {
          label: "Legacy",
          title: "Legacy watermark profile is enabled",
        }
      : undefined,
    useML
      ? {
          label: "ML assist",
          title: "ML-assisted cleanup is enabled",
        }
      : undefined,
    encoderMode !== "auto"
      ? {
          label: "Software",
          title: "Software encoding is selected",
        }
      : undefined,
  ].filter(
    (setting): setting is { label: string; title: string } =>
      setting !== undefined,
  );
  const activeSettingsElement = byId("active-settings");
  activeSettingsElement.classList.toggle(
    "hidden",
    activeSettings.length === 0,
  );
  activeSettingsElement.innerHTML = activeSettings.length
    ? `<span class="active-settings-title">Active settings</span>
       <div class="active-settings-list">
         ${activeSettings
           .map(
             ({ label, title }) =>
               `<span class="active-setting-chip" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`,
           )
           .join("")}
       </div>`
    : "";
  renderWatermarkPresets();
  byId("file-count").textContent =
    activePage === "watermark"
      ? `${jobs.length} selected · ${watermarkMediaItems().length} videos`
      : `${jobs.length} file${jobs.length === 1 ? "" : "s"}`;
  byId("queue-title").textContent =
    activePage === "watermark" ? "Video library" : "Queue";
  byId("log-count").textContent =
    `${logs.length} message${logs.length === 1 ? "" : "s"}`;
  byId("logs-tab-count").textContent = String(logs.length);
  byId("current-status").textContent = currentStatus;
  const finished = jobs.filter((job) =>
    ["succeeded", "failed", "cancelled"].includes(job.state),
  ).length;
  byId("completed-summary").textContent = `${finished} of ${jobs.length}`;
  byId<HTMLProgressElement>("overall-progress").value = overallProgress(jobs);

  const libraryOpen = activePage === "library";
  for (const id of [
    "workspace-bar",
    "queue-section",
    "activity-section",
    "batch-footer",
  ]) {
    byId(id).classList.toggle("hidden", libraryOpen);
  }
  byId("tool-controls").classList.toggle(
    "hidden",
    libraryOpen || activePage === "remove",
  );
  byId("library-page").classList.toggle("hidden", !libraryOpen);
  byId("add-videos").classList.toggle("hidden", libraryOpen);
  const logsVisible =
    !libraryOpen && showProcessingLogs && removeTab === "logs";
  queueElement.classList.toggle("hidden", logsVisible);
  byId("activity-section").classList.toggle("hidden", !logsVisible);
  byId("videos-tab").classList.toggle("active", !logsVisible);
  byId("logs-tab").classList.toggle("active", logsVisible);
  byId("logs-tab").classList.toggle("hidden", !showProcessingLogs);
  document.querySelectorAll<HTMLElement>("[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === activePage);
    if (button instanceof HTMLButtonElement) button.disabled = running;
  });
  if (activePage !== "library") {
    const copy = toolCopy[activePage];
    byId("tool-kicker").textContent = copy.kicker;
    byId("tool-title").textContent = copy.title;
    byId("tool-subtitle").textContent = copy.subtitle;
    byId("tool-description").textContent = copy.description;
    byId("watermark-panel").classList.toggle(
      "hidden",
      activePage !== "watermark",
    );
    byId("upscale-panel").classList.toggle(
      "hidden",
      activePage !== "upscale",
    );
  } else {
    byId("tool-subtitle").textContent =
      "Browse recent imports and completed videos.";
    renderHistory();
  }
  queueElement.classList.toggle("drop-active", dropActive);
  queueElement.classList.toggle(
    "watermark-media-grid",
    activePage === "watermark",
  );
  if (activePage === "watermark") {
    renderWatermarkMedia();
  } else if (jobs.length === 0) {
    queueElement.innerHTML = `
      <div class="drop-zone">
        <div class="drop-icon">⇩</div>
        <strong>Drop multiple MP4 clips here</strong>
        <span>or use Add videos</span>
      </div>`;
  } else {
    queueElement.innerHTML = jobs
      .map(
        (job) => `
          <article class="job-row ${job.state}" data-job-id="${job.id}">
            <div class="job-thumbnail">${thumbnailMarkup(job.inputPath)}</div>
            <div class="state-icon">${stateIcon(job)}</div>
            <div class="job-main">
              <div class="job-title">
                <strong title="${escapeHtml(job.inputPath)}">${escapeHtml(filename(job.inputPath))}</strong>
                <span class="status-pill">${stateLabel(job)}</span>
              </div>
              <progress max="1" value="${job.progress}"></progress>
              <small>${escapeHtml(job.detail)}</small>
            </div>
            ${
              job.state === "failed" || job.state === "cancelled"
                ? `<button class="row-action retry-one" ${running ? "disabled" : ""}>Retry</button>`
                : job.state === "running"
                  ? `<button class="row-action cancel-one">Cancel</button>`
                  : `<button class="icon-button remove-one" title="Remove from queue" ${running ? "disabled" : ""}>×</button>`
            }
          </article>`,
      )
      .join("");
  }

  logElement.innerHTML = logs
    .map(
      (entry) => `
        <div class="log-line ${entry.level.toLowerCase()}">
          <time>${entry.time.toLocaleTimeString([], { hour12: false })}</time>
          <b>${entry.level}</b>
          ${entry.filename ? `<span title="${escapeHtml(entry.filename)}">${escapeHtml(entry.filename)}</span>` : ""}
          <code>${escapeHtml(entry.message)}</code>
        </div>`,
    )
    .join("");
  logElement.scrollTop = logElement.scrollHeight;

  startButton.disabled = !canStart();
  const pendingCount = jobs.filter((job) => job.state === "pending").length;
  startButton.textContent =
    activePage === "watermark"
      ? `Apply to ${pendingCount} video${pendingCount === 1 ? "" : "s"}`
      : "Start";
  startButton.classList.toggle("hidden", running);
  cancelButton.classList.toggle("hidden", !running);
  retryButton.classList.toggle("hidden", running);
  retryButton.disabled = !jobs.some((job) =>
    ["failed", "cancelled"].includes(job.state),
  );
  byId("clear-finished").classList.toggle(
    "hidden",
    activePage === "watermark",
  );
  byId("clear-all").textContent =
    activePage === "watermark" ? "Clear selection" : "Clear all";

  for (const id of [
    "add-videos",
    "choose-output",
    "clear-finished",
    "clear-all",
    "clear-library",
    "open-editor",
    "open-settings",
  ]) {
    byId<HTMLButtonElement>(id).disabled = running;
  }
  legacyOption.disabled = running;
  mlOption.disabled = running;
  showProcessingLogsOption.disabled = running;
  upscaleOption.disabled =
    running || !Boolean(capabilities?.standardUpscaleAvailable);
  encoderOption.disabled = running;

  const thumbnailPaths =
    activePage === "library"
      ? historyItems.map((item) => item.outputPath || item.inputPath)
      : activePage === "watermark"
        ? watermarkMediaItems().map((item) => item.path)
        : jobs.map((job) => job.inputPath);
  ensureVideoThumbnails(thumbnailPaths);
}

function addLog(
  level: LogEntry["level"],
  message: string,
  file?: string,
): void {
  logs.push({
    id: crypto.randomUUID(),
    time: new Date(),
    level,
    filename: file,
    message,
  });
  render();
}

async function updateHistory(
  job: VideoJob,
  status: HistoryItem["status"],
): Promise<void> {
  if (activePage === "library") return;
  const operation: ToolMode = activePage;
  const now = Date.now();
  const existing = historyItems.find((item) => item.id === job.id);
  const item: HistoryItem = {
    id: job.id,
    inputPath: job.inputPath,
    outputPath: job.outputPath,
    operation: existing?.operation ?? operation,
    status,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  historyItems = [item, ...historyItems.filter((entry) => entry.id !== item.id)];
  renderHistory();
  try {
    await invoke("upsert_history", { item });
  } catch (error) {
    addLog("ERROR", `Library could not be updated: ${String(error)}`);
  }
}

function addVideos(paths: string[]): void {
  if (running) return;
  const known = new Set(jobs.map((job) => job.inputPath));
  let added = 0;
  for (const path of paths) {
    if (!isSupportedVideo(path) || known.has(path)) continue;
    const job: VideoJob = {
      id: crypto.randomUUID(),
      inputPath: path,
      state: "pending",
      progress: 0,
      detail: "Ready",
      attempt: 0,
    };
    jobs.push(job);
    void updateHistory(job, "imported");
    known.add(path);
    added += 1;
  }
  if (added) {
    currentStatus = `${jobs.length} video${jobs.length === 1 ? "" : "s"} ready`;
    addLog("INFO", `Added ${added} video${added === 1 ? "" : "s"}`);
  } else {
    render();
  }
}

async function chooseVideos(): Promise<void> {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "MP4 video clips", extensions: ["mp4"] }],
  });
  if (!selected) return;
  addVideos(Array.isArray(selected) ? selected : [selected]);
}

async function chooseOutput(): Promise<void> {
  const selected = await open({
    multiple: false,
    directory: true,
    title: "Choose output folder",
  });
  if (typeof selected !== "string") return;
  outputFolder = selected;
  localStorage.setItem("outputFolder", outputFolder);
  addLog("INFO", `Output folder: ${outputFolder}`);
}

function consumeCliOutput(payload: CliOutput): void {
  const job = jobs.find((candidate) => candidate.id === payload.jobId);
  if (!job) return;

  const progress = parseProgress(payload.text);
  if (progress !== undefined) {
    const hasTwoPhases = activePage === "remove" && needsPostProcessing();
    job.progress = hasTwoPhases
      ? job.phase === "post"
        ? 0.5 + progress * 0.5
        : progress * 0.5
      : progress;
    job.detail = `${job.phase === "post" ? "Finishing" : "Removing"} · ${Math.round(progress * 100)}%`;
  }

  for (const rawLine of payload.text.split(/[\r\n]+/)) {
    const line = rawLine.trim();
    if (!line || parseProgress(line) !== undefined) continue;
    const looksLikeError = /\b(error|failed|fatal)\b/i.test(line);
    addLog(looksLikeError ? "ERROR" : "INFO", line, filename(job.inputPath));
  }
  render();
}

function fontFamilyCss(fontFamily: string): string {
  const safeFamily = (fontFamily || "Arial").replaceAll("'", "\\'");
  return `'${safeFamily}', Arial, sans-serif`;
}

async function ensureFontLoaded(fontFamily: string): Promise<void> {
  if (!GOOGLE_FONT_SET.has(fontFamily)) return;
  const existing = loadedFontPromises.get(fontFamily);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily).replaceAll("%20", "+")}&display=swap`;
      const response = await fetch(cssUrl);
      if (!response.ok) return;
      const css = await response.text();
      const faces: FontFace[] = [];
      for (const match of css.matchAll(/@font-face\s*{([\s\S]*?)}/g)) {
        const block = match[1];
        const source = block
          .match(/src:\s*url\(([^)]+)\)/)?.[1]
          ?.trim()
          .replace(/^['"]|['"]$/g, "");
        if (!source) continue;
        const fontResponse = await fetch(source);
        if (!fontResponse.ok) continue;
        const fontData = await fontResponse.arrayBuffer();
        const fontFace = new FontFace(fontFamily, fontData, {
          style: block.match(/font-style:\s*([^;]+)/)?.[1]?.trim() ?? "normal",
          weight: block.match(/font-weight:\s*([^;]+)/)?.[1]?.trim() ?? "400",
          unicodeRange:
            block.match(/unicode-range:\s*([^;]+)/)?.[1]?.trim() ?? "U+0-10FFFF",
          display: "swap",
        });
        faces.push(fontFace);
      }
      const loadedFaces = await Promise.all(
        faces.map((face) => face.load().catch(() => undefined)),
      );
      for (const face of loadedFaces) {
        if (face) document.fonts.add(face);
      }
      await document.fonts
        .load(`64px ${fontFamilyCss(fontFamily)}`)
        .catch(() => undefined);
    } catch {
      // The system fallback remains usable when the computer is offline.
    }
  })();
  loadedFontPromises.set(fontFamily, promise);
  return promise;
}

function displayText(layer: WatermarkLayer): string {
  return applyTextCase(layer.text, layer.textCase);
}

function previewTextPixels(layer: WatermarkLayer): number {
  const sourceWidth = previewInfo?.width || 1280;
  const canvasWidth = byId<HTMLDivElement>("preview-canvas").clientWidth || 640;
  return Math.min(
    Math.max((layer.fontSize * canvasWidth) / sourceWidth, 4),
    160,
  );
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
        continue;
      }
      lines.push(line);
      line = word;
      while (context.measureText(line).width > maxWidth && line.length > 1) {
        let splitAt = line.length - 1;
        while (splitAt > 1 && context.measureText(line.slice(0, splitAt)).width > maxWidth) {
          splitAt -= 1;
        }
        lines.push(line.slice(0, splitAt));
        line = line.slice(splitAt);
      }
    }
    lines.push(line);
  }
  return lines;
}

async function renderTextPng(
  layer: WatermarkLayer,
  info: VideoInfo,
): Promise<string> {
  await ensureFontLoaded(layer.fontFamily);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  const rasterScale = Math.min(Math.max(2, 2160 / Math.max(info.width, info.height)), 3);
  const rasterFontSize = Math.min(Math.max(layer.fontSize, 12), 200) * rasterScale;
  canvas.width = Math.min(Math.max(Math.round(info.width * layer.width * rasterScale), 32), 4096);
  canvas.height = Math.min(Math.max(Math.round(info.height * layer.height * rasterScale), 24), 4096);
  const font = `${layer.bold ? "700" : "400"} ${rasterFontSize}px ${fontFamilyCss(layer.fontFamily)}`;
  const text = displayText(layer) || " ";
  context.font = font;
  const draw = canvas.getContext("2d");
  if (!draw) throw new Error("Canvas is unavailable");
  draw.font = font;
  const padding = Math.min(
    Math.max(layer.padding * rasterScale, 0),
    Math.max(Math.min(canvas.width, canvas.height) / 2 - 2, 0),
  );
  const lines = wrapCanvasText(draw, text, Math.max(canvas.width - padding * 2, 1));
  const lineHeight = rasterFontSize * Math.min(Math.max(layer.lineHeight, 0.8), 2);
  const align = layer.textAlign;
  const x = align === "left" ? padding : align === "right" ? canvas.width - padding : canvas.width / 2;
  draw.textAlign = align;
  draw.textBaseline = "top";
  draw.lineJoin = "round";
  if (layer.shadow) {
    draw.shadowColor = "rgba(0,0,0,.75)";
    draw.shadowBlur = 18;
    draw.shadowOffsetX = 8;
    draw.shadowOffsetY = 8;
  }
  if (layer.outline) {
    draw.strokeStyle = "rgba(0,0,0,.9)";
    draw.lineWidth = Math.max(2, rasterScale * 2);
  }
  draw.fillStyle = layer.color;
  for (const [index, line] of lines.entries()) {
    const y = padding + index * lineHeight;
    if (y + lineHeight > canvas.height + 1) break;
    if (layer.outline) draw.strokeText(line, x, y);
    draw.fillText(line, x, y);
  }
  return canvas.toDataURL("image/png");
}

async function materializeLayers(
  info: VideoInfo,
): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = [];
  for (const layer of effectiveLayers()) {
    let imagePath = layer.imagePath;
    if (layer.kind === "text") {
      imagePath = await invoke<string>("save_overlay_data", {
        dataUrl: await renderTextPng(layer, info),
        layerId: layer.id,
      });
      layer.runtimePath = imagePath;
    }
    if (!imagePath) continue;
    result.push({
      imagePath,
      widthFraction: layer.width,
      heightFraction: layer.height,
      lockAspectRatio: layer.kind === "image" && layer.lockAspectRatio,
      opacity: layer.opacity,
      rotation: layer.rotation,
      x: layer.x,
      y: layer.y,
      startSeconds: Math.max(layer.startSeconds, 0),
      endSeconds:
        layer.endSeconds <= 0
          ? info.duration
          : Math.min(layer.endSeconds, info.duration),
      motion: layer.motion,
      zIndex: layer.zIndex,
    });
  }
  return result;
}

async function removeTemporary(path: string | undefined): Promise<void> {
  if (!path) return;
  try {
    await invoke("remove_intermediate", { path });
  } catch {
    // Cleanup failure is logged only by the operating system; it must not fail a completed job.
  }
}

async function startBatch(): Promise<void> {
  if (!canStart()) return;
  if (!isToolPage()) return;
  const operation = activePage;
  running = true;
  stopRequested = false;
  currentStatus = "Starting batch…";
  addLog("INFO", "Batch started");

  for (const job of jobs) {
    if (job.state !== "pending" || stopRequested) continue;
    const reserved = jobs
      .map((candidate) => candidate.outputPath)
      .filter((path): path is string => Boolean(path));
    let intermediate: string | undefined;

    try {
      job.outputPath = await invoke<string>("suggest_output_path", {
        inputPath: job.inputPath,
        outputDir: outputFolder,
        reserved,
      });
      job.state = "running";
      job.progress = 0;
      job.attempt += 1;
      await updateHistory(job, "processing");
      currentStatus = `Processing ${filename(job.inputPath)}`;
      addLog("INFO", "Processing started", filename(job.inputPath));

      const postNeeded = needsPostProcessing();
      let postInput = job.inputPath;
      if (operation === "remove") {
        job.phase = "remove";
        job.detail = "Launching removal engine…";
        intermediate = postNeeded
          ? `${job.outputPath}.gvt-intermediate-${job.id}.mp4`
          : undefined;
        const removalOutput = intermediate ?? job.outputPath;
        const removal = await invoke<ProcessResult>("process_video", {
          request: {
            jobId: job.id,
            cliPath,
            inputPath: job.inputPath,
            outputPath: removalOutput,
            legacy: useLegacy,
            ml: useML,
          },
        });
        if (removal.cancelled || stopRequested) {
          throw new Error("CANCELLED");
        }
        if (removal.exitCode !== 0 || !removal.outputExists) {
          throw new Error(`Removal engine exited with code ${removal.exitCode}`);
        }
        postInput = removalOutput;
      }

      if (postNeeded) {
        job.phase = "post";
        job.detail = "Preparing enhancement and watermark layers…";
        const info = await invoke<VideoInfo>("probe_video", {
          ffmpegPath,
          inputPath: postInput,
        });
        const postLayers = await materializeLayers(info);
        const encoder =
          encoderMode === "auto" && capabilities?.hardwareEncoder
            ? capabilities.hardwareEncoder
            : "mpeg4";
        const processed = await invoke<ProcessResult>("post_process_video", {
          request: {
            jobId: job.id,
            ffmpegPath,
            inputPath: postInput,
            outputPath: job.outputPath,
            duration: info.duration,
            sourceWidth: info.width,
            sourceHeight: info.height,
            upscale: operation === "upscale" ? upscale : 1,
            encoder,
            layers: postLayers,
          },
        });
        if (processed.cancelled || stopRequested) {
          throw new Error("CANCELLED");
        }
        if (processed.exitCode !== 0 || !processed.outputExists) {
          throw new Error(`FFmpeg exited with code ${processed.exitCode}`);
        }
      }

      await removeTemporary(intermediate);
      intermediate = undefined;
      job.state = "succeeded";
      job.progress = 1;
      job.detail = `Saved ${filename(job.outputPath)}`;
      await updateHistory(job, "completed");
      addLog("OK", `Saved ${job.outputPath}`, filename(job.inputPath));
    } catch (error) {
      await removeTemporary(intermediate);
      const cancelled = stopRequested || String(error).includes("CANCELLED");
      job.state = cancelled ? "cancelled" : "failed";
      job.detail = cancelled ? "Cancelled" : String(error);
      await updateHistory(job, cancelled ? "cancelled" : "failed");
      addLog(
        cancelled ? "INFO" : "ERROR",
        job.detail,
        filename(job.inputPath),
      );
      if (cancelled) break;
    }
    render();
  }

  running = false;
  if (stopRequested) {
    currentStatus = "Batch cancelled; unprocessed files remain in the queue";
  } else {
    const succeeded = jobs.filter((job) => job.state === "succeeded").length;
    const failed = jobs.filter((job) => job.state === "failed").length;
    currentStatus = `Finished: ${succeeded} succeeded, ${failed} failed`;
    addLog("INFO", currentStatus);
  }
  render();
}

async function cancelBatch(): Promise<void> {
  if (!running) return;
  stopRequested = true;
  currentStatus = "Cancelling…";
  render();
  addLog("INFO", "Cancellation requested");
  await invoke("cancel_current");
}

function retryJobs(ids: Set<string>): void {
  if (running) return;
  for (const job of jobs) {
    if (!ids.has(job.id)) continue;
    job.state = "pending";
    job.progress = 0;
    job.outputPath = undefined;
    job.detail = "Ready to retry";
  }
  void startBatch();
}

function setWatermarkVideoSelected(path: string, selected: boolean): void {
  if (running || !isSupportedVideo(path)) return;
  const existing = jobs.find((job) => job.inputPath === path);
  if (!selected) {
    jobs = jobs.filter((job) => job.inputPath !== path);
    currentStatus = `${jobs.length} video${jobs.length === 1 ? "" : "s"} selected`;
    render();
    return;
  }
  if (existing) {
    existing.state = "pending";
    existing.progress = 0;
    existing.outputPath = undefined;
    existing.detail = "Ready";
    render();
    return;
  }
  addVideos([path]);
}

function loadWatermarkPreset(id: string): void {
  const preset = watermarkPresets.find((item) => item.id === id);
  if (!preset) return;
  try {
    const savedLayers = JSON.parse(preset.layersJson) as WatermarkLayer[];
    if (!Array.isArray(savedLayers)) throw new Error("Invalid layer data");
    layers = savedLayers.map(normalizeWatermarkLayer);
    activePresetId = preset.id;
    presetTitle = preset.title;
    selectedLayerId = layers[0]?.id ?? "";
    persistLayers();
    currentStatus = `Selected watermark: ${preset.title}`;
    render();
  } catch (error) {
    addLog("ERROR", `Could not load watermark: ${String(error)}`);
  }
}

async function saveWatermarkPreset(): Promise<void> {
  const title = presetTitle.trim() || "Untitled watermark";
  const now = Date.now();
  const existing = watermarkPresets.find((item) => item.id === activePresetId);
  const preset: WatermarkPreset = {
    id: activePresetId || crypto.randomUUID(),
    title,
    layersJson: JSON.stringify(serializableLayers()),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  try {
    await invoke("upsert_watermark_preset", { preset });
    activePresetId = preset.id;
    presetTitle = preset.title;
    watermarkPresets = [
      preset,
      ...watermarkPresets.filter((item) => item.id !== preset.id),
    ];
    currentStatus = `Saved watermark: ${preset.title}`;
    renderEditor();
    render();
  } catch (error) {
    addLog("ERROR", `Could not save watermark: ${String(error)}`);
  }
}

function createWatermarkDesign(): void {
  activePresetId = "";
  presetTitle = "Untitled watermark";
  layers = [];
  selectedLayerId = "";
  persistLayers();
  void openWatermarkEditor();
}

async function openWatermarkEditor(inputPath?: string): Promise<void> {
  editorOpen = true;
  editorModal.classList.remove("hidden");
  previewDataUrl = "";
  previewInfo = undefined;
  previewFilename = "";
  renderEditor();
  const source =
    (inputPath ? jobs.find((job) => job.inputPath === inputPath) : undefined) ??
    jobs.find((job) => job.state === "pending") ??
    jobs[0];
  if (!source || !ffmpegPath) return;

  try {
    for (const layer of layers) {
      if (layer.kind === "image" && layer.imagePath && !layer.imageDataUrl) {
        layer.imageDataUrl = await invoke<string>("read_image_data_url", {
          path: layer.imagePath,
        });
      }
    }
    previewFilename = filename(source.inputPath);
    previewInfo = await invoke<VideoInfo>("probe_video", {
      ffmpegPath,
      inputPath: source.inputPath,
    });
    previewDataUrl = await invoke<string>("extract_preview", {
      ffmpegPath,
      inputPath: source.inputPath,
      atSeconds: Math.min(1, previewInfo.duration * 0.1),
    });
    renderEditor();
  } catch (error) {
    addLog("ERROR", `Preview unavailable: ${String(error)}`);
  }
}

function closeWatermarkEditor(): void {
  editorOpen = false;
  editorModal.classList.add("hidden");
  render();
}

function setModal(id: "about-modal" | "settings-modal", open: boolean): void {
  byId(id).classList.toggle("hidden", !open);
}

const versionParts = (version: string): number[] =>
  version.replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);

function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = versionParts(latest);
  const currentParts = versionParts(current);
  const length = Math.max(latestParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const latestPart = latestParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (latestPart !== currentPart) return latestPart > currentPart;
  }
  return false;
}

async function applyTheme(): Promise<void> {
  try {
    await getCurrentWindow().setTheme(appTheme === "system" ? null : appTheme);
  } catch (error) {
    console.warn("Could not apply the selected app theme", error);
  }
}

function selectPage(page: AppPage): void {
  if (running) return;
  activePage = page;
  localStorage.setItem("activePage", activePage);
  currentStatus =
    page === "library"
      ? `${historyItems.length} recent video${historyItems.length === 1 ? "" : "s"}`
      : jobs.length
        ? `${jobs.length} video${jobs.length === 1 ? "" : "s"} ready`
        : "Add videos to begin";
  render();
}

function selectedLayer(): WatermarkLayer | undefined {
  return layers.find((layer) => layer.id === selectedLayerId);
}

function activePositionPreset(
  layer: WatermarkLayer,
): (typeof POSITION_PRESETS)[number] | undefined {
  return POSITION_PRESETS.find(
    (preset) =>
      Math.abs(layer.x - preset.x) < 0.005 &&
      Math.abs(layer.y - preset.y) < 0.005,
  );
}

function previewContent(layer: WatermarkLayer): string {
  if (layer.kind === "image" && layer.imageDataUrl) {
    return `<img src="${layer.imageDataUrl}" alt="" draggable="false" style="object-fit:${layer.lockAspectRatio ? "contain" : "fill"}" />`;
  }
  return `<span style="color:${layer.color};font-family:${fontFamilyCss(layer.fontFamily)};font-size:${previewTextPixels(layer)}px;font-weight:${layer.bold ? 700 : 400};line-height:${layer.lineHeight};padding:${layer.padding * (previewTextPixels(layer) / Math.max(layer.fontSize, 1))}px;text-align:${layer.textAlign};${layer.shadow ? "text-shadow:0 2px 5px #000;" : ""}${layer.outline ? "-webkit-text-stroke:1px #000;" : ""}">${escapeHtml(displayText(layer))}</span>`;
}

function layoutOverlays(): void {
  const canvas = byId<HTMLDivElement>("preview-canvas");
  for (const layer of layers) {
    const element = canvas.querySelector<HTMLElement>(
      `[data-overlay-id="${layer.id}"]`,
    );
    if (!element) continue;
    positionOverlay(element, layer);
  }
}

function positionOverlay(
  element: HTMLElement,
  layer: WatermarkLayer,
): void {
  element.style.width = `${layer.width * 100}%`;
  element.style.height = `${layer.height * 100}%`;
  const text = element.querySelector<HTMLElement>(
    ".preview-overlay-content span",
  );
  if (text) {
    const scale = previewTextPixels(layer) / Math.max(layer.fontSize, 1);
    text.style.fontSize = `${previewTextPixels(layer)}px`;
    text.style.padding = `${layer.padding * scale}px`;
    text.style.lineHeight = String(layer.lineHeight);
    text.style.textAlign = layer.textAlign;
  }
  element.style.left = `${layer.x * 100}%`;
  element.style.top = `${layer.y * 100}%`;
  element.style.translate = `${layer.x * -100}% ${layer.y * -100}%`;
  element.style.transform = `rotate(${layer.rotation}deg)`;
}

function renderEditor(): void {
  if (!editorOpen) return;
  if (document.activeElement !== presetTitleInput) {
    presetTitleInput.value = presetTitle;
  }
  byId("preview-label").textContent = previewInfo
    ? `${previewFilename} · ${aspectRatioLabel(previewInfo.width, previewInfo.height)} · ${previewInfo.width}×${previewInfo.height} · static frame`
    : jobs.length === 0
      ? "Add a queued video to load its preview."
      : ffmpegPath
        ? "Loading preview…"
        : "FFmpeg is required for video previews.";
  const placeholder = byId("preview-placeholder");
  const canvas = byId<HTMLDivElement>("preview-canvas");
  placeholder.textContent =
    jobs.length === 0
      ? "Add a video, then open the editor."
      : ffmpegPath
        ? "Loading a static preview frame…"
        : "FFmpeg is required for video previews.";
  placeholder.classList.toggle("hidden", Boolean(previewDataUrl));
  canvas.classList.toggle("hidden", !previewDataUrl);
  if (previewDataUrl) {
    const image = byId<HTMLImageElement>("preview-image");
    if (image.getAttribute("src") !== previewDataUrl) {
      image.onload = () => requestAnimationFrame(layoutOverlays);
      image.src = previewDataUrl;
    }
    image.alt = `${previewFilename} static preview frame`;
    byId("preview-mode-badge").textContent = previewInfo
      ? `Static frame · ${aspectRatioLabel(previewInfo.width, previewInfo.height)}`
      : "Static frame";
  }

  byId("preview-overlays").innerHTML = layers
    .map(
      (layer) => `
        <div class="preview-overlay ${layer.id === selectedLayerId ? "selected" : ""}"
          data-overlay-id="${layer.id}"
          title="${escapeHtml(layer.name)} · ${layer.motion}"
          style="width:${layer.width * 100}%;height:${layer.height * 100}%;left:${layer.x * 100}%;top:${layer.y * 100}%;translate:${layer.x * -100}% ${layer.y * -100}%;transform:rotate(${layer.rotation}deg)">
          <div class="preview-overlay-content" style="opacity:${Math.max(layer.opacity, 0.15)}">
            ${previewContent(layer)}
          </div>
          <small>${layer.motion === "static" ? "" : layer.motion.replaceAll("-", " ")}</small>
          ${
            layer.id === selectedLayerId
              ? `
                <span class="rotation-stem" aria-hidden="true"></span>
                <button class="transform-handle rotate-handle" type="button"
                  data-rotate-layer="${layer.id}" aria-label="Rotate ${escapeHtml(layer.name)}"></button>
                <button class="transform-handle resize-width-handle" type="button"
                  data-resize-axis="width" aria-label="Resize width of ${escapeHtml(layer.name)}"></button>
                <button class="transform-handle resize-height-handle" type="button"
                  data-resize-axis="height" aria-label="Resize height of ${escapeHtml(layer.name)}"></button>
                <button class="transform-handle resize-both-handle" type="button"
                  data-resize-axis="both" aria-label="Resize ${escapeHtml(layer.name)}"></button>`
              : ""
          }
        </div>`,
    )
    .join("");

  byId("layer-tabs").innerHTML =
    layers
      .map(
        (layer) => `
          <button class="${layer.id === selectedLayerId ? "active" : ""}" data-layer-id="${layer.id}">
            <span>${layer.kind === "text" ? "T" : "▧"}</span>
            ${escapeHtml(layer.name)}
          </button>`,
      )
      .join("") || `<p class="empty-layers">Add a text or image watermark.</p>`;

  const layer = selectedLayer();
  byId("layer-controls").innerHTML = layer
    ? `
      ${layer.kind === "text" ? `
        <label>Text<input data-field="text" type="text" value="${escapeHtml(layer.text)}" /></label>
        <label>Font family
          <input class="font-family-input" data-field="fontFamily" type="text"
            list="font-family-list" value="${escapeHtml(layer.fontFamily)}"
            placeholder="Search ${googleFontFamilies.length.toLocaleString()} Google Fonts" autocomplete="off" />
          <small class="control-hint">${googleFontFamilies.length.toLocaleString()} Google Fonts · selected fonts download on first use</small>
        </label>
        <label>Text case
          <select class="layer-select" data-field="textCase">
            ${[
              ["none", "As typed"],
              ["capitalize", "Capitalize Each Word"],
              ["uppercase", "UPPERCASE"],
              ["lowercase", "lowercase"],
            ]
              .map(([value, label]) => `<option value="${value}" ${layer.textCase === value ? "selected" : ""}>${label}</option>`)
              .join("")}
          </select>
        </label>
        <label>Text size <output id="font-size-value">${Math.round(layer.fontSize)} px</output>
          <input data-field="fontSize" type="range" min="12" max="200" step="1" value="${layer.fontSize}" />
        </label>
        <label>Text alignment
          <select class="layer-select" data-field="textAlign">
            ${[["left", "Left"], ["center", "Center"], ["right", "Right"]]
              .map(([value, label]) => `<option value="${value}" ${layer.textAlign === value ? "selected" : ""}>${label}</option>`)
              .join("")}
          </select>
        </label>
        <div class="control-grid">
          <label>Line spacing <output id="line-height-value">${layer.lineHeight.toFixed(2)}×</output>
            <input data-field="lineHeight" type="range" min="0.8" max="2" step="0.05" value="${layer.lineHeight}" />
          </label>
          <label>Text padding <output id="padding-value">${Math.round(layer.padding)} px</output>
            <input data-field="padding" type="range" min="0" max="80" step="1" value="${layer.padding}" />
          </label>
        </div>
        <div class="control-grid text-style-grid">
          <label>Colour<input data-field="color" type="color" value="${layer.color}" /></label>
          <label class="layer-switch-row"><span>Bold</span><input class="layer-switch" data-field="bold" type="checkbox" ${layer.bold ? "checked" : ""} /></label>
          <label class="layer-switch-row"><span>Shadow</span><input class="layer-switch" data-field="shadow" type="checkbox" ${layer.shadow ? "checked" : ""} /></label>
          <label class="layer-switch-row"><span>Outline</span><input class="layer-switch" data-field="outline" type="checkbox" ${layer.outline ? "checked" : ""} /></label>
        </div>` : `
          <label>Image<strong>${escapeHtml(filename(layer.imagePath ?? ""))}</strong></label>
          <label class="layer-switch-row"><span>Keep image proportions</span><input class="layer-switch" data-field="lockAspectRatio" type="checkbox" ${layer.lockAspectRatio ? "checked" : ""} /></label>`}
      <label>Motion
        <select class="layer-select" data-field="motion">
          ${[
            ["static", "Static"],
            ["right-to-left", "Scroll right → left"],
            ["left-to-right", "Scroll left → right"],
            ["top-to-bottom", "Scroll top → bottom"],
            ["bottom-to-top", "Scroll bottom → top"],
            ["diagonal", "Diagonal"],
            ["bounce", "Bounce"],
          ]
            .map(([value, label]) => `<option value="${value}" ${layer.motion === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
      </label>
      <label>Opacity <output id="opacity-value">${Math.round(layer.opacity * 100)}%</output>
        <input data-field="opacity" type="range" min="0.05" max="1" step="0.01" value="${layer.opacity}" />
      </label>
      <div class="control-grid">
        <label>Box width <output id="width-value">${Math.round(layer.width * 100)}%</output>
          <input data-field="width" type="range" min="0.04" max="1" step="0.01" value="${layer.width}" />
        </label>
        <label>Box height <output id="height-value">${Math.round(layer.height * 100)}%</output>
          <input data-field="height" type="range" min="0.03" max="1" step="0.01" value="${layer.height}" />
        </label>
      </div>
      <label>Rotation <output id="rotation-value">${Math.round(layer.rotation)}°</output>
        <input data-field="rotation" type="range" min="-180" max="180" step="1" value="${layer.rotation}" />
      </label>
      <section class="position-section" aria-label="Position and timing">
        <div class="position-section-heading">
          <b>Position</b>
          <output id="position-value">${activePositionPreset(layer)?.label ?? "Custom"}</output>
        </div>
        <div class="position-section-content">
          <div class="position-grid" role="group" aria-label="Quick watermark position">
            ${POSITION_PRESETS.map((preset) => {
              const active = activePositionPreset(layer)?.id === preset.id;
              return `
                <button type="button" class="${active ? "active" : ""}"
                  data-position-id="${preset.id}" aria-label="${preset.label}"
                  aria-pressed="${active}">
                  <span aria-hidden="true"></span>
                </button>`;
            }).join("")}
          </div>
          <div class="position-number-grid">
            <label>X<input data-field="x" type="number" min="0" max="100" step="1" value="${Math.round(layer.x * 100)}" /></label>
            <label>Y<input data-field="y" type="number" min="0" max="100" step="1" value="${Math.round(layer.y * 100)}" /></label>
            <label>Start<input data-field="startSeconds" type="number" min="0" step=".1" value="${layer.startSeconds}" /></label>
            <label>End<input data-field="endSeconds" type="number" min="0" step=".1" value="${layer.endSeconds}" placeholder="Full video" /></label>
            <label class="position-layer-order">Layer order<input data-field="zIndex" type="number" step="1" value="${layer.zIndex}" /></label>
          </div>
        </div>
      </section>
      <button id="delete-layer" class="button danger wide">Delete layer</button>`
    : "";

  requestAnimationFrame(layoutOverlays);
  for (const textLayer of layers.filter((item) => item.kind === "text")) {
    void ensureFontLoaded(textLayer.fontFamily).then(() => {
      if (editorOpen) updateLayerPreview(textLayer, "fontFamily");
    });
  }
}

function updateLayerField(
  layer: WatermarkLayer,
  field: string,
  input: HTMLInputElement | HTMLSelectElement,
): void {
  if (["bold", "shadow", "outline", "lockAspectRatio"].includes(field)) {
    (layer as unknown as Record<string, unknown>)[field] =
      (input as HTMLInputElement).checked;
  } else if (
    ["text", "color", "motion", "fontFamily", "textCase", "textAlign"].includes(field)
  ) {
    (layer as unknown as Record<string, unknown>)[field] = input.value;
  } else {
    let value = Number(input.value);
    if (field === "x" || field === "y") value /= 100;
    (layer as unknown as Record<string, unknown>)[field] = value;
  }
  layer.runtimePath = undefined;
  persistLayers();
  updateLayerPreview(layer, field);
  if (field === "fontFamily") {
    void ensureFontLoaded(layer.fontFamily).then(() =>
      updateLayerPreview(layer, field),
    );
  }
}

function updateLayerPreview(layer: WatermarkLayer, field: string): void {
  const element = byId("preview-canvas").querySelector<HTMLElement>(
    `[data-overlay-id="${layer.id}"]`,
  );
  if (!element) return;
  const content = element.querySelector<HTMLElement>(
    ".preview-overlay-content",
  );
  if (
    content &&
    [
      "text",
      "color",
      "bold",
      "shadow",
      "outline",
      "fontFamily",
      "fontSize",
      "textCase",
      "textAlign",
      "lineHeight",
      "padding",
      "lockAspectRatio",
    ].includes(field)
  ) {
    content.innerHTML = previewContent(layer);
    positionOverlay(element, layer);
  }
  if (content && field === "opacity") {
    content.style.opacity = String(Math.max(layer.opacity, 0.15));
    byId<HTMLOutputElement>("opacity-value").value =
      `${Math.round(layer.opacity * 100)}%`;
  }
  if (field === "width" || field === "height") {
    positionOverlay(element, layer);
    const output = document.getElementById(`${field}-value`) as HTMLOutputElement | null;
    if (output) output.value = `${Math.round(layer[field] * 100)}%`;
  }
  if (field === "fontSize") {
    positionOverlay(element, layer);
    byId<HTMLOutputElement>("font-size-value").value =
      `${Math.round(layer.fontSize)} px`;
  }
  if (field === "lineHeight") {
    const output = document.getElementById("line-height-value") as HTMLOutputElement | null;
    if (output) output.value = `${layer.lineHeight.toFixed(2)}×`;
  }
  if (field === "padding") {
    const output = document.getElementById("padding-value") as HTMLOutputElement | null;
    if (output) output.value = `${Math.round(layer.padding)} px`;
  }
  if (field === "rotation") {
    positionOverlay(element, layer);
    byId<HTMLOutputElement>("rotation-value").value =
      `${Math.round(layer.rotation)}°`;
  }
  if (field === "motion") {
    const label = element.querySelector("small");
    if (label) {
      label.textContent =
        layer.motion === "static" ? "" : layer.motion.replaceAll("-", " ");
    }
    element.title = `${layer.name} · ${layer.motion}`;
  }
  if (["x", "y", "width", "height", "fontSize", "rotation", "lineHeight", "padding"].includes(field)) {
    requestAnimationFrame(layoutOverlays);
  }
  if (field === "x" || field === "y") syncPositionPicker(layer);
}

function syncPositionPicker(layer: WatermarkLayer): void {
  const active = activePositionPreset(layer);
  const value = document.getElementById("position-value");
  if (value) value.textContent = active?.label ?? "Custom";
  for (const button of byId("layer-controls").querySelectorAll<HTMLElement>(
    "[data-position-id]",
  )) {
    const selected = button.dataset.positionId === active?.id;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

async function addImageLayer(): Promise<void> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Watermark image", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (typeof selected !== "string") return;
  const imageDataUrl = await invoke<string>("read_image_data_url", {
    path: selected,
  });
  const layer: WatermarkLayer = {
    ...createTextWatermark(layers.length + 1),
    kind: "image",
    name: `Image ${layers.length + 1}`,
    text: "",
    imagePath: selected,
    imageDataUrl,
    size: 0.15,
    width: 0.22,
    height: 0.18,
    lockAspectRatio: true,
  };
  layers.push(layer);
  selectedLayerId = layer.id;
  persistLayers();
  renderEditor();
  render();
}

byId("add-videos").addEventListener("click", () => void chooseVideos());
byId("open-upstream").addEventListener("click", () => {
  void openUrl(UPSTREAM_REPOSITORY).catch((error) => {
    addLog("ERROR", `Could not open upstream repository: ${String(error)}`);
  });
});
byId("open-video-upstream").addEventListener("click", () => {
  void openUrl(VIDEO_ENGINE_REPOSITORY).catch((error) => {
    addLog("ERROR", `Could not open video engine repository: ${String(error)}`);
  });
});
byId("choose-output").addEventListener("click", () => void chooseOutput());
byId("open-editor").addEventListener("click", createWatermarkDesign);
byId("close-editor").addEventListener("click", closeWatermarkEditor);
byId("done-editor").addEventListener("click", closeWatermarkEditor);
byId("save-preset").addEventListener("click", () =>
  void saveWatermarkPreset(),
);
presetTitleInput.addEventListener("input", () => {
  presetTitle = presetTitleInput.value;
});
byId("about-inline").addEventListener("click", () =>
  setModal("about-modal", true),
);
byId("close-about").addEventListener("click", () =>
  setModal("about-modal", false),
);
byId("done-about").addEventListener("click", () =>
  setModal("about-modal", false),
);
byId("open-settings").addEventListener("click", () =>
  setModal("settings-modal", true),
);
byId("close-settings").addEventListener("click", () =>
  setModal("settings-modal", false),
);
byId("done-settings").addEventListener("click", () =>
  setModal("settings-modal", false),
);
byId("app-theme").addEventListener("change", (event) => {
  appTheme = (event.currentTarget as HTMLSelectElement).value as AppTheme;
  localStorage.setItem("appTheme", appTheme);
  void applyTheme();
});
showProcessingLogsOption.addEventListener("change", () => {
  showProcessingLogs = showProcessingLogsOption.checked;
  localStorage.setItem("showProcessingLogs", String(showProcessingLogs));
  if (!showProcessingLogs) removeTab = "videos";
  render();
});
byId("check-updates").addEventListener("click", () => {
  const button = byId<HTMLButtonElement>("check-updates");
  const detail = byId("update-detail");
  const action = byId("update-action");
  const releaseUrl = button.dataset.releaseUrl;
  if (releaseUrl) {
    void openUrl(releaseUrl);
    return;
  }
  button.disabled = true;
  action.textContent = "Checking…";
  detail.textContent = "Contacting GitHub Releases…";
  void (async () => {
    try {
      const response = await fetch(LATEST_RELEASE_API, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const release = (await response.json()) as {
        tag_name?: string;
        html_url?: string;
      };
      if (!release.tag_name || !release.html_url) {
        throw new Error("The latest release information is incomplete.");
      }
      if (isNewerVersion(release.tag_name, byId("app-version").textContent ?? "")) {
        detail.textContent = `${release.tag_name} is available.`;
        action.textContent = "Download";
        button.dataset.releaseUrl = release.html_url;
      } else {
        detail.textContent = `You are using the latest version (${byId("app-version").textContent}).`;
        action.textContent = "Up to date";
      }
    } catch (error) {
      detail.textContent = `Could not check for updates: ${String(error)}`;
      action.textContent = "Try again";
    } finally {
      button.disabled = false;
    }
  })();
});
byId("open-repository").addEventListener("click", () => void openUrl(APP_REPOSITORY));
byId("about-repository").addEventListener("click", () => void openUrl(APP_REPOSITORY));
byId("about-x").addEventListener("click", () => void openUrl(AUTHOR_X_PROFILE));
byId("settings-about").addEventListener("click", () => {
  setModal("settings-modal", false);
  setModal("about-modal", true);
});
byId("author-link").addEventListener("click", () => void openUrl(AUTHOR_X_PROFILE));
byId("sidebar-github").addEventListener("click", () => void openUrl(APP_REPOSITORY));
byId("sidebar-x").addEventListener("click", () => void openUrl(AUTHOR_X_PROFILE));
byId("videos-tab").addEventListener("click", () => {
  removeTab = "videos";
  render();
});
byId("logs-tab").addEventListener("click", () => {
  if (!showProcessingLogs) return;
  removeTab = "logs";
  render();
});
document.querySelector(".tool-nav")?.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-tool]",
  );
  const page = button?.dataset.tool as AppPage | undefined;
  if (page) selectPage(page);
});
byId("library-page").addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const viewButton = target.closest<HTMLElement>("[data-history-view]");
  if (viewButton?.dataset.historyView === "list" || viewButton?.dataset.historyView === "grid") {
    historyViewMode = viewButton.dataset.historyView;
    localStorage.setItem("historyViewMode", historyViewMode);
    renderHistory();
    return;
  }
  const button = target.closest<HTMLElement>("[data-history-filter]");
  const filter = button?.dataset.historyFilter as
    | typeof historyFilter
    | undefined;
  if (!filter) return;
  historyFilter = filter;
  document
    .querySelectorAll("[data-history-filter]")
    .forEach((item) => item.classList.toggle("active", item === button));
  renderHistory();
});
byId("watermark-preset-list").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-preset-id]",
  );
  if (button?.dataset.presetId) loadWatermarkPreset(button.dataset.presetId);
});
byId("add-text-layer").addEventListener("click", () => {
  const layer = createTextWatermark(layers.length + 1);
  layers.push(layer);
  selectedLayerId = layer.id;
  persistLayers();
  renderEditor();
  render();
});
byId("add-image-layer").addEventListener("click", () => void addImageLayer());
startButton.addEventListener("click", () => void startBatch());
cancelButton.addEventListener("click", () => void cancelBatch());
retryButton.addEventListener("click", () => {
  retryJobs(
    new Set(
      jobs
        .filter((job) => ["failed", "cancelled"].includes(job.state))
        .map((job) => job.id),
    ),
  );
});

legacyOption.addEventListener("change", () => {
  useLegacy = legacyOption.checked;
  localStorage.setItem("useLegacy", String(useLegacy));
  render();
});
mlOption.addEventListener("change", () => {
  useML = mlOption.checked;
  localStorage.setItem("useML", String(useML));
  render();
});
upscaleOption.addEventListener("change", () => {
  upscale = Number(upscaleOption.value);
  localStorage.setItem("upscale", String(upscale));
  render();
});
encoderOption.addEventListener("change", () => {
  encoderMode = encoderOption.value;
  localStorage.setItem("encoderMode", encoderMode);
  render();
});

byId("clear-finished").addEventListener("click", () => {
  jobs = jobs.filter(
    (job) => !["succeeded", "failed", "cancelled"].includes(job.state),
  );
  currentStatus = jobs.length
    ? `${jobs.length} videos ready`
    : "Add videos to begin";
  render();
});
byId("clear-all").addEventListener("click", () => {
  jobs = [];
  logs = [];
  currentStatus = "Add videos to begin";
  render();
});
byId("clear-library").addEventListener("click", () => {
  if (historyItems.length === 0) return;
  const confirmed = window.confirm(
    "Clear the video library history? This removes library records only; your video files will not be deleted.",
  );
  if (!confirmed) return;
  void (async () => {
    try {
      await invoke("clear_history");
      historyItems = [];
      videoThumbnails.clear();
      historyFilter = "all";
      currentStatus = "0 recent videos";
      renderHistory();
      render();
    } catch (error) {
      addLog("ERROR", `Library could not be cleared: ${String(error)}`);
    }
  })();
});

queueElement.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (activePage === "watermark") {
    if (target.closest("[data-add-watermark-videos]")) {
      void chooseVideos();
      return;
    }
    const editButton = target.closest<HTMLElement>("[data-edit-video]");
    if (editButton?.dataset.editVideo) {
      const path = decodeURIComponent(editButton.dataset.editVideo);
      setWatermarkVideoSelected(path, true);
      void openWatermarkEditor(path);
    }
    return;
  }
  if (target.closest(".drop-zone")) {
    void chooseVideos();
    return;
  }
  const row = target.closest<HTMLElement>("[data-job-id]");
  if (!row) return;
  const id = row.dataset.jobId;
  if (!id) return;
  if (target.closest(".retry-one")) retryJobs(new Set([id]));
  if (target.closest(".cancel-one")) void cancelBatch();
  if (target.closest(".remove-one") && !running) {
    jobs = jobs.filter((job) => job.id !== id);
    render();
  }
});
queueElement.addEventListener("change", (event) => {
  if (activePage !== "watermark") return;
  const input = (event.target as HTMLElement).closest<HTMLInputElement>(
    "[data-media-select]",
  );
  if (!input?.dataset.mediaSelect) return;
  setWatermarkVideoSelected(
    decodeURIComponent(input.dataset.mediaSelect),
    input.checked,
  );
});

byId("layer-tabs").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-layer-id]");
  if (!button?.dataset.layerId) return;
  selectedLayerId = button.dataset.layerId;
  renderEditor();
});
byId("layer-controls").addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  const field = input.dataset.field;
  const layer = selectedLayer();
  if (field && layer) updateLayerField(layer, field, input);
});
byId("layer-controls").addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const positionButton = target.closest<HTMLElement>("[data-position-id]");
  if (positionButton?.dataset.positionId) {
    const layer = selectedLayer();
    const preset = POSITION_PRESETS.find(
      (candidate) => candidate.id === positionButton.dataset.positionId,
    );
    if (!layer || !preset) return;
    layer.x = preset.x;
    layer.y = preset.y;
    layer.runtimePath = undefined;
    persistLayers();
    const element = byId("preview-canvas").querySelector<HTMLElement>(
      `[data-overlay-id="${layer.id}"]`,
    );
    if (element) positionOverlay(element, layer);
    const xInput = byId("layer-controls").querySelector<HTMLInputElement>(
      '[data-field="x"]',
    );
    const yInput = byId("layer-controls").querySelector<HTMLInputElement>(
      '[data-field="y"]',
    );
    if (xInput) xInput.value = String(Math.round(layer.x * 100));
    if (yInput) yInput.value = String(Math.round(layer.y * 100));
    syncPositionPicker(layer);
    return;
  }
  if (!target.closest("#delete-layer")) return;
  layers = layers.filter((layer) => layer.id !== selectedLayerId);
  selectedLayerId = layers[0]?.id ?? "";
  persistLayers();
  renderEditor();
  render();
});

byId("preview-overlays").addEventListener("pointerdown", (event) => {
  const target = event.target as HTMLElement;
  const element = target.closest<HTMLElement>("[data-overlay-id]");
  if (!element?.dataset.overlayId) return;
  event.preventDefault();
  event.stopPropagation();
  selectedLayerId = element.dataset.overlayId;
  const bounds = element.getBoundingClientRect();
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  const layer = selectedLayer();
  if (!layer) return;
  const resizeHandle = target.closest<HTMLElement>("[data-resize-axis]");
  if (resizeHandle?.dataset.resizeAxis) {
    editorGesture = {
      type: "resize",
      layerId: selectedLayerId,
      axis: resizeHandle.dataset.resizeAxis as ResizeAxis,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startWidth: layer.width,
      startHeight: layer.height,
    };
  } else if (target.closest("[data-rotate-layer]")) {
    editorGesture = {
      type: "rotate",
      layerId: selectedLayerId,
      centerX,
      centerY,
      startPointerAngle:
        Math.atan2(event.clientY - centerY, event.clientX - centerX) *
        (180 / Math.PI),
      startRotation: layer.rotation,
    };
  } else {
    editorGesture = {
      type: "move",
      layerId: selectedLayerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    };
  }
  element.classList.add("transforming");
});
window.addEventListener("pointermove", (event) => {
  if (!editorGesture) return;
  event.preventDefault();
  const layer = layers.find(
    (candidate) => candidate.id === editorGesture?.layerId,
  );
  const canvas = byId<HTMLDivElement>("preview-canvas");
  const element = canvas.querySelector<HTMLElement>(
    `[data-overlay-id="${editorGesture.layerId}"]`,
  );
  if (!layer || !element) return;
  if (editorGesture.type === "resize") {
    const canvasBounds = canvas.getBoundingClientRect();
    const resized = resizedLayerDimensions(
      editorGesture.startWidth,
      editorGesture.startHeight,
      event.clientX - editorGesture.startPointerX,
      event.clientY - editorGesture.startPointerY,
      canvasBounds.width,
      canvasBounds.height,
      editorGesture.axis,
      layer.kind === "image" && layer.lockAspectRatio,
    );
    layer.width = resized.width;
    layer.height = resized.height;
    positionOverlay(element, layer);
    const widthOutput = document.getElementById("width-value") as HTMLOutputElement | null;
    const heightOutput = document.getElementById("height-value") as HTMLOutputElement | null;
    if (widthOutput) widthOutput.value = `${Math.round(layer.width * 100)}%`;
    if (heightOutput) heightOutput.value = `${Math.round(layer.height * 100)}%`;
    const widthInput = byId("layer-controls").querySelector<HTMLInputElement>(
      '[data-field="width"]',
    );
    const heightInput = byId("layer-controls").querySelector<HTMLInputElement>(
      '[data-field="height"]',
    );
    if (widthInput) widthInput.value = String(layer.width);
    if (heightInput) heightInput.value = String(layer.height);
    layoutOverlays();
    return;
  }
  if (editorGesture.type === "rotate") {
    const pointerAngle =
      Math.atan2(
        event.clientY - editorGesture.centerY,
        event.clientX - editorGesture.centerX,
      ) *
      (180 / Math.PI);
    layer.rotation = rotatedLayerAngle(
      editorGesture.startRotation,
      editorGesture.startPointerAngle,
      pointerAngle,
    );
    positionOverlay(element, layer);
    byId<HTMLOutputElement>("rotation-value").value =
      `${Math.round(layer.rotation)}°`;
    const rotationInput = byId("layer-controls").querySelector<HTMLInputElement>(
      '[data-field="rotation"]',
    );
    if (rotationInput) rotationInput.value = String(layer.rotation);
    return;
  }
  const canvasBounds = canvas.getBoundingClientRect();
  const availableX = Math.max(canvasBounds.width - element.offsetWidth, 1);
  const availableY = Math.max(canvasBounds.height - element.offsetHeight, 1);
  layer.x = Math.min(
    Math.max(
      (event.clientX - canvasBounds.left - editorGesture.offsetX) / availableX,
      0,
    ),
    1,
  );
  layer.y = Math.min(
    Math.max(
      (event.clientY - canvasBounds.top - editorGesture.offsetY) / availableY,
      0,
    ),
    1,
  );
  positionOverlay(element, layer);
  const xInput = byId("layer-controls").querySelector<HTMLInputElement>(
    '[data-field="x"]',
  );
  const yInput = byId("layer-controls").querySelector<HTMLInputElement>(
    '[data-field="y"]',
  );
  if (xInput) xInput.value = String(Math.round(layer.x * 100));
  if (yInput) yInput.value = String(Math.round(layer.y * 100));
  syncPositionPicker(layer);
});
window.addEventListener("pointerup", () => {
  if (!editorGesture) return;
  const layerId = editorGesture.layerId;
  editorGesture = undefined;
  persistLayers();
  byId("preview-canvas")
    .querySelector<HTMLElement>(`[data-overlay-id="${layerId}"]`)
    ?.classList.remove("transforming");
});

await listen<CliOutput>("cli-output", ({ payload }) =>
  consumeCliOutput(payload),
);
await getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type === "over") {
    dropActive = true;
  } else if (event.payload.type === "drop") {
    dropActive = false;
    if (activePage === "library") selectPage("remove");
    addVideos(event.payload.paths);
  } else {
    dropActive = false;
  }
  render();
});

try {
  capabilities = await invoke<SystemCapabilities>("system_capabilities");
  if (capabilities.bundledCliPath) {
    cliPath = capabilities.bundledCliPath;
    localStorage.setItem("cliPath", cliPath);
  } else {
    // The Free app has one supported remover: the binary bundled with it.
    // Never silently reuse a stale developer-selected path.
    cliPath = "";
    localStorage.removeItem("cliPath");
  }
  if (capabilities.bundledFfmpegPath) {
    ffmpegPath = capabilities.bundledFfmpegPath;
    localStorage.setItem("ffmpegPath", ffmpegPath);
  } else if (!ffmpegPath && capabilities.ffmpegPath) {
    ffmpegPath = capabilities.ffmpegPath;
    localStorage.setItem("ffmpegPath", ffmpegPath);
  }
  if (capabilities.standardUpscaleAvailable) {
    addLog(
      "INFO",
      `Enhancement ready: ${capabilities.cpuCores} cores, ${capabilities.memoryGb.toFixed(0)} GB RAM, ${capabilities.gpuSummary}`,
    );
  } else {
    addLog("INFO", "Upscaling unavailable because bundled FFmpeg is missing.");
  }
  if (!capabilities.bundledCliPath) {
    addLog(
      "ERROR",
      "Bundled removal engine is unavailable. Reinstall the JV Studio application.",
    );
  }
} catch (error) {
  addLog("ERROR", `System check failed: ${String(error)}`);
}

try {
  historyItems = await invoke<HistoryItem[]>("list_history");
} catch (error) {
  addLog("ERROR", `Library could not be loaded: ${String(error)}`);
}

try {
  watermarkPresets = await invoke<WatermarkPreset[]>(
    "list_watermark_presets",
  );
} catch (error) {
  addLog("ERROR", `Saved watermarks could not be loaded: ${String(error)}`);
}

void applyTheme();
render();
