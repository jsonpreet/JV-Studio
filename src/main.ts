import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./styles.css";

type JobState = "pending" | "running" | "succeeded" | "failed" | "cancelled";
type Job = { id: string; inputPath: string; outputPath?: string; state: JobState; detail: string };
type Capability = { bundledCliPath?: string; gpuSummary: string; cpuCores: number; memoryGb: number };
type CliOutput = { jobId: string; stream: "stdout" | "stderr"; text: string };

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root");
let jobs: Job[] = [];
let logs: string[] = [];
let cliPath = localStorage.getItem("freeCliPath") ?? "";
let outputFolder = localStorage.getItem("freeOutputFolder") ?? "";
let page: "remove" | "library" = "remove";
let running = false;
const history = JSON.parse(localStorage.getItem("freeHistory") ?? "[]") as Array<{ inputPath: string; outputPath?: string; at: number }>;

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
      <header class="app-header"><div class="header-copy"><div class="title-row"><h1>JV Studio</h1><button id="about" class="about-link">About</button></div><p>Remove visible video watermarks locally.</p><div class="app-credit"><span>Free edition · By Jsonpreet</span><span>v0.3.0</span></div></div><button id="add-videos" class="button secondary">Add videos</button></header>
      <section id="remove-page">
        <section class="workspace-bar"><div class="workspace-copy"><span class="eyebrow">Watermark removal</span><h2>Remove watermarks</h2><p>Add Omini or Veo clips and process them one at a time. Originals are never changed.</p></div><button id="choose-output" class="output-card"><span class="eyebrow">Output folder</span><strong id="output">Choose a folder</strong><span class="chevron">›</span></button></section>
        <section class="free-engine"><div><strong id="engine-title">Removal engine</strong><span id="engine-detail">Checking bundled engine…</span></div><button id="choose-engine" class="text-button">Change…</button></section>
        <section class="queue-section"><div class="section-heading"><div><h2>Queue</h2><span id="count">0 files</span></div><button id="clear" class="text-button">Clear all</button></div><div id="queue" class="queue"></div></section>
        <section class="activity-section"><div class="section-heading"><div><h2>Activity</h2><span id="log-count">0 messages</span></div></div><div id="activity" class="activity-log"></div></section>
        <footer class="footer"><div class="overall"><div><strong id="status">Add videos to begin</strong><span id="summary">0 of 0</span></div><progress id="progress" max="1" value="0"></progress></div><button id="cancel" class="button danger hidden">Cancel</button><button id="start" class="button primary">Start</button></footer>
      </section>
      <section id="library-page" class="library-page hidden"><header class="library-header"><div><span class="eyebrow">Local history</span><h2>Your video library</h2><p>Recent Free edition imports and completed outputs on this computer.</p></div></header><div id="history" class="history-list"></div></section>
    </section>
  </main>
  <div id="modal" class="modal hidden" role="dialog" aria-modal="true"><section class="info-dialog"><header class="info-header"><div><span id="modal-kicker" class="eyebrow">JV Studio</span><h2 id="modal-title"></h2><p id="modal-copy"></p></div><button id="close-modal" class="icon-button">×</button></header><div id="modal-body" class="info-content"></div><footer class="info-footer"><button id="modal-done" class="button primary">Done</button></footer></section></div>`;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const queue = byId<HTMLDivElement>("queue");
const log = (line: string) => { logs = [...logs.slice(-49), line]; render(); };
const name = (path: string) => path.split(/[\\/]/).pop() || path;

function showModal(title: string, copy: string, body = ""): void {
  byId("modal-title").textContent = title;
  byId("modal-copy").textContent = copy;
  byId("modal-body").innerHTML = body;
  byId("modal").classList.remove("hidden");
}
function render(): void {
  byId("output").textContent = outputFolder ? name(outputFolder) : "Choose a folder";
  byId("count").textContent = `${jobs.length} file${jobs.length === 1 ? "" : "s"}`;
  const done = jobs.filter((job) => ["succeeded", "failed", "cancelled"].includes(job.state)).length;
  byId("summary").textContent = `${done} of ${jobs.length}`;
  byId<HTMLProgressElement>("progress").value = jobs.length ? done / jobs.length : 0;
  byId("status").textContent = running ? "Processing videos…" : jobs.length ? `${jobs.length} video${jobs.length === 1 ? "" : "s"} ready` : "Add videos to begin";
  byId("log-count").textContent = `${logs.length} message${logs.length === 1 ? "" : "s"}`;
  queue.innerHTML = jobs.length ? jobs.map((job) => `<article class="queue-row"><div><strong>${name(job.inputPath)}</strong><span>${job.detail || job.state}</span></div><span class="job-state ${job.state}">${job.state}</span></article>`).join("") : `<button id="drop-add" class="drop-zone"><strong>Drop multiple MP4 clips here</strong><span>or choose Add videos</span></button>`;
  byId("activity").innerHTML = logs.map((line) => `<div class="log-line"><code>${line}</code></div>`).join("") || `<div class="empty-log">Processing updates will appear here.</div>`;
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
  jobs.push(...paths.map((inputPath) => ({ id: crypto.randomUUID(), inputPath, state: "pending" as const, detail: "Ready" })));
  log(`Added ${paths.length} video${paths.length === 1 ? "" : "s"}.`);
  render();
}
async function chooseOutput(): Promise<void> { const folder = await open({ directory: true, multiple: false }); if (typeof folder === "string") { outputFolder = folder; localStorage.setItem("freeOutputFolder", folder); render(); } }
async function chooseEngine(): Promise<void> { const file = await open({ directory: false, multiple: false }); if (typeof file === "string") { cliPath = file; localStorage.setItem("freeCliPath", file); render(); } }
async function start(): Promise<void> {
  if (!cliPath || !outputFolder) return;
  running = true; render();
  for (const job of jobs.filter((item) => item.state === "pending")) {
    job.state = "running"; job.detail = "Removing watermark…"; render();
    try {
      const outputPath = await invoke<string>("suggest_output_path", { inputPath: job.inputPath, outputFolder, reservedPaths: jobs.map((item) => item.outputPath).filter(Boolean) });
      const result = await invoke<{ exitCode: number; outputExists: boolean; cancelled: boolean }>("process_video", { request: { jobId: job.id, cliPath, inputPath: job.inputPath, outputPath, legacy: false, ml: false } });
      job.outputPath = outputPath;
      job.state = result.cancelled ? "cancelled" : result.exitCode === 0 && result.outputExists ? "succeeded" : "failed";
      job.detail = job.state === "succeeded" ? "Completed" : "Could not process this video";
      if (job.state === "succeeded") history.unshift({ inputPath: job.inputPath, outputPath, at: Date.now() });
    } catch (error) { job.state = "failed"; job.detail = String(error); log(`Error: ${String(error)}`); }
    localStorage.setItem("freeHistory", JSON.stringify(history.slice(0, 100))); render();
    if (!running) break;
  }
  running = false; render();
}
void listen<CliOutput>("cli-output", ({ payload }) => log(`${payload.stream === "stderr" ? "•" : ""} ${payload.text.trim()}`));
void invoke<Capability>("system_capabilities").then((value) => { if (!cliPath && value.bundledCliPath) cliPath = value.bundledCliPath; byId("system").textContent = `✓ ${value.gpuSummary}`; byId("engine-title").textContent = cliPath ? "Removal engine ready" : "Removal engine required"; byId("engine-detail").textContent = cliPath ? "Bundled video engine is ready." : "Choose GeminiWatermarkTool-Video to continue."; render(); });
byId("add-videos").addEventListener("click", () => void addVideos()); byId("choose-output").addEventListener("click", () => void chooseOutput()); byId("choose-engine").addEventListener("click", () => void chooseEngine()); byId("start").addEventListener("click", () => void start()); byId("cancel").addEventListener("click", () => { running = false; void invoke("cancel_processing"); }); byId("clear").addEventListener("click", () => { if (!running) { jobs = []; render(); } }); queue.addEventListener("click", (event) => { if ((event.target as HTMLElement).closest("#drop-add")) void addVideos(); });
document.querySelector(".tool-nav")?.addEventListener("click", (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button"); if (!button) return; if (button.dataset.pro) showModal(`${button.dataset.pro} is available in Pro`, "This Free edition keeps the tool visible for discovery. Licensing and checkout will be added later.", "<div class=\"credit-card\"><strong>JV Studio Pro</strong><p>Unlock Custom Watermark and local FFmpeg Upscale when Pro launches.</p></div>"); if (button.dataset.page) { page = button.dataset.page as "remove" | "library"; render(); } });
byId("settings").addEventListener("click", () => showModal("Settings", "Free edition settings", `<div class="credit-card"><strong>Removal engine</strong><p>${cliPath ? name(cliPath) : "Not selected"}</p><button id="modal-engine" class="button secondary">Choose engine</button></div>`)); byId("about").addEventListener("click", () => showModal("About JV Studio", "Free, local video watermark removal by Jsonpreet.", "<p>Uses GeminiWatermarkTool and GeminiWatermarkTool-Video by Allen Kuo (allenk) under the upstream MIT terms.</p>")); byId("close-modal").addEventListener("click", () => byId("modal").classList.add("hidden")); byId("modal-done").addEventListener("click", () => byId("modal").classList.add("hidden")); byId("modal-body").addEventListener("click", (event) => { if ((event.target as HTMLElement).closest("#modal-engine")) void chooseEngine(); });
render();
