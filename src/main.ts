import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import appPackage from "../package.json";
import "./styles.css";

type JobState = "pending" | "running" | "succeeded" | "failed" | "cancelled";
type Job = { id: string; inputPath: string; outputPath?: string; state: JobState; detail: string; progress: number };
type Capability = { bundledCliPath?: string; gpuSummary: string; cpuCores: number; memoryGb: number };
type CliOutput = { jobId: string; stream: "stdout" | "stderr"; text: string };

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root");
let jobs: Job[] = [];
let logs: string[] = [];
let cliPath = "";
let outputFolder = localStorage.getItem("freeOutputFolder") ?? "";
let page: "remove" | "library" = "remove";
let removeTab: "queue" | "logs" = "queue";
let showProcessingLogs = localStorage.getItem("freeShowProcessingLogs") === "true";
let appTheme = (localStorage.getItem("freeAppTheme") ?? "system") as "system" | "light" | "dark";
let running = false;
const history = JSON.parse(localStorage.getItem("freeHistory") ?? "[]") as Array<{ inputPath: string; outputPath?: string; at: number }>;
const APP_VERSION = `v${appPackage.version}`;
const APP_REPOSITORY = "https://github.com/jsonpreet/JV-Studio";
const AUTHOR_X_PROFILE = "https://x.com/jsonpreet";
const UPSTREAM_REPOSITORY = "https://github.com/allenk/GeminiWatermarkTool";
const LATEST_RELEASE_API = "https://api.github.com/repos/jsonpreet/JV-Studio/releases/latest";
const GITHUB_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .7A11.3 11.3 0 0 0 8.4 22.8c.6.1.8-.2.8-.6v-2.2c-3.4.7-4.1-1.4-4.1-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6A4.7 4.7 0 0 1 5.8 8.4c-.1-.3-.5-1.6.1-3.3 0 0 1-.3 3.4 1.3a11.8 11.8 0 0 1 6.2 0C17.9 4.8 19 5.1 19 5.1c.6 1.7.2 3 .1 3.3a4.7 4.7 0 0 1 1.3 3.3c0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6A11.3 11.3 0 0 0 12 .7Z"/></svg>`;
const X_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.9 2.3h3.7l-8.1 9.3L24 21.7h-7.4l-5.8-7.6-6.7 7.6H.4l8.7-9.9L0 2.3h7.6l5.2 6.9 6.1-6.9Zm-1.3 17.6h2L6.5 4H4.4l13.2 15.9Z"/></svg>`;

