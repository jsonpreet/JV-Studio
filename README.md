# JV Studio

<img src="app-icon.png" width="128" alt="JV Studio app icon">

A small cross-platform desktop application with a bundled
`GeminiWatermarkTool-Video` engine, published by `allenk/VeoWatermarkRemover`.
Users do not need to download or locate a separate CLI.

**JV Studio is a Gemini Watermark Removal Tool for Videos**: a local desktop
app for batch-processing supported Omini and Veo video clips, with reusable
custom text/image watermarking. JV Studio is independent and is not affiliated
with Google.

**Author:** [Jsonpreet](https://x.com/jsonpreet)

**Repository:** [jsonpreet/JV-Studio](https://github.com/jsonpreet/JV-Studio)

**Version:** 0.4.3

## Editions

This repository publishes the **Free** edition of JV Studio. Watermark Remove,
Custom Watermark, Library, and Settings are available locally at no cost. The
upscale implementation remains in the codebase but is currently hidden from
the sidebar while it is being finalized.

## Upstream attribution

JV Studio uses and integrates code and watermark-removal technology
from [GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool),
created by **Allen Kuo (`allenk`)**. The original reverse alpha-blending method
and its calibrated mask work belong to the upstream author.

GeminiWatermarkTool is provided under the MIT License. The original copyright
notice and complete license text are preserved in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The Tauri interface, batch
queue, enhancement pipeline, and custom-watermark editor in this repository are
maintained by Jsonpreet.

JV Studio is an independent project. It is not affiliated with or
endorsed by Google.

## Why this upstream engine

`allenk/GeminiWatermarkTool` currently focuses on still images. Its own README
directs video users to the separately released `GeminiWatermarkTool-Video`
binary in `allenk/VeoWatermarkRemover`.

The app keeps the platform-specific binaries separate:

- macOS selects `GeminiWatermarkTool-Video`;
- Windows selects `GeminiWatermarkTool-Video.exe`;
- either binary can be updated whenever upstream ships a newer release;
- the UI never modifies an input path;
- every run uses explicit `-i input -o output` arguments;
- name collisions become `_cleaned_2`, `_cleaned_3`, and so on.

## Features

- drag/drop or select multiple MP4 files (the format documented by upstream);
- choose and remember an output folder; the removal engine is bundled in release
  builds and does not require a separate CLI download;
- serial queue (one CLI child process at a time);
- per-file and overall progress parsed from the CLI's percentage output;
- live success, failure, and CLI logs;
- cancel the current batch and retry individual failures or all failures;
- optional `--legacy` and `--ml` switches;
- automatic CPU, memory, GPU, Metal, FFmpeg, and hardware-encoder checks;
- streamlined sidebar for Watermark Remove, Custom Watermark, and Library;
- local recent-video history for imported and completed clips;
- reusable text and image watermark layers with preview, movement, rotation,
  timing, opacity, font, and position controls;
- advanced Settings with processing switches, encoder choice, appearance,
  update checks, repository information, and About details;
- original clips are never overwritten.

## Processing order

For every queued video the app runs:

```text
optional existing-watermark removal
  → optional custom text/image watermark layers
  → optional FFmpeg enhancement
  → video in your chosen output folder
```

The Free edition does not modify the original clip.

## Bundled removal engine

Release builds download the pinned, checksum-verified v0.6.4 upstream engine
and copy it into the application:

- macOS: `bin/GeminiWatermarkTool-Video`
- Windows: `bin/GeminiWatermarkTool-Video.exe`

JV Studio always prefers this built-in engine. An incomplete source checkout
reports the missing bundle in Activity rather than asking users to locate a
separate repository. Release packages include the upstream attribution and MIT
notice.

## Bundled FFmpeg

Release builds also include pinned FFmpeg and FFprobe 8.1.2 LGPL-only builds.
They power custom text/image watermark rendering, video previews, and local
video enhancement without requiring Homebrew, winget, or a separate FFmpeg
download. The release workflow records the upstream license and source build
metadata alongside the binaries.

## Architecture

The shared TypeScript/Vite interface owns the queue and display state. Three
small Rust commands start the chosen executable, stream its output back to the
UI, cancel it, and generate collision-safe output paths.

```text
Tauri TypeScript UI (same on macOS and Windows)
    │ queue + drag/drop + native file dialogs
    ▼
Rust process controller
    │ one child process at a time
    ▼
GeminiWatermarkTool-Video -i INPUT -o OUTPUT
    │ stdout/stderr events + exit status
    ▼
per-file progress, overall progress, logs, retry
```

The Rust layer rejects input/output path equality and existing output files.
Names are generated as `_cleaned`, `_cleaned_2`, and so on, so originals and
previous results are preserved.

## Prerequisites

- Node.js LTS and npm
- Rust stable (via rustup)
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools with **Desktop development with C++**
  and WebView2 (already present on current Windows 10/11)

## Run from source

```bash
cd JV-Studio
npm install
npm run tauri:dev
```

When the app opens:

1. Choose an output folder.
2. Add or drop clips and click Start.

The selected paths are remembered on this Mac.

## Build installers

The 1024×1024 icon master is stored in `app-icon.png`. After replacing the
master, regenerate the complete macOS and Windows icon set with:

```bash
npm run tauri -- icon app-icon.png
```

This updates the `.icns`, `.ico`, PNG, Windows Store tiles, and mobile icon
variants under `src-tauri/icons`.

Build macOS on a Mac:

```bash
cd JV-Studio
npm run tauri:build
```

Build Windows on a Windows machine using the same source:

```powershell
cd JV-Studio
npm install
npm run tauri:build
```

Tauri produces a macOS `.app` and an `.msi`/NSIS setup executable on Windows.
Native installer generation is most reliable on the target operating system.

## GitHub Releases

The included `.github/workflows/release.yml` workflow builds:

- macOS Apple Silicon `.app` ZIP bundle;
- Windows x64 NSIS installer.

macOS users install from the ZIP: unzip it, drag `JV Studio.app` to the
Applications folder, then open it. The app inside the archive is Developer ID
signed and notarized; the ZIP format avoids unreliable temporary-space limits
on hosted macOS build runners.

To publish version `0.4.3`, push the project to GitHub and create its matching
version tag:

```bash
git tag v0.4.3
git push origin v0.4.3
```

GitHub Actions verifies that `package.json`, `Cargo.toml`, and
`tauri.conf.json` contain the same version before publishing the release.
Run the same check locally with:

```bash
npm run check:version
```

When preparing a later release, update the version in all three files and push
the matching `v<version>` tag. Manual runs are also available from the Actions
tab. The default workflow uses ad-hoc signing for macOS; production distribution
should add Apple notarization and Windows code-signing secrets.

## Development and upstream note

Source checkouts do not fetch large third-party binaries automatically. The
release workflow downloads the pinned, checksum-verified upstream removal
engine and FFmpeg builds, includes their attribution, and packages them inside
the application. For local development, place compatible binaries in `bin/` or
install FFmpeg/FFprobe on the host system.

Stopping terminates the current child process on either platform and leaves
remaining items pending. A partial output produced by a cancelled/failed run
is not treated as success and will not be overwritten by a retry.

## Tests

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

The TypeScript tests cover progress parsing and queue calculations. Rust tests
cover collision-safe output naming.

## Upstream licensing

This project acknowledges and preserves the authorship of
[GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool) by
**Allen Kuo (`allenk`)**. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
for the upstream copyright and full MIT License.

If a GeminiWatermarkTool or VeoWatermarkRemover executable is bundled with a
release, keep the notice in the source archive and the packaged application.
