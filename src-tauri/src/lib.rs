use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    env, fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Default)]
struct ProcessController {
    child: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessRequest {
    job_id: String,
    cli_path: String,
    input_path: String,
    output_path: String,
    legacy: bool,
    ml: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PostProcessRequest {
    job_id: String,
    ffmpeg_path: String,
    input_path: String,
    output_path: String,
    duration: f64,
    source_width: u32,
    source_height: u32,
    upscale: u8,
    encoder: String,
    layers: Vec<OverlayLayer>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayLayer {
    image_path: String,
    width_fraction: f64,
    height_fraction: f64,
    lock_aspect_ratio: bool,
    opacity: f64,
    rotation: f64,
    x: f64,
    y: f64,
    start_seconds: f64,
    end_seconds: f64,
    motion: String,
    z_index: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliOutput {
    job_id: String,
    stream: &'static str,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessResult {
    exit_code: i32,
    output_exists: bool,
    cancelled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemCapabilities {
    os: String,
    arch: String,
    cpu_cores: usize,
    memory_gb: f64,
    gpu_summary: String,
    metal_supported: bool,
    ffmpeg_path: Option<String>,
    ffprobe_path: Option<String>,
    bundled_ffmpeg_path: Option<String>,
    bundled_ffprobe_path: Option<String>,
    ffmpeg_version: Option<String>,
    bundled_cli_path: Option<String>,
    standard_upscale_available: bool,
    ai_upscale_available: bool,
    hardware_encoder: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoInfo {
    width: u32,
    height: u32,
    duration: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryItem {
    id: String,
    input_path: String,
    output_path: Option<String>,
    operation: String,
    status: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatermarkPreset {
    id: String,
    title: String,
    layers_json: String,
    created_at: i64,
    updated_at: i64,
}

fn history_connection(app: &AppHandle) -> Result<Connection, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve app data folder: {error}"))?;
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("Cannot create app data folder: {error}"))?;
    let connection = Connection::open(data_dir.join("video-library.sqlite3"))
        .map_err(|error| format!("Cannot open video library: {error}"))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS video_history (
                id TEXT PRIMARY KEY,
                input_path TEXT NOT NULL,
                output_path TEXT,
                operation TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS video_history_updated
                ON video_history(updated_at DESC);
            CREATE TABLE IF NOT EXISTS watermark_presets (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                layers_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS watermark_presets_updated
                ON watermark_presets(updated_at DESC);",
        )
        .map_err(|error| format!("Cannot prepare video library: {error}"))?;
    Ok(connection)
}

#[tauri::command]
fn upsert_history(app: AppHandle, item: HistoryItem) -> Result<(), String> {
    let connection = history_connection(&app)?;
    connection
        .execute(
            "INSERT INTO video_history
                (id, input_path, output_path, operation, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                input_path = excluded.input_path,
                output_path = excluded.output_path,
                operation = excluded.operation,
                status = excluded.status,
                updated_at = excluded.updated_at",
            params![
                item.id,
                item.input_path,
                item.output_path,
                item.operation,
                item.status,
                item.created_at,
                item.updated_at
            ],
        )
        .map_err(|error| format!("Cannot update video library: {error}"))?;
    Ok(())
}

#[tauri::command]
fn list_history(app: AppHandle) -> Result<Vec<HistoryItem>, String> {
    let connection = history_connection(&app)?;
    let mut statement = connection
        .prepare(
            "SELECT id, input_path, output_path, operation, status, created_at, updated_at
             FROM video_history
             ORDER BY updated_at DESC
             LIMIT 250",
        )
        .map_err(|error| format!("Cannot read video library: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(HistoryItem {
                id: row.get(0)?,
                input_path: row.get(1)?,
                output_path: row.get(2)?,
                operation: row.get(3)?,
                status: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("Cannot query video library: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot load video library rows: {error}"))
}

#[tauri::command]
fn clear_history(app: AppHandle) -> Result<(), String> {
    let connection = history_connection(&app)?;
    connection
        .execute("DELETE FROM video_history", [])
        .map_err(|error| format!("Cannot clear video library: {error}"))?;
    Ok(())
}

#[tauri::command]
fn upsert_watermark_preset(app: AppHandle, preset: WatermarkPreset) -> Result<(), String> {
    let connection = history_connection(&app)?;
    connection
        .execute(
            "INSERT INTO watermark_presets
                (id, title, layers_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                layers_json = excluded.layers_json,
                updated_at = excluded.updated_at",
            params![
                preset.id,
                preset.title,
                preset.layers_json,
                preset.created_at,
                preset.updated_at
            ],
        )
        .map_err(|error| format!("Cannot save watermark preset: {error}"))?;
    Ok(())
}

#[tauri::command]
fn list_watermark_presets(app: AppHandle) -> Result<Vec<WatermarkPreset>, String> {
    let connection = history_connection(&app)?;
    let mut statement = connection
        .prepare(
            "SELECT id, title, layers_json, created_at, updated_at
             FROM watermark_presets
             ORDER BY updated_at DESC
             LIMIT 100",
        )
        .map_err(|error| format!("Cannot read watermark presets: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(WatermarkPreset {
                id: row.get(0)?,
                title: row.get(1)?,
                layers_json: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|error| format!("Cannot query watermark presets: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot load watermark presets: {error}"))
}

fn forward_output<R>(
    mut reader: R,
    app: AppHandle,
    job_id: String,
    stream: &'static str,
) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let text = String::from_utf8_lossy(&buffer[..count]).into_owned();
                    let _ = app.emit(
                        "cli-output",
                        CliOutput {
                            job_id: job_id.clone(),
                            stream,
                            text,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    })
}

fn emit_progress(app: &AppHandle, job_id: &str, percent: f64) {
    let _ = app.emit(
        "cli-output",
        CliOutput {
            job_id: job_id.to_string(),
            stream: "stdout",
            text: format!("\rPost-processing {:.1}%", percent.clamp(0.0, 100.0)),
        },
    );
}

fn wait_for_child(
    controller: &ProcessController,
    missing_message: &str,
) -> Result<std::process::ExitStatus, String> {
    let mut current = controller
        .child
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?;
    let mut child = current
        .take()
        .ok_or_else(|| missing_message.to_string())?;
    child
        .wait()
        .map_err(|error| format!("Could not read process exit status: {error}"))
}

fn ensure_idle(controller: &ProcessController) -> Result<(), String> {
    let running = controller
        .child
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?;
    if running.is_some() {
        return Err("Another video is already processing.".into());
    }
    Ok(())
}

fn validate_paths(executable: &Path, input: &Path, output: &Path) -> Result<(), String> {
    if !executable.is_file() {
        return Err("The selected processing executable does not exist.".into());
    }
    if !input.is_file() {
        return Err("The input video no longer exists.".into());
    }
    if input == output {
        return Err("Refusing to overwrite the original video.".into());
    }
    if output.exists() {
        return Err("The chosen output already exists; choose a new output name.".into());
    }
    let parent = output
        .parent()
        .ok_or_else(|| "The output path has no parent folder.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("Cannot create output folder: {error}"))
}

fn find_program(name: &str) -> Option<PathBuf> {
    if let Some(paths) = env::var_os("PATH") {
        for folder in env::split_paths(&paths) {
            let direct = folder.join(name);
            if direct.is_file() {
                return Some(direct);
            }
            #[cfg(target_os = "windows")]
            {
                let executable = folder.join(format!("{name}.exe"));
                if executable.is_file() {
                    return Some(executable);
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    let candidates = [
        format!("/opt/homebrew/bin/{name}"),
        format!("/usr/local/bin/{name}"),
    ];
    #[cfg(target_os = "windows")]
    let candidates = [
        format!(r"C:\ffmpeg\bin\{name}.exe"),
        format!(r"C:\Program Files\ffmpeg\bin\{name}.exe"),
    ];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let candidates = [format!("/usr/bin/{name}"), format!("/usr/local/bin/{name}")];

    candidates
        .into_iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
}

fn bundled_program(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let filename = if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("bin").join(&filename));
    }
    // Tauri's dev process does not have a packaged Resources directory. Look
    // beside the repository's source checkout so `npm run tauri:dev` behaves
    // exactly like the release bundle once local tools are restored.
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("bin")
            .join(&filename),
    );
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn command_text(program: &str, arguments: &[&str]) -> String {
    Command::new(program)
        .args(arguments)
        .output()
        .ok()
        .map(|output| {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            text
        })
        .unwrap_or_default()
}

fn memory_gb() -> f64 {
    #[cfg(target_os = "macos")]
    {
        return command_text("/usr/sbin/sysctl", &["-n", "hw.memsize"])
            .trim()
            .parse::<f64>()
            .map(|bytes| bytes / 1_073_741_824.0)
            .unwrap_or(0.0);
    }
    #[cfg(target_os = "windows")]
    {
        return command_text(
            "powershell.exe",
            &[
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ],
        )
        .trim()
        .parse::<f64>()
        .map(|bytes| bytes / 1_073_741_824.0)
        .unwrap_or(0.0);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        0.0
    }
}

fn gpu_details() -> (String, bool) {
    #[cfg(target_os = "macos")]
    {
        let output = command_text(
            "/usr/sbin/system_profiler",
            &["SPDisplaysDataType", "-detailLevel", "mini"],
        );
        let gpu = output
            .lines()
            .find_map(|line| line.trim().strip_prefix("Chipset Model:"))
            .map(str::trim)
            .unwrap_or("Apple GPU")
            .to_string();
        return (gpu, output.contains("Metal: Supported"));
    }
    #[cfg(target_os = "windows")]
    {
        let output = command_text(
            "powershell.exe",
            &[
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ', '",
            ],
        );
        return (output.trim().to_string(), false);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        ("Unknown GPU".into(), false)
    }
}

#[tauri::command]
fn system_capabilities(app: AppHandle) -> SystemCapabilities {
    let bundled_ffmpeg = bundled_program(&app, "ffmpeg");
    let bundled_ffprobe = bundled_program(&app, "ffprobe");
    let ffmpeg = bundled_ffmpeg.clone().or_else(|| find_program("ffmpeg"));
    let ffprobe = bundled_ffprobe.clone().or_else(|| find_program("ffprobe")).or_else(|| {
        ffmpeg.as_ref().and_then(|path| {
            let sibling = path.with_file_name(if cfg!(target_os = "windows") {
                "ffprobe.exe"
            } else {
                "ffprobe"
            });
            sibling.is_file().then_some(sibling)
        })
    });
    let ffmpeg_output = ffmpeg
        .as_ref()
        .map(|path| command_text(&path.to_string_lossy(), &["-version"]))
        .unwrap_or_default();
    let encoders = ffmpeg
        .as_ref()
        .map(|path| command_text(&path.to_string_lossy(), &["-hide_banner", "-encoders"]))
        .unwrap_or_default();
    let version = ffmpeg_output.lines().next().map(ToString::to_string);
    let hardware_encoder = if encoders.contains("h264_videotoolbox") {
        Some("h264_videotoolbox".into())
    } else if encoders.contains("h264_nvenc") {
        Some("h264_nvenc".into())
    } else {
        None
    };
    let (gpu_summary, metal_supported) = gpu_details();
    let memory_gb = memory_gb();
    let bundled_cli_path = bundled_program(&app, "GeminiWatermarkTool-Video")
        .map(|path| path.to_string_lossy().into_owned());

    SystemCapabilities {
        os: env::consts::OS.into(),
        arch: env::consts::ARCH.into(),
        cpu_cores: thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(1),
        memory_gb,
        gpu_summary,
        metal_supported,
        ffmpeg_path: ffmpeg.map(|path| path.to_string_lossy().into_owned()),
        ffprobe_path: ffprobe.map(|path| path.to_string_lossy().into_owned()),
        bundled_ffmpeg_path: bundled_ffmpeg.map(|path| path.to_string_lossy().into_owned()),
        bundled_ffprobe_path: bundled_ffprobe.map(|path| path.to_string_lossy().into_owned()),
        ffmpeg_version: version,
        bundled_cli_path,
        standard_upscale_available: !ffmpeg_output.is_empty() && memory_gb >= 4.0,
        ai_upscale_available: false,
        hardware_encoder,
    }
}

#[tauri::command]
async fn process_video(
    app: AppHandle,
    controller: State<'_, ProcessController>,
    request: ProcessRequest,
) -> Result<ProcessResult, String> {
    validate_paths(
        Path::new(&request.cli_path),
        Path::new(&request.input_path),
        Path::new(&request.output_path),
    )?;

    let controller = controller.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_idle(&controller)?;
        controller.cancelled.store(false, Ordering::SeqCst);

        let mut command = Command::new(&request.cli_path);
        if request.legacy {
            command.arg("--legacy");
        }
        if request.ml {
            command.arg("--ml");
        }
        command
            .args(["-i", &request.input_path, "-o", &request.output_path])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start the video engine: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Could not read video engine output.".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Could not read video engine errors.".to_string())?;
        *controller
            .child
            .lock()
            .map_err(|_| "Process state is unavailable.".to_string())? = Some(child);

        let stdout_thread =
            forward_output(stdout, app.clone(), request.job_id.clone(), "stdout");
        let stderr_thread = forward_output(stderr, app, request.job_id.clone(), "stderr");
        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        let status = wait_for_child(&controller, "The video engine ended unexpectedly.")?;
        let cancelled = controller.cancelled.load(Ordering::SeqCst);

        Ok(ProcessResult {
            exit_code: status.code().unwrap_or(-1),
            output_exists: Path::new(&request.output_path).is_file(),
            cancelled,
        })
    })
    .await
    .map_err(|error| format!("Processing task failed: {error}"))?
}

fn overlay_position(layer: &OverlayLayer) -> (String, String) {
    let x = layer.x.clamp(0.0, 1.0);
    let y = layer.y.clamp(0.0, 1.0);
    let start = layer.start_seconds.max(0.0);
    let end = layer.end_seconds.max(start + 0.1);
    let duration = end - start;

    match layer.motion.as_str() {
        "right-to-left" => (
            format!("main_w-(main_w+overlay_w)*(t-{start})/{duration}"),
            format!("(main_h-overlay_h)*{y}"),
        ),
        "left-to-right" => (
            format!("-overlay_w+(main_w+overlay_w)*(t-{start})/{duration}"),
            format!("(main_h-overlay_h)*{y}"),
        ),
        "top-to-bottom" => (
            format!("(main_w-overlay_w)*{x}"),
            format!("-overlay_h+(main_h+overlay_h)*(t-{start})/{duration}"),
        ),
        "bottom-to-top" => (
            format!("(main_w-overlay_w)*{x}"),
            format!("main_h-(main_h+overlay_h)*(t-{start})/{duration}"),
        ),
        "diagonal" => (
            format!("-overlay_w+(main_w+overlay_w)*(t-{start})/{duration}"),
            format!("-overlay_h+(main_h+overlay_h)*(t-{start})/{duration}"),
        ),
        "bounce" => (
            format!(
                "abs(mod((t-{start})*140\\,2*(main_w-overlay_w))-(main_w-overlay_w))"
            ),
            format!("(main_h-overlay_h)*{y}"),
        ),
        _ => (
            format!("(main_w-overlay_w)*{x}"),
            format!("(main_h-overlay_h)*{y}"),
        ),
    }
}

fn build_filter(request: &PostProcessRequest) -> Result<String, String> {
    if !matches!(request.upscale, 1 | 2 | 4) {
        return Err("Upscale must be 1×, 2×, or 4×.".into());
    }

    let mut filters = Vec::new();
    if request.upscale == 1 {
        filters.push("[0:v]null[base0]".to_string());
    } else {
        filters.push(format!(
            "[0:v]scale=iw*{}:ih*{}:flags=lanczos[base0]",
            request.upscale, request.upscale
        ));
    }

    let mut layers = request.layers.clone();
    layers.sort_by_key(|layer| layer.z_index);
    let mut base = "base0".to_string();

    for (index, layer) in layers.iter().enumerate() {
        let input_index = index + 1;
        let target_width = (request.source_width as f64
            * request.upscale as f64
            * layer.width_fraction.clamp(0.04, 1.0))
        .round()
        .max(2.0) as u32;
        let target_width = target_width - (target_width % 2);
        let target_height = (request.source_height as f64
            * request.upscale as f64
            * layer.height_fraction.clamp(0.03, 1.0))
        .round()
        .max(2.0) as u32;
        let target_height = target_height - (target_height % 2);
        let scale_expression = if layer.lock_aspect_ratio {
            format!("scale={target_width}:{target_height}:force_original_aspect_ratio=decrease")
        } else {
            format!("scale={target_width}:{target_height}")
        };
        let rotation = layer.rotation.clamp(-360.0, 360.0);
        let opacity = layer.opacity.clamp(0.0, 1.0);
        filters.push(format!(
            "[{input_index}:v]format=rgba,{scale_expression},\
             colorchannelmixer=aa={opacity:.4},\
             rotate={rotation:.4}*PI/180:ow=rotw(iw):oh=roth(ih):c=none[wm{index}]"
        ));
        let (x, y) = overlay_position(layer);
        let next = format!("base{}", index + 1);
        filters.push(format!(
            "[{base}][wm{index}]overlay=x='{x}':y='{y}':\
             enable='between(t,{:.4},{:.4})':eof_action=repeat[{next}]",
            layer.start_seconds.max(0.0),
            layer.end_seconds.max(layer.start_seconds + 0.1)
        ));
        base = next;
    }

    filters.push(format!("[{base}]format=yuv420p[vout]"));
    Ok(filters.join(";"))
}

#[tauri::command]
async fn post_process_video(
    app: AppHandle,
    controller: State<'_, ProcessController>,
    request: PostProcessRequest,
) -> Result<ProcessResult, String> {
    validate_paths(
        Path::new(&request.ffmpeg_path),
        Path::new(&request.input_path),
        Path::new(&request.output_path),
    )?;
    if request.duration <= 0.0 {
        return Err("Video duration is unavailable.".into());
    }
    for layer in &request.layers {
        if !Path::new(&layer.image_path).is_file() {
            return Err(format!("Watermark image is missing: {}", layer.image_path));
        }
    }
    let filter = build_filter(&request)?;
    let controller = controller.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        ensure_idle(&controller)?;
        controller.cancelled.store(false, Ordering::SeqCst);

        let mut command = Command::new(&request.ffmpeg_path);
        command.args(["-hide_banner", "-y", "-i", &request.input_path]);
        let mut layers = request.layers.clone();
        layers.sort_by_key(|layer| layer.z_index);
        for layer in &layers {
            command.args(["-loop", "1", "-i", &layer.image_path]);
        }
        command
            .args(["-filter_complex", &filter, "-map", "[vout]", "-map", "0:a?"])
            .args(["-map_metadata", "0", "-c:a", "copy"]);

        match request.encoder.as_str() {
            "h264_videotoolbox" => {
                command.args(["-c:v", "h264_videotoolbox", "-q:v", "65"]);
            }
            "h264_nvenc" => {
                command.args(["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "18"]);
            }
            _ => {
                // Keep the bundled pipeline LGPL-compatible. FFmpeg's native
                // MPEG-4 encoder is available without the GPL x264 library.
                command.args(["-c:v", "mpeg4", "-q:v", "3"]);
            }
        }
        command
            .args(["-t", &format!("{:.6}", request.duration)])
            .args(["-progress", "pipe:1", "-nostats", &request.output_path])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start FFmpeg: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Could not read FFmpeg progress.".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Could not read FFmpeg errors.".to_string())?;
        *controller
            .child
            .lock()
            .map_err(|_| "Process state is unavailable.".to_string())? = Some(child);

        let progress_app = app.clone();
        let progress_job = request.job_id.clone();
        let duration = request.duration;
        let stdout_thread = thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(value) = line
                    .strip_prefix("out_time_us=")
                    .or_else(|| line.strip_prefix("out_time_ms="))
                    .and_then(|value| value.parse::<f64>().ok())
                {
                    emit_progress(&progress_app, &progress_job, value / (duration * 10_000.0));
                }
            }
        });
        let stderr_thread =
            forward_output(stderr, app.clone(), request.job_id.clone(), "stderr");
        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        let status = wait_for_child(&controller, "FFmpeg ended unexpectedly.")?;
        let cancelled = controller.cancelled.load(Ordering::SeqCst);
        if status.success() {
            emit_progress(&app, &request.job_id, 100.0);
        }

        Ok(ProcessResult {
            exit_code: status.code().unwrap_or(-1),
            output_exists: Path::new(&request.output_path).is_file(),
            cancelled,
        })
    })
    .await
    .map_err(|error| format!("Post-processing task failed: {error}"))?
}

#[tauri::command]
fn cancel_current(controller: State<'_, ProcessController>) -> Result<(), String> {
    controller.cancelled.store(true, Ordering::SeqCst);
    let mut current = controller
        .child
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?;
    if let Some(child) = current.as_mut() {
        child
            .kill()
            .map_err(|error| format!("Could not cancel processing: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn suggest_output_path(
    input_path: String,
    output_dir: String,
    reserved: Vec<String>,
) -> Result<String, String> {
    let input = PathBuf::from(input_path);
    let folder = PathBuf::from(output_dir);
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Input video has an invalid filename.".to_string())?;
    let extension = input
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("mp4");
    let occupied: HashSet<PathBuf> = reserved.into_iter().map(PathBuf::from).collect();

    for number in 1..100_000 {
        let suffix = if number == 1 {
            String::new()
        } else {
            format!("_{number}")
        };
        let candidate = folder.join(format!("{stem}_cleaned{suffix}.{extension}"));
        if !candidate.exists() && !occupied.contains(&candidate) {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err("Could not find an available output filename.".into())
}

fn ffprobe_for(ffmpeg_path: &str) -> Option<PathBuf> {
    let ffmpeg = PathBuf::from(ffmpeg_path);
    let sibling = ffmpeg.with_file_name(if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    });
    sibling.is_file().then_some(sibling).or_else(|| find_program("ffprobe"))
}

#[tauri::command]
fn probe_video(ffmpeg_path: String, input_path: String) -> Result<VideoInfo, String> {
    let ffprobe = ffprobe_for(&ffmpeg_path)
        .ok_or_else(|| "FFprobe was not found next to FFmpeg.".to_string())?;
    let dimensions = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
            &input_path,
        ])
        .output()
        .map_err(|error| format!("Could not run FFprobe: {error}"))?;
    let dimension_text = String::from_utf8_lossy(&dimensions.stdout);
    let (width, height) = dimension_text
        .trim()
        .split_once('x')
        .ok_or_else(|| "Could not read video dimensions.".to_string())?;
    let duration_output = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &input_path,
        ])
        .output()
        .map_err(|error| format!("Could not read video duration: {error}"))?;
    Ok(VideoInfo {
        width: width
            .parse()
            .map_err(|_| "Invalid video width.".to_string())?,
        height: height
            .parse()
            .map_err(|_| "Invalid video height.".to_string())?,
        duration: String::from_utf8_lossy(&duration_output.stdout)
            .trim()
            .parse()
            .map_err(|_| "Invalid video duration.".to_string())?,
    })
}

#[tauri::command]
async fn extract_preview(
    ffmpeg_path: String,
    input_path: String,
    at_seconds: f64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !Path::new(&ffmpeg_path).is_file() || !Path::new(&input_path).is_file() {
            return Err("FFmpeg or the input video is missing.".into());
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let preview = env::temp_dir().join(format!("gvt-preview-{stamp}.jpg"));
        let status = Command::new(&ffmpeg_path)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                &format!("{:.3}", at_seconds.max(0.0)),
                "-i",
                &input_path,
                "-frames:v",
                "1",
                "-q:v",
                "2",
                "-y",
                &preview.to_string_lossy(),
            ])
            .status()
            .map_err(|error| format!("Could not start FFmpeg preview: {error}"))?;
        if !status.success() {
            return Err("FFmpeg could not extract the preview frame.".into());
        }
        let bytes = fs::read(&preview).map_err(|error| format!("Cannot read preview: {error}"))?;
        let _ = fs::remove_file(preview);
        Ok(format!("data:image/jpeg;base64,{}", BASE64.encode(bytes)))
    })
    .await
    .map_err(|error| format!("Preview task failed: {error}"))?
}

fn thumbnail_cache_key(path: &Path) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Cannot inspect video for thumbnail: {error}"))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let mut hasher = DefaultHasher::new();
    "jv-studio-thumbnail-v1".hash(&mut hasher);
    path.to_string_lossy().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

#[tauri::command]
async fn video_thumbnail(
    app: AppHandle,
    ffmpeg_path: String,
    input_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let input = PathBuf::from(&input_path);
        if !input.is_file() {
            return Err("The input video is missing.".into());
        }
        let cache_folder = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("Cannot locate thumbnail cache: {error}"))?
            .join("thumbnails");
        fs::create_dir_all(&cache_folder)
            .map_err(|error| format!("Cannot create thumbnail cache: {error}"))?;
        let thumbnail = cache_folder.join(format!("{}.jpg", thumbnail_cache_key(&input)?));

        if !thumbnail.is_file() {
            if !Path::new(&ffmpeg_path).is_file() {
                return Err("FFmpeg is missing.".into());
            }
            let status = Command::new(&ffmpeg_path)
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    "0.500",
                    "-i",
                    &input_path,
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=480:-2:force_original_aspect_ratio=decrease",
                    "-q:v",
                    "4",
                    "-y",
                    &thumbnail.to_string_lossy(),
                ])
                .status()
                .map_err(|error| format!("Could not start FFmpeg thumbnail extraction: {error}"))?;
            if !status.success() || !thumbnail.is_file() {
                let _ = fs::remove_file(&thumbnail);
                return Err("FFmpeg could not extract a video thumbnail.".into());
            }
        }