app.innerHTML = `
  <main class="app-layout free-app">
    <aside class="sidebar">
      <div class="sidebar-brand"><img class="brand-mark" src="/app-icon.png" alt="" /><strong>JV<br />Studio</strong></div>
      <nav class="tool-nav" aria-label="Video tools">
        <button class="tool-nav-item active" data-page="remove"><span class="nav-icon">✦</span><span>Watermark<br />Remove</span></button>
        <button class="tool-nav-item" data-pro="Custom Watermark"><span class="nav-icon">T</span><span>Custom<br />Watermark</span></button>
        <button class="tool-nav-item" data-pro="Upscale"><span class="nav-icon">↗</span><span>Upscale</span></button>
        <button class="tool-nav-item" data-page="library"><span class="nav-icon">▦</span><span>Library</span></button>
      </nav>
      <div class="sidebar-footer"><div class="sidebar-social-links" aria-label="Jsonpreet links"><button id="sidebar-github" class="sidebar-social-link" title="JV Studio on GitHub">${GITHUB_ICON}<span>GitHub</span></button><button id="sidebar-x" class="sidebar-social-link" title="Jsonpreet on X">${X_ICON}<span>jsonpreet</span></button></div><div id="system" class="system-badge">Checking system…</div><button id="settings" class="tool-nav-item compact"><span class="nav-icon">⚙</span><span>Settings</span></button></div>
    </aside>
    <section class="shell">
      <header class="app-header"><div class="header-copy"><div class="title-row"><h1>JV Studio</h1><button id="about" class="about-link">About</button></div><p>Remove visible video watermarks locally.</p><div class="app-credit"><span>Free edition</span><button id="author-link" class="author-link" title="x.com/jsonpreet">By Jsonpreet ${X_ICON}</button><span>${APP_VERSION}</span></div></div><button id="add-videos" class="button secondary">Add videos</button></header>
      <section id="remove-page">
        <section class="workspace-bar"><div class="workspace-copy"><span class="eyebrow">Watermark removal</span><h2>Remove watermarks</h2><p>Add Omini or Veo clips and process them one at a time. Originals are never changed.</p></div><button id="choose-output" class="output-card"><span class="eyebrow">Output folder</span><strong id="output">Choose a folder</strong><span class="chevron">›</span></button></section>
        <section class="queue-section"><div class="section-heading"><div><h2 id="queue-title">Queue</h2><span id="count">0 files</span></div><div class="queue-actions"><button id="queue-tab" class="text-button tab-button active">Videos</button><button id="logs-tab" class="text-button tab-button hidden">Logs <span id="log-count">0</span></button><button id="clear" class="text-button">Clear all</button></div></div><div id="queue" class="queue"></div><div id="logs-panel" class="activity-log hidden"></div></section>
        <footer class="footer"><div class="overall"><div><strong id="status">Add videos to begin</strong><span id="summary">0 of 0</span></div><progress id="progress" max="1" value="0"></progress></div><button id="cancel" class="button danger hidden">Cancel</button><button id="start" class="button primary">Start</button></footer>
      </section>
      <section id="library-page" class="library-page hidden"><header class="library-header"><div><span class="eyebrow">Local history</span><h2>Your video library</h2><p>Recent Free edition imports and completed outputs on this computer.</p></div></header><div id="history" class="history-list"></div></section>
    </section>
  </main>
  <div id="modal" class="modal hidden" role="dialog" aria-modal="true"><section class="info-dialog"><header class="info-header"><div><span id="modal-kicker" class="eyebrow">JV Studio</span><h2 id="modal-title"></h2><p id="modal-copy"></p></div><button id="close-modal" class="icon-button">×</button></header><div id="modal-body" class="info-content"></div><footer class="info-footer"><button id="modal-done" class="button primary">Done</button></footer></section></div>`;

const byId = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: #${id}`);
  return element as T;
};
const queue = byId<HTMLDivElement>("queue");
const activity = byId<HTMLDivElement>("logs-panel");
const stripTerminalControl = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n").trim();
const log = (line: string) => { logs = [...logs.slice(-199), line]; render(true); };
const name = (path: string) => path.split(/[\\/]/).pop() || path;
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
const videoSource = (path: string) => {
  try {
    return `${convertFileSrc(path)}#t=0.1`;
  } catch (error) {
    console.warn("Could not create local video preview URL", error);
    return "";
  }
};

function attachVideoPreviews(): void {
  const previews = queue.querySelectorAll<HTMLElement>(".video-card-preview");
  previews.forEach((preview, index) => {
    const job = jobs[index];
    if (!job) return;
    const source = videoSource(job.inputPath);
    if (!source) return;
    const video = document.createElement("video");
    video.className = "video-thumbnail";
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = source;
    preview.prepend(video);
  });
}

function showModal(title: string, copy: string, body = ""): void {
  byId("modal-title").textContent = title;
  byId("modal-copy").textContent = copy;
  byId("modal-body").innerHTML = body;
  byId("modal").classList.remove("hidden");
}

const versionParts = (version: string) => version.replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = versionParts(latest);
  const currentParts = versionParts(current);
  const length = Math.max(latestParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    if ((latestParts[index] ?? 0) !== (currentParts[index] ?? 0)) return (latestParts[index] ?? 0) > (currentParts[index] ?? 0);
  }
  return false;
}

