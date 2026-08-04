import { constants, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const vaultRoot = process.env.KNOWFLOW_VAULT || "/Users/phoenine/Documents/Obsidian";
const obsidianDir = path.join(vaultRoot, ".obsidian");
const pluginsDir = path.join(obsidianDir, "plugins");
const communityPluginsPath = path.join(obsidianDir, "community-plugins.json");

const manifestPath = path.join(repoRoot, "manifest.json");
const mainPath = path.join(repoRoot, "main.js");
const pluginId = await readPluginId(manifestPath);
const targetDir = path.join(pluginsDir, pluginId);
const dryRun = process.argv.includes("--dry-run");

await assertReadable(mainPath, "Build output main.js is missing. Run npm run build first.");
await assertReadable(manifestPath, "manifest.json is missing.");
await assertReadable(communityPluginsPath, "community-plugins.json is missing. Refusing to install without checking plugin enablement.");

const enabledPlugins = await readCommunityPlugins(communityPluginsPath);
if (enabledPlugins.includes(pluginId) && process.env.KNOWFLOW_ALLOW_ENABLED_INSTALL !== "1") {
  throw new Error(
    `Plugin "${pluginId}" is already enabled in community-plugins.json. ` +
    "Disable it in Obsidian first, or rerun with KNOWFLOW_ALLOW_ENABLED_INSTALL=1 if you intentionally want to overwrite an enabled dev plugin."
  );
}

const files = [
  ["main.js", mainPath, path.join(targetDir, "main.js")],
  ["manifest.json", manifestPath, path.join(targetDir, "manifest.json")]
];

if (dryRun) {
  console.log(`[dry-run] Vault: ${vaultRoot}`);
  console.log(`[dry-run] Target: ${targetDir}`);
  for (const [name, source, target] of files) {
    console.log(`[dry-run] copy ${name}: ${source} -> ${target}`);
  }
  console.log("[dry-run] write safe styles.css");
  console.log(`[dry-run] community-plugins.json checked. "${pluginId}" will not be enabled automatically.`);
  process.exit(0);
}

await mkdir(targetDir, { recursive: true });
for (const [, source, target] of files) {
  await copyFile(source, target);
}
await writeFile(
  path.join(targetDir, "styles.css"),
  "/* KnowFlow styles intentionally empty for safe dev install. */\n",
  "utf8"
);

console.log(`Installed KnowFlow dev build to ${targetDir}`);
console.log(`Copied only: main.js, manifest.json, styles.css`);
console.log(`Checked community-plugins.json. "${pluginId}" was not enabled automatically.`);

async function readPluginId(filePath) {
  const raw = await readFile(filePath, "utf8");
  const manifest = JSON.parse(raw);
  if (!manifest || typeof manifest.id !== "string" || !manifest.id.trim()) {
    throw new Error("manifest.json must contain a non-empty id.");
  }
  return manifest.id.trim();
}

async function readCommunityPlugins(filePath) {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("community-plugins.json must be a JSON array of plugin ids.");
  }
  return parsed;
}

async function assertReadable(filePath, message) {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(message);
  }
}
