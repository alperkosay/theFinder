import { encodeId } from "./id";
import { mimeOf } from "./mime";
import { basename, dirname, extname } from "./path";
import { THUMBS_ROOT } from "./thumbnails";
import { TRASH_ROOT } from "./trash";
import type { DriverStat, StorageStats, UsageCategory, VersionedFile, VolumePath } from "./types";
import { groupExists, isVersionsPath, scanGroups } from "./versions";
import type { Volume } from "./volume";
import { mapLimit } from "./stream";
import { walkAll } from "./walk";

const DOCUMENT = new Set([
  "pdf",
  "doc",
  "docx",
  "odt",
  "rtf",
  "pages",
  "xls",
  "xlsx",
  "ods",
  "numbers",
  "ppt",
  "pptx",
  "odp",
  "key",
  "epub",
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "log",
]);
const ARCHIVE = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso", "dmg"]);
const CODE = new Set([
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "json",
  "jsonc",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "xml",
  "yml",
  "yaml",
  "toml",
  "sh",
  "py",
  "rb",
  "php",
  "java",
  "kt",
  "go",
  "rs",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "swift",
  "sql",
  "vue",
  "svelte",
  "graphql",
  "wasm",
]);

export function usageCategory(name: string): UsageCategory {
  const ext = extname(name);
  const mime = mimeOf(name);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (DOCUMENT.has(ext)) return "document";
  if (ARCHIVE.has(ext)) return "archive";
  if (CODE.has(ext)) return "code";
  return "other";
}

const under = (root: string, path: string) => path === root || path.startsWith(root + "/");

const LARGEST = 12;
const VERSIONED_ITEMS = 200;

/**
 * Whether the `permission` callback lets the user read `path` and every folder above it, the way a
 * walk from the root would reach it. Memoized per folder: one stats scan asks for every path.
 */
function readablePaths(vol: Volume): (path: VolumePath) => boolean {
  if (!vol.options.permission) return () => true;
  const known = new Map<VolumePath, boolean>();
  const readable = (path: VolumePath): boolean => {
    if (path === "/") return true;
    let ok = known.get(path);
    if (ok === undefined) {
      ok = readable(dirname(path)) && vol.can("read", path);
      known.set(path, ok);
    }
    return ok;
  };
  return readable;
}

/**
 * Scans a whole volume once and summarizes where the space goes. Totals cover the whole volume;
 * items the user may not read never appear by name (largest files, version histories).
 */
export async function collectStats(vol: Volume): Promise<StorageStats> {
  const readable = readablePaths(vol);
  const [{ items, truncated }, capacity] = await Promise.all([walkAll(vol.driver, "/"), vol.driver.capacity?.().catch(() => null) ?? null]);

  const categories = Object.fromEntries(
    (["image", "video", "audio", "document", "archive", "code", "other"] as const).map((c) => [c, { files: 0, size: 0 }]),
  ) as StorageStats["categories"];
  const trash = { count: 0, size: 0 };
  const cache = { files: 0, size: 0 };
  const versionItems: DriverStat[] = [];
  let files = 0;
  let dirs = 0;
  let size = 0;
  let largest: DriverStat[] = [];

  for (const s of items) {
    if (s.path === "/") continue;
    if (under(TRASH_ROOT, s.path)) {
      // One sidecar per trashed item sits directly in the trash root.
      if (s.kind === "file" && s.path.lastIndexOf("/") === TRASH_ROOT.length && s.name.endsWith(".json")) trash.count++;
      else if (s.kind === "file") trash.size += s.size;
      continue;
    }
    if (under(THUMBS_ROOT, s.path)) {
      if (s.kind === "file") {
        cache.files++;
        cache.size += s.size;
      }
      continue;
    }
    if (isVersionsPath(s.path)) {
      versionItems.push(s);
      continue;
    }
    if (vol.isHiddenPath(s.path)) continue;
    if (s.kind === "dir") {
      dirs++;
      continue;
    }
    files++;
    size += s.size;
    const bucket = categories[usageCategory(s.name)];
    bucket.files++;
    bucket.size += s.size;
    if (readable(s.path) && (largest.length < LARGEST || s.size > largest[largest.length - 1]!.size)) {
      largest.push(s);
      largest.sort((a, b) => b.size - a.size);
      largest = largest.slice(0, LARGEST);
    }
  }

  // A history whose file path is unknown cannot be checked, so it is only listed without a permission callback.
  const groups = (await scanGroups(vol, versionItems)).filter((g) => g.versions.length && (g.path ? readable(g.path) : !vol.options.permission));
  const exists = await mapLimit(groups, 8, (g) => groupExists(vol, g));
  const versioned: VersionedFile[] = groups.map((g, i) => ({
    id: encodeId(vol.id, g.path ?? g.dir),
    path: g.path ?? g.dir,
    name: g.path ? basename(g.path) : "?",
    exists: exists[i]!,
    count: g.versions.length,
    size: g.size,
    latest: g.versions[0]!.createdAt,
  }));
  versioned.sort((a, b) => b.size - a.size);

  return {
    volume: vol.id,
    files,
    dirs,
    size,
    categories,
    largest: largest.map((s) => vol.entry(s)),
    versions: {
      files: versioned.length,
      count: versioned.reduce((n, v) => n + v.count, 0),
      size: versioned.reduce((n, v) => n + v.size, 0),
      orphaned: versioned.filter((v) => !v.exists).length,
      items: versioned.slice(0, VERSIONED_ITEMS),
    },
    trash,
    cache,
    capacity,
    truncated,
    scannedAt: Date.now(),
  };
}