function showAbout(): void {
  showModal(
    "About JV Studio",
    `Free, local video watermark removal by Jsonpreet. ${APP_VERSION}`,
    `<p>JV Studio processes supported video clips locally and preserves the original files.</p>
      <div class="creator-links">
        <button id="about-repository" class="creator-link">${GITHUB_ICON}<span><strong>jsonpreet/JV-Studio</strong><small>GitHub repository</small></span><b>Open</b></button>
        <button id="about-x" class="creator-link">${X_ICON}<span><strong>x.com/jsonpreet</strong><small>Follow Jsonpreet on X</small></span><b>Open</b></button>
      </div>
      <div class="credit-card"><span class="eyebrow">Open source attribution</span><strong>GeminiWatermarkTool</strong><p>Uses GeminiWatermarkTool and GeminiWatermarkTool-Video by Allen Kuo (allenk) under the upstream MIT terms.</p><button id="about-upstream" class="button secondary">Upstream repository</button></div>`,
  );
  byId("about-repository").addEventListener("click", () => void openUrl(APP_REPOSITORY));
  byId("about-x").addEventListener("click", () => void openUrl(AUTHOR_X_PROFILE));
  byId("about-upstream").addEventListener("click", () => void openUrl(UPSTREAM_REPOSITORY));
}

function showSettings(): void {
  showModal(
    "Settings",
    "Free edition settings",
    `<div class="settings-group"><div><h3>Processing</h3><p>Choose how much detail appears while a video is running.</p></div><label class="settings-toggle"><span><b>Show processing logs</b><small>Add a Logs tab below Watermark Remove for live engine output.</small></span><input id="show-processing-logs" type="checkbox" ${showProcessingLogs ? "checked" : ""} /></label></div>
      <div class="settings-group"><div><h3>Appearance</h3><p>Use the system appearance or choose a consistent app theme.</p></div><label class="settings-toggle"><span><b>Theme</b><small>Applied immediately across the complete interface.</small></span><select id="app-theme"><option value="system" ${appTheme === "system" ? "selected" : ""}>System</option><option value="light" ${appTheme === "light" ? "selected" : ""}>Light</option><option value="dark" ${appTheme === "dark" ? "selected" : ""}>Dark</option></select></label></div>
      <div class="settings-group"><div><h3>Application</h3><p>Version information, updates, and project details.</p></div>
        <div class="settings-row static"><span><b>Current version</b><small>The installed JV Studio Free release.</small></span><span>${APP_VERSION}</span></div>
        <button id="check-updates" class="settings-row"><span><b>Check for updates</b><small id="update-detail">Check the official GitHub Releases channel.</small></span><span id="update-action">Check now</span></button>
        <button id="open-repository" class="settings-row"><span><b>GitHub repository</b><small>Source code, releases, issues, and documentation.</small></span><span>Open</span></button>
        <button id="settings-about" class="settings-row"><span><b>About JV Studio</b><small>Author, attribution, and open-source information.</small></span><span>View</span></button>
      </div>`,
  );

  byId<HTMLInputElement>("show-processing-logs").addEventListener("change", (event) => {
    showProcessingLogs = (event.currentTarget as HTMLInputElement).checked;
    localStorage.setItem("freeShowProcessingLogs", String(showProcessingLogs));
    if (!showProcessingLogs) removeTab = "queue";
    render();
  });
  byId<HTMLSelectElement>("app-theme").addEventListener("change", (event) => {
    appTheme = (event.currentTarget as HTMLSelectElement).value as typeof appTheme;
    localStorage.setItem("freeAppTheme", appTheme);
    void applyTheme();
  });
  byId("open-repository").addEventListener("click", () => void openUrl(APP_REPOSITORY));
  byId("settings-about").addEventListener("click", showAbout);
  byId<HTMLButtonElement>("check-updates").addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const detail = byId("update-detail");
    const action = byId("update-action");
    const releaseUrl = button.dataset.releaseUrl;
    if (releaseUrl) {
      await openUrl(releaseUrl);
      return;
    }
    button.disabled = true;
    action.textContent = "Checking…";
    detail.textContent = "Contacting GitHub Releases…";
    try {
      const response = await fetch(LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json" } });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const release = await response.json() as { tag_name?: string; html_url?: string };
      if (!release.tag_name || !release.html_url) throw new Error("The latest release information is incomplete.");
      if (isNewerVersion(release.tag_name, APP_VERSION)) {
        detail.textContent = `${release.tag_name} is available.`;
        action.textContent = "Download";
        button.dataset.releaseUrl = release.html_url;
      } else {
        detail.textContent = `You are using the latest version (${APP_VERSION}).`;
        action.textContent = "Up to date";
      }
    } catch (error) {
      detail.textContent = `Could not check for updates: ${String(error)}`;
      action.textContent = "Try again";
    } finally {
      button.disabled = false;
    }
  });
}

