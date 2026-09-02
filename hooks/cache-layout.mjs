/**
 * Plugin cache layout helpers.
 *
 * Claude Code installs plugins at
 *   <configDir>/plugins/cache/<marketplace>/<plugin>/<version>/
 * where <marketplace> is the marketplace the plugin was added FROM, not the
 * plugin's own name. Upstream context-mode ships from a marketplace that is
 * also called "context-mode", so the doubled `context-mode/context-mode`
 * literal happened to be correct there. A fork served from any other
 * marketplace installs under that marketplace's name instead, and every
 * hardcoded copy of the doubled literal then matches a directory that does
 * not exist: the heal reports success and does nothing.
 *
 * Derive the segment from the running code's own install path instead.
 */

/** Upstream fallback for install shapes with no cache path (npm-global, dev checkout). */
export const UPSTREAM_CACHE_PREFIX = "context-mode/context-mode";

/** Escape a string for literal use inside a RegExp. */
export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Windows paths are case-insensitive, so a path surfaced as `.../Plugins/Cache/...`
// is the same directory. Matching it case-sensitively there returns null and
// sends the caller to UPSTREAM_CACHE_PREFIX -- exactly the hardcoded-literal
// behaviour this module exists to remove. POSIX stays case-sensitive.
const CACHE_SEGMENT_RE = new RegExp(
  "/plugins/cache/([^/]+)/([^/]+)(?:/|$)",
  process.platform === "win32" ? "i" : "",
);

/**
 * Extract `<marketplace>/<plugin>` (forward slashes) from a path inside the
 * plugin cache layout. Accepts either the per-version pluginRoot or its
 * `<cache>/<marketplace>/<plugin>` parent. Returns null for anything else --
 * an npm-global install or a dev checkout. Callers must decide their own
 * fallback; see UPSTREAM_CACHE_PREFIX.
 */
export function cachePluginPrefix(pathLike) {
  if (!pathLike) return null;
  const fwd = String(pathLike).replace(/\\/g, "/");
  const m = CACHE_SEGMENT_RE.exec(fwd);
  return m ? `${m[1]}/${m[2]}` : null;
}
