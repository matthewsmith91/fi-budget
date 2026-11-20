/**
 * Versions and release notes. Releases are GitHub Releases tagged `v<version>` (made by
 * .github/workflows/release.yml from the root package.json version).
 *
 * The app never asks GitHub whether a newer release exists: a device hears about an update only
 * when the household's server has new app files, which the service worker finds and offers as
 * "Update now" (`useServiceWorker` in hooks.ts). A release that changes only the server is never
 * announced on a device.
 */

export const RELEASE_REPO = 'matthewsmith91/fi-budget'

export const releasesPage = `https://github.com/${RELEASE_REPO}/releases`

interface ParsedVersion {
  core: [number, number, number]
  pre: string | null
}

function parse(v: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null }
}

/**
 * 1 if `a` is newer, -1 if older, 0 if the same. Build metadata (`+…`) is ignored, as semver
 * says; a pre-release sorts before its release (`1.2.0-beta.1` < `1.2.0`), and two pre-releases
 * of one version compare as text, which is enough for `beta.1` < `beta.2`. A string that isn't
 * a version compares as older than any version.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!
    if (d !== 0) return Math.sign(d)
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return pa.pre < pb.pre ? -1 : 1
}

/** True once per update: this device last ran an older version than the one running now. */
export function justUpdated(lastSeen: string | null, current: string): boolean {
  return lastSeen !== null && compareVersions(current, lastSeen) > 0
}