async function applyTheme(): Promise<void> {
  try {
    await getCurrentWindow().setTheme(appTheme === "system" ? null : appTheme);
  } catch (error) {
    console.warn("Could not apply the selected app theme", error);
  }
}
function render(followLogs = false): void {
  byId("output").textContent = outputFolder ? name(outputFolder) : "Choose a folder";
  byId("count").textContent = `${jobs.length} file${jobs.length === 1 ? "" : "s"}`;
  const done = jobs.filter((job) => ["succeeded", "failed", "cancelled"].includes(job.state)).length;
  const overallProgress = jobs.length ? jobs.reduce((total, job) => total + (["succeeded", "failed", "cancelled"].includes(job.state) ? 1 : job.progress), 0) / jobs.length : 0;
  const progressLabel = `${Math.round(overallProgress * 100)}%`;
  byId("summary").textContent = running ? `${done} of ${jobs.length} · ${progressLabel}` : `${done} of ${jobs.length}`;
  byId<HTMLProgressElement>("progress").value = overallProgress;
  const pending = jobs.filter((job) => job.state === "pending").length;
  const succeeded = jobs.filter((job) => job.state === "succeeded").length;
  byId("status").textContent = running
    ? `Processing videos · ${progressLabel}`
    : pending
      ? `${pending} video${pending === 1 ? "" : "s"} ready`
      : succeeded
        ? `${succeeded} video${succeeded === 1 ? "" : "s"} completed`
        : jobs.length
          ? "Processing finished"
          : "Add videos to begin";
  byId("log-count").textContent = String(logs.length);
  byId("logs-tab").classList.toggle("hidden", !showProcessingLogs);
  if (!showProcessingLogs && removeTab === "logs") removeTab = "queue";
  byId("queue-tab").classList.toggle("active", removeTab === "queue");
  byId("logs-tab").classList.toggle("active", removeTab === "logs");
  queue.classList.toggle("hidden", removeTab !== "queue");
  activity.classList.toggle("hidden", removeTab !== "logs");
  queue.innerHTML = jobs.length ? jobs.map((job) => {
    const progress = Math.round(job.progress * 100);
    const isRunning = job.state === "running";
    const stateLabel = isRunning ? "Removing watermark" : job.state === "succeeded" ? "Completed" : job.state === "failed" ? "Failed" : job.state === "cancelled" ? "Cancelled" : "Ready";
    return `<article class="video-card ${job.state}">
      <div class="video-card-preview">
        <span class="video-fallback">▶</span>
        ${isRunning ? `<div class="video-processing-overlay"><div class="circular-progress" style="--progress: ${progress * 3.6}deg"><span>${progress}%</span></div><strong>Removing</strong></div>` : `<span class="video-state-badge ${job.state}">${stateLabel}</span>`}
      </div>
      <div class="video-card-copy"><strong title="${escapeHtml(name(job.inputPath))}">${escapeHtml(name(job.inputPath))}</strong><span>${escapeHtml(job.detail || stateLabel)}</span></div>
    </article>`;
  }).join("") : `<button id="drop-add" class="drop-zone"><strong>Drop multiple MP4 clips here</strong><span>or choose Add videos</span></button>`;
  if (jobs.length) window.requestAnimationFrame(attachVideoPreviews);
  activity.innerHTML = logs.map((line) => `<div class="log-line"><code>${escapeHtml(line)}</code></div>`).join("") || `<div class="empty-log">Processing updates will appear here.</div>`;
  if (followLogs) activity.scrollTop = activity.scrollHeight;
  byId("start").toggleAttribute("disabled", running || !jobs.some((job) => job.state === "pending") || !cliPath || !outputFolder);
  byId("cancel").classList.toggle("hidden", !running);
  byId("remove-page").classList.toggle("hidden", page !== "remove");
  byId("library-page").classList.toggle("hidden", page !== "library");
  document.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  byId("history").innerHTML = history.length ? history.map((item) => `<article class="history-card"><div class="history-main"><strong>${name(item.inputPath)}</strong><span>${item.outputPath ? `Output: ${name(item.outputPath)}` : "Imported"}</span></div></article>`).join("") : `<p class="empty-history">No videos processed yet.</p>`;
}
async function addVideos(): Promise<void> {
  try {
    const selected = await open({ multiple: true, directory: false, filters: [{ name: "MP4 videos", extensions: ["mp4"] }] });
    if (!selected) return;
    addVideoPaths(Array.isArray(selected) ? selected : [selected]);
  } catch (error) {
    const message = `Could not open the video picker: ${String(error)}`;
    log(message);
    showModal("Could not add videos", message);
  }
}

