use serde::{Deserialize, Serialize};
use std::{env, fs, io::{BufRead, BufReader}, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, thread};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Default)] struct ProcessController { child: Arc<Mutex<Option<Child>>>, cancelled: Arc<AtomicBool> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")] struct ProcessRequest { job_id: String, cli_path: String, input_path: String, output_path: String, legacy: bool, ml: bool }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct ProcessResult { exit_code: i32, output_exists: bool, cancelled: bool }
#[derive(Clone, Serialize)] #[serde(rename_all = "camelCase")] struct CliOutput { job_id: String, stream: &'static str, text: String }
#[derive(Serialize)] #[serde(rename_all = "camelCase")] struct SystemCapabilities { bundled_cli_path: Option<String>, gpu_summary: String, cpu_cores: usize, memory_gb: f64 }

fn bundled_cli(app: &AppHandle) -> Option<String> { app.path().resource_dir().ok().and_then(|folder| { let name = if cfg!(target_os = "windows") { "GeminiWatermarkTool-Video.exe" } else { "GeminiWatermarkTool-Video" }; let path = folder.join("bin").join(name); path.is_file().then(|| path.to_string_lossy().into_owned()) }) }
fn memory_gb() -> f64 { #[cfg(target_os = "macos")] { return Command::new("/usr/sbin/sysctl").args(["-n", "hw.memsize"]).output().ok().and_then(|out| String::from_utf8(out.stdout).ok()).and_then(|text| text.trim().parse::<f64>().ok()).map(|bytes| bytes / 1_073_741_824.0).unwrap_or(0.0); } #[cfg(not(target_os = "macos"))] { 0.0 } }
#[tauri::command] fn system_capabilities(app: AppHandle) -> SystemCapabilities { let gpu = if cfg!(target_os = "macos") { "Apple GPU" } else if cfg!(target_os = "windows") { "Windows GPU" } else { "System GPU" }; SystemCapabilities { bundled_cli_path: bundled_cli(&app), gpu_summary: gpu.into(), cpu_cores: thread::available_parallelism().map(|value| value.get()).unwrap_or(1), memory_gb: memory_gb() } }

#[tauri::command]
async fn process_video(app: AppHandle, controller: State<'_, ProcessController>, request: ProcessRequest) -> Result<ProcessResult, String> {
  if !Path::new(&request.cli_path).is_file() { return Err("The removal engine could not be found.".into()); }
  if !Path::new(&request.input_path).is_file() { return Err("The selected input video could not be found.".into()); }
  if let Some(parent) = Path::new(&request.output_path).parent() { fs::create_dir_all(parent).map_err(|error| format!("Cannot create output folder: {error}"))?; }
  let controller = controller.inner().clone(); controller.cancelled.store(false, Ordering::SeqCst);
  tauri::async_runtime::spawn_blocking(move || {
    let mut command = Command::new(&request.cli_path); command.args(["-i", &request.input_path, "-o", &request.output_path]).stdout(Stdio::piped()).stderr(Stdio::piped()); if request.legacy { command.arg("--legacy"); } if request.ml { command.arg("--ml"); }
    let mut child = command.spawn().map_err(|error| format!("Cannot start removal engine: {error}"))?;
    let stdout = child.stdout.take(); let stderr = child.stderr.take(); *controller.child.lock().map_err(|_| "Cannot control removal engine.")? = Some(child);
    if let Some(pipe) = stdout { let app = app.clone(); let job_id = request.job_id.clone(); thread::spawn(move || { for line in BufReader::new(pipe).lines().map_while(Result::ok) { let _ = app.emit("cli-output", CliOutput { job_id: job_id.clone(), stream: "stdout", text: line }); } }); }
    if let Some(pipe) = stderr { let app = app.clone(); let job_id = request.job_id.clone(); thread::spawn(move || { for line in BufReader::new(pipe).lines().map_while(Result::ok) { let _ = app.emit("cli-output", CliOutput { job_id: job_id.clone(), stream: "stderr", text: line }); } }); }
    let status = loop { if controller.cancelled.load(Ordering::SeqCst) { if let Ok(mut lock) = controller.child.lock() { if let Some(child) = lock.as_mut() { let _ = child.kill(); } } } let mut lock = controller.child.lock().map_err(|_| "Cannot control removal engine.")?; if let Some(child) = lock.as_mut() { match child.try_wait().map_err(|error| error.to_string())? { Some(status) => { *lock = None; break status; }, None => {} } } drop(lock); thread::sleep(std::time::Duration::from_millis(100)); };
    Ok(ProcessResult { exit_code: status.code().unwrap_or(-1), output_exists: Path::new(&request.output_path).is_file(), cancelled: controller.cancelled.load(Ordering::SeqCst) })
  }).await.map_err(|error| error.to_string())?
}
#[tauri::command] fn cancel_processing(controller: State<'_, ProcessController>) { controller.cancelled.store(true, Ordering::SeqCst); }
#[tauri::command] fn suggest_output_path(input_path: String, output_folder: String, reserved_paths: Vec<String>) -> Result<String, String> { let input = Path::new(&input_path); let stem = input.file_stem().and_then(|value| value.to_str()).ok_or("Invalid input filename.")?; let extension = input.extension().and_then(|value| value.to_str()).unwrap_or("mp4"); let folder = PathBuf::from(output_folder); for number in 1..10_000 { let suffix = if number == 1 { "_cleaned".into() } else { format!("_cleaned_{number}") }; let path = folder.join(format!("{stem}{suffix}.{extension}")); let value = path.to_string_lossy().into_owned(); if !path.exists() && !reserved_paths.contains(&value) { return Ok(value); } } Err("Could not create a free output filename.".into()) }

pub fn run() { tauri::Builder::default().plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_opener::init()).manage(ProcessController::default()).invoke_handler(tauri::generate_handler![system_capabilities, process_video, cancel_processing, suggest_output_path]).run(tauri::generate_context!()).expect("error while running JV Studio"); }
