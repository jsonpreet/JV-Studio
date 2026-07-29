import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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
let running = false;
const history = JSON.parse(localStorage.getItem("freeHistory") ?? "[]") as Array<{ inputPath: string; outputPath?: string; at: number }>;
const APP_VERSION = `v${appPackage.version}`;

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
      <div class="sidebar-footer"><div id="system" class="system-badge">Checking system…</div><button id="settings" class="tool-nav-item compact"><span class="nav-icon">⚙</span><span>Settings</span></button></div>
    </aside>
    <section class="shell">
      <header class="app-header"><div class="header-copy"><div class="title-row"><h1>JV Studio</h1><button id="about" class="about-link">About</button></div><p>Remove visible video watermarks locally.</p><div class="app-credit"><span>Free edition · By Jsonpreet</span><span>${APP_VERSION}</span></div></div><button id="add-videos" class="button secondary">Add videos</button></header>
      <section id="remove-page">
        <section class="workspace-bar"><div class="workspace-copy"><span class="eyebrow">Watermark removal</span><h2>Remove watermarks</h2><p>Add Omini or Veo clips and process them one at a time. Originals are never changed.</p></div><button id="choose-output" class="output-card"><span class="eyebrow">Output folder</span><strong id="output">Choose a folder</strong><span class="chevron">›</span></button></section>
        <section class="free-engine"><div><strong id="engine-title">Removal engine</strong><span id="engine-detail">Checking bundled engine…</span></div></section>
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
function render(followLogs = false): void {
  byId("output").textContent = outputFolder ? name(outputFolder) : "Choose a folder";
  byId("count").textContent = `${jobs.length} file${jobs.length === 1 ? "" : "s"}`;
  const done = jobs.filter((job) => ["succeeded", "failed", "cancelled"].includes(job.state)).length;
  const overallProgress = jobs.length ? jobs.reduce((total, job) => total + (["succeeded", "failed", "cancelled"].includes(job.state) ? 1 : job.progress), 0) / jobs.length : 0;
  const progressLabel = `${Math.round(overallProgress * 100)}%`;
  byId("summary").textContent = running ? `${done} of ${jobs.length} · ${progressLabel}` : `${done} of ${jobs.length}`;
  byId<HTMLProgressElement>("progress").value = overallProgress;
  byId("status").textContent = running ? `Processing videos · ${progressLabel}` : jobs.length ? `${jobs.length} video${jobs.length === 1 ? "" : "s"} ready` : "Add videos to begin";
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
  const selected = await open({ multiple: true, directory: false, filters: [{ name: "MP4 videos", extensions: ["mp4"] }] });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  jobs.push(...paths.map((inputPath) => ({ id: crypto.randomUUID(), inputPath, state: "pending" as const, detail: "Ready", progress: 0 })));
  log(`Added ${paths.length} video${paths.length === 1 ? "" : "s"}.`);
  render();
}
async function chooseOutput(): Promise<void> { const folder = await open({ directory: true, multiple: false }); if (typeof folder === "string") { outputFolder = folder; localStorage.setItem("freeOutputFolder", folder); render(); } }
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
void invoke<Capability>("system_capabilities").then((value) => { cliPath = value.bundledCliPath ?? ""; byId("system").textContent = `✓ ${value.gpuSummary}`; byId("engine-title").textContent = cliPath ? "Removal engine ready" : "Removal engine unavailable"; byId("engine-detail").textContent = cliPath ? "Bundled video engine is ready." : "The bundled video engine is unavailable in this installation."; render(); });
byId("add-videos").addEventListener("click", () => void addVideos()); byId("choose-output").addEventListener("click", () => void chooseOutput()); byId("start").addEventListener("click", () => void start()); byId("cancel").addEventListener("click", () => { running = false; void invoke("cancel_processing"); }); byId("clear").addEventListener("click", () => { if (!running) { jobs = []; render(); } }); byId("queue-tab").addEventListener("click", () => { removeTab = "queue"; render(); }); byId("logs-tab").addEventListener("click", () => { removeTab = "logs"; render(true); }); queue.addEventListener("click", (event) => { if ((event.target as HTMLElement).closest("#drop-add")) void addVideos(); });
document.querySelector(".tool-nav")?.addEventListener("click", (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button"); if (!button) return; if (button.dataset.pro) showModal(`${button.dataset.pro} is available in Pro`, "This Free edition keeps the tool visible for discovery. Licensing and checkout will be added later.", "<div class=\"credit-card\"><strong>JV Studio Pro</strong><p>Unlock Custom Watermark and local FFmpeg Upscale when Pro launches.</p></div>"); if (button.dataset.page) { page = button.dataset.page as "remove" | "library"; render(); } });
byId("settings").addEventListener("click", () => { showModal("Settings", "Free edition settings", `<div class="settings-group"><div><h3>Processing</h3><p>Choose how much detail appears while a video is running.</p></div><label class="settings-toggle"><span><b>Show processing logs</b><small>Add a Logs tab below Watermark Remove for live engine output.</small></span><input id="show-processing-logs" type="checkbox" ${showProcessingLogs ? "checked" : ""} /></label></div>`); byId<HTMLInputElement>("show-processing-logs").addEventListener("change", (event) => { showProcessingLogs = (event.currentTarget as HTMLInputElement).checked; localStorage.setItem("freeShowProcessingLogs", String(showProcessingLogs)); if (!showProcessingLogs) removeTab = "queue"; render(); }); }); byId("about").addEventListener("click", () => showModal("About JV Studio", `Free, local video watermark removal by Jsonpreet. ${APP_VERSION}`, "<p>Uses GeminiWatermarkTool and GeminiWatermarkTool-Video by Allen Kuo (allenk) under the upstream MIT terms.</p>")); byId("close-modal").addEventListener("click", () => byId("modal").classList.add("hidden")); byId("modal-done").addEventListener("click", () => byId("modal").classList.add("hidden"));
render();