        let bytes =
            fs::read(&thumbnail).map_err(|error| format!("Cannot read thumbnail: {error}"))?;
        Ok(format!("data:image/jpeg;base64,{}", BASE64.encode(bytes)))
    })
    .await
    .map_err(|error| format!("Thumbnail task failed: {error}"))?
}

#[tauri::command]
fn read_image_data_url(path: String) -> Result<String, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("The watermark image does not exist.".into());
    }
    let bytes = fs::read(&source).map_err(|error| format!("Cannot read image: {error}"))?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Watermark images must be smaller than 25 MB.".into());
    }
    let mime = match source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

#[tauri::command]
fn save_overlay_data(data_url: String, layer_id: String) -> Result<String, String> {
    let payload = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| "Text watermark must be a PNG data URL.".to_string())?;
    let bytes = BASE64
        .decode(payload)
        .map_err(|error| format!("Invalid watermark image: {error}"))?;
    let safe_id: String = layer_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect();
    if safe_id.is_empty() {
        return Err("Invalid watermark layer ID.".into());
    }
    let folder = env::temp_dir().join("jv-studio-overlays");
    fs::create_dir_all(&folder).map_err(|error| format!("Cannot create overlay folder: {error}"))?;
    let path = folder.join(format!("{safe_id}.png"));
    fs::write(&path, bytes).map_err(|error| format!("Cannot save text watermark: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn remove_intermediate(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !name.contains(".gvt-intermediate-")
        && !target
            .to_string_lossy()
            .contains("jv-studio-overlays")
    {
        return Err("Refusing to delete a non-temporary file.".into());
    }
    if target.exists() {
        fs::remove_file(target).map_err(|error| format!("Cannot remove temporary file: {error}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProcessController::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            system_capabilities,
            process_video,
            post_process_video,
            cancel_current,
            suggest_output_path,
            probe_video,
            extract_preview,
            video_thumbnail,
            read_image_data_url,
            save_overlay_data,
            remove_intermediate,
            upsert_history,
            list_history,
            clear_history,
            upsert_watermark_preset,
            list_watermark_presets
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        build_filter, find_program, overlay_position, suggest_output_path, OverlayLayer,
        PostProcessRequest, thumbnail_cache_key,
    };
    use std::{env, fs, process::Command};

    fn layer(motion: &str) -> OverlayLayer {
        OverlayLayer {
            image_path: "/tmp/watermark.png".into(),
            width_fraction: 0.2,
            height_fraction: 0.15,
            lock_aspect_ratio: false,
            opacity: 0.5,
            rotation: 15.0,
            x: 0.25,
            y: 0.75,
            start_seconds: 1.0,
            end_seconds: 9.0,
            motion: motion.into(),
            z_index: 1,
        }
    }

    #[test]
    fn output_name_preserves_the_original_path() {
        let result =
            suggest_output_path("/input/clip.mp4".into(), "/output".into(), vec![]).unwrap();
        assert_eq!(result, "/output/clip_cleaned.mp4");
        assert_ne!(result, "/input/clip.mp4");
    }

    #[test]
    fn output_name_avoids_reserved_paths() {
        let result = suggest_output_path(
            "/input/clip.mp4".into(),
            "/output".into(),
            vec![
                "/output/clip_cleaned.mp4".into(),
                "/output/clip_cleaned_2.mp4".into(),
            ],
        )
        .unwrap();
        assert_eq!(result, "/output/clip_cleaned_3.mp4");
    }

    #[test]
    fn thumbnail_cache_key_tracks_video_content_metadata() {
        let path = env::temp_dir().join("jv-studio-thumbnail-key-test.mp4");
        fs::write(&path, b"first").unwrap();
        let first = thumbnail_cache_key(&path).unwrap();
        assert_eq!(first, thumbnail_cache_key(&path).unwrap());
        fs::write(&path, b"second-content").unwrap();
        let second = thumbnail_cache_key(&path).unwrap();
        let _ = fs::remove_file(path);
        assert_ne!(first, second);
    }

    #[test]
    fn scrolling_position_uses_video_time() {
        let (x, y) = overlay_position(&layer("right-to-left"));
        assert!(x.contains("(t-1)"));
        assert!(y.contains("main_h-overlay_h"));
    }

    #[test]
    fn filter_contains_upscale_opacity_rotation_and_timing() {
        let request = PostProcessRequest {
            job_id: "job".into(),
            ffmpeg_path: "/ffmpeg".into(),
            input_path: "/input.mp4".into(),
            output_path: "/output.mp4".into(),
            duration: 10.0,
            source_width: 1920,
            source_height: 1080,
            upscale: 2,
            encoder: "libx264".into(),
            layers: vec![layer("static")],
        };
        let filter = build_filter(&request).unwrap();
        assert!(filter.contains("scale=iw*2:ih*2"));
        assert!(filter.contains("scale=768:324"));
        assert!(filter.contains("colorchannelmixer=aa=0.5000"));
        assert!(filter.contains("rotate=15.0000"));
        assert!(filter.contains("between(t,1.0000,9.0000)"));
    }

    #[test]
    fn generated_filter_is_accepted_by_ffmpeg_when_available() {
        let Some(ffmpeg) = find_program("ffmpeg") else {
            return;
        };
        let mut overlay = layer("right-to-left");
        overlay.start_seconds = 0.0;
        overlay.end_seconds = 1.0;
        let request = PostProcessRequest {
            job_id: "job".into(),
            ffmpeg_path: ffmpeg.to_string_lossy().into_owned(),
            input_path: "/input.mp4".into(),
            output_path: "/output.mp4".into(),
            duration: 1.0,
            source_width: 320,
            source_height: 180,
            upscale: 1,
            encoder: "libx264".into(),
            layers: vec![overlay],
        };
        let output = env::temp_dir().join("gvt-filter-smoke.mp4");
        let status = Command::new(ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=2",
                "-f",
                "lavfi",
                "-i",
                "color=white:size=64x32:rate=2",
                "-filter_complex",
                &build_filter(&request).unwrap(),
                "-map",
                "[vout]",
                "-t",
                "1",
                "-c:v",
                "libx264",
                &output.to_string_lossy(),
            ])
            .status()
            .expect("run ffmpeg");
        let _ = fs::remove_file(output);
        assert!(status.success());
    }
}