function addVideoPaths(paths: string[]): void {
  const existing = new Set(jobs.map((job) => job.inputPath));
  const accepted = paths.filter((path) => /\.mp4$/i.test(path) && !existing.has(path));
  if (!accepted.length) {
    showModal("No new MP4 videos found", "Drop MP4 video files that are not already in the queue.");
    return;
  }
  jobs.push(...accepted.map((inputPath) => ({ id: crypto.randomUUID(), inputPath, state: "pending" as const, detail: "Ready", progress: 0 })));
  removeTab = "queue";
  log(`Added ${accepted.length} video${accepted.length === 1 ? "" : "s"}.`);
}

async function chooseOutput(): Promise<void> {
  try {
    const folder = await open({ directory: true, multiple: false });
    if (typeof folder === "string") {
      outputFolder = folder;
      localStorage.setItem("freeOutputFolder", folder);
      render();
    }
  } catch (error) {
    showModal("Could not choose an output folder", String(error));
  }
}

async function setupFileDrop(): Promise<void> {
  const setDropActive = (active: boolean) => queue.classList.toggle("drop-active", active);
  window.addEventListener("dragenter", (event) => {
    event.preventDefault();
    setDropActive(true);
  });
  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  });
  window.addEventListener("dragleave", (event) => {
    event.preventDefault();
    if (event.relatedTarget === null) setDropActive(false);
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    setDropActive(false);
  });

  try {
    await getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") {
        setDropActive(true);
      } else {
        setDropActive(false);
      }
      if (payload.type === "drop") addVideoPaths(payload.paths);
    });
  } catch (error) {
    console.warn("Native file drop is unavailable", error);
  }
}
async function start(): Promise<void> {
  if (!cliPath || !outputFolder) return;
  running = true; render();
  for (const job of jobs.filter((item) => item.state === "pending")) {
    job.state = "running"; job.progress = 0; job.detail = "Removing watermark… 0%"; render();
    try {
      const outputPath = await invoke<string>("suggest_output_path", { inputPath: job.inputPath, outputFolder, reservedPaths: jobs.map((item) => item.outputPath).filter(Boolean) });
      const result = await invoke<{ exitCode: number; outputExists: boolean; cancelled: boolean }>("process_video", { request: { jobId: job.id, cliPath, inputPath: job.inputPath, outputPath, legacy: false, ml: false } });
      job.outputPath = outputPath;
      if (result.cancelled) {
        job.state = "pending";
        job.progress = 0;
        job.detail = "Ready to retry";
        log(`Cancelled ${name(job.inputPath)}. It is ready to retry.`);
      } else {
        job.state = result.exitCode === 0 && result.outputExists ? "succeeded" : "failed";
        job.progress = 1;
        job.detail = job.state === "succeeded" ? "Completed" : "Could not process this video";
      }
      if (job.state === "succeeded") history.unshift({ inputPath: job.inputPath, outputPath, at: Date.now() });
    } catch (error) { job.state = "failed"; job.detail = String(error); log(`Error: ${String(error)}`); }
    localStorage.setItem("freeHistory", JSON.stringify(history.slice(0, 100))); render();
    if (!running) break;
  }
  running = false; render();
}
void listen<CliOutput>("cli-output", ({ payload }) => {
  const text = stripTerminalControl(payload.text);
  const matches = [...text.matchAll(/\]\s*(\d{1,3})%\s+\(\d+\/\d+\)/g)];
  const progress = matches.at(-1)?.[1];
  if (progress) {
    const job = jobs.find((item) => item.id === payload.jobId);
    if (job) { job.progress = Math.max(job.progress, Math.min(100, Number(progress)) / 100); job.detail = `Removing watermark… ${progress}%`; }
  }
  if (text) log(`${payload.stream === "stderr" ? "• " : ""}${text}`);
});
void invoke<Capability>("system_capabilities").then((value) => {
  cliPath = value.bundledCliPath ?? "";
  byId("system").textContent = `✓ ${value.gpuSummary}`;
  if (!cliPath) log("The bundled video processor is unavailable in this installation.");
  render();
});
void setupFileDrop();
void applyTheme();
byId("add-videos").addEventListener("click", () => void addVideos()); byId("choose-output").addEventListener("click", () => void chooseOutput()); byId("start").addEventListener("click", () => void start()); byId("cancel").addEventListener("click", () => { running = false; void invoke("cancel_processing"); }); byId("clear").addEventListener("click", () => { if (!running) { jobs = []; render(); } }); byId("queue-tab").addEventListener("click", () => { removeTab = "queue"; render(); }); byId("logs-tab").addEventListener("click", () => { removeTab = "logs"; render(true); }); queue.addEventListener("click", (event) => { if ((event.target as HTMLElement).closest("#drop-add")) void addVideos(); });
document.querySelector(".tool-nav")?.addEventListener("click", (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button"); if (!button) return; if (button.dataset.pro) showModal(`${button.dataset.pro} is available in Pro`, "This Free edition keeps the tool visible for discovery. Licensing and checkout will be added later.", "<div class=\"credit-card\"><strong>JV Studio Pro</strong><p>Unlock Custom Watermark and local FFmpeg Upscale when Pro launches.</p></div>"); if (button.dataset.page) { page = button.dataset.page as "remove" | "library"; render(); } });
byId("settings").addEventListener("click", showSettings); byId("about").addEventListener("click", showAbout); byId("author-link").addEventListener("click", () => void openUrl(AUTHOR_X_PROFILE)); byId("sidebar-github").addEventListener("click", () => void openUrl(APP_REPOSITORY)); byId("sidebar-x").addEventListener("click", () => void openUrl(AUTHOR_X_PROFILE)); byId("close-modal").addEventListener("click", () => byId("modal").classList.add("hidden")); byId("modal-done").addEventListener("click", () => byId("modal").classList.add("hidden"));
render();
