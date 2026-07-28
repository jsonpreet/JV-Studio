import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const tauriConfig = JSON.parse(
  await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"),
);
const cargoToml = await readFile(
  new URL("src-tauri/Cargo.toml", root),
  "utf8",
);
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

const versions = {
  "package.json": packageJson.version,
  "src-tauri/tauri.conf.json": tauriConfig.version,
  "src-tauri/Cargo.toml": cargoVersion,
};
const expected = packageJson.version;
const mismatches = Object.entries(versions).filter(
  ([, version]) => version !== expected,
);

if (mismatches.length > 0) {
  console.error("App versions do not match:");
  for (const [file, version] of Object.entries(versions)) {
    console.error(`  ${file}: ${version ?? "missing"}`);
  }
  process.exit(1);
}

console.log(`Version ${expected} is synchronized across app metadata.`);
