type GhAsset = {
  name: string
  browser_download_url: string
  size: number
}

type GhRelease = {
  tag_name: string
  draft?: boolean
  prerelease?: boolean
  published_at: string | null
  body?: string | null
  assets: GhAsset[]
}

export type ReleasePayload = {
  tag: string | null
  installer: { url: string; name: string; size: number } | null
  portable: { url: string; name: string; size: number } | null
  error: string | null
  /**
   * `tag_name` of GitHub `GET /repos/.../releases/latest` when that release has no Windows .exe yet
   * (for example CI still uploading assets). Downloads may come from an older release instead.
   */
  pendingLatestTag: string | null
}

export type ReleaseEntry = {
  tag: string
  publishedAt: string | null
  body: string | null
  installer: { url: string; name: string; size: number } | null
  portable: { url: string; name: string; size: number } | null
}

const REPO = 'Bluetalk/bluetalk'

function githubHeaders(token: string | undefined) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'BlueTalk-Website',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export function pickWindowsAssets(assets: GhAsset[]) {
  const exes = assets.filter((a) => {
    const n = a.name.toLowerCase()
    return n.endsWith('.exe') && !n.endsWith('.blockmap')
  })
  if (!exes.length) return { installer: null, portable: null }

  const portable = exes.find((a) => /portable/i.test(a.name)) ?? null

  let installer =
    exes.find((a) => {
      if (/portable/i.test(a.name)) return false
      return /\bsetup\b/i.test(a.name) || /[-_]setup[-_.]/i.test(a.name)
    }) ?? null

  if (!installer && portable) {
    installer = exes.find((a) => a.name !== portable.name) ?? null
  }

  if (!installer && !portable) {
    installer = exes[0] ?? null
  }

  return { installer, portable }
}

function ghReleaseHasNoWindowsExe(rel: GhRelease): boolean {
  const { installer, portable } = pickWindowsAssets(rel.assets || [])
  return !installer && !portable
}

function payloadFromRelease(rel: GhRelease | null | undefined): ReleasePayload {
  const fallback: ReleasePayload = {
    tag: null,
    installer: null,
    portable: null,
    error: null,
    pendingLatestTag: null,
  }
  if (!rel) {
    return { ...fallback, error: 'No release data' }
  }
  const { installer, portable } = pickWindowsAssets(rel.assets || [])
  return {
    tag: rel.tag_name ?? null,
    installer: installer
      ? { url: installer.browser_download_url, name: installer.name, size: installer.size }
      : null,
    portable: portable
      ? { url: portable.browser_download_url, name: portable.name, size: portable.size }
      : null,
    error: !installer && !portable ? 'No Windows .exe assets on this release' : null,
    pendingLatestTag: null,
  }
}

async function fetchJson<T>(url: string, token: string | undefined): Promise<{ ok: boolean; status: number; data: T | null }> {
  const res = await fetch(url, { headers: githubHeaders(token) })
  if (!res.ok) {
    return { ok: false, status: res.status, data: null }
  }
  const data = (await res.json()) as T
  return { ok: true, status: res.status, data }
}

/** Prefer /releases/latest; if missing (e.g. only pre-releases), scan recent releases. */
export async function resolveLatestWindowsAssets(): Promise<ReleasePayload> {
  const token = process.env.GITHUB_TOKEN
  const empty: ReleasePayload = {
    tag: null,
    installer: null,
    portable: null,
    error: null,
    pendingLatestTag: null,
  }

  try {
    const latest = await fetchJson<GhRelease>(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      token,
    )

    const pendingFromLatest =
      latest.ok && latest.data && ghReleaseHasNoWindowsExe(latest.data)
        ? (latest.data.tag_name ?? null)
        : null

    if (latest.ok && latest.data) {
      const p = payloadFromRelease(latest.data)
      if (!p.error) return { ...p, pendingLatestTag: null }
    }

    const list = await fetchJson<GhRelease[]>(
      `https://api.github.com/repos/${REPO}/releases?per_page=25`,
      token,
    )

    if (!list.ok || !list.data?.length) {
      return {
        ...empty,
        error: latest.ok
          ? 'No Windows .exe assets found'
          : `GitHub returned ${latest.status} for latest, ${list.status} for list`,
        pendingLatestTag: pendingFromLatest,
      }
    }

    const candidates = list.data.filter((r) => !r.draft && (r.assets?.length ?? 0) > 0)

    const scored = candidates
      .map((r) => {
        const p = payloadFromRelease(r)
        const t = r.published_at ? Date.parse(r.published_at) : 0
        const ok = !p.error
        return { r, p, t, ok }
      })
      .filter((x) => x.ok)
      .sort((a, b) => b.t - a.t)

    const best = scored[0]
    if (best) return { ...best.p, pendingLatestTag: pendingFromLatest }

    return {
      ...empty,
      error: 'No published release with Windows .exe assets',
      pendingLatestTag: pendingFromLatest,
    }
  } catch {
    return { ...empty, error: 'Could not load release info' }
  }
}

/** Fetch all non-draft releases sorted newest-first, with assets and changelog body. */
export async function resolveAllReleases(): Promise<{ releases: ReleaseEntry[]; error: string | null }> {
  const token = process.env.GITHUB_TOKEN
  try {
    const list = await fetchJson<GhRelease[]>(
      `https://api.github.com/repos/${REPO}/releases?per_page=50`,
      token,
    )
    if (!list.ok || !list.data) {
      return { releases: [], error: `GitHub returned ${list.status}` }
    }
    const releases: ReleaseEntry[] = list.data
      .filter((r) => !r.draft)
      .map((r): ReleaseEntry => {
        const { installer, portable } = pickWindowsAssets(r.assets || [])
        return {
          tag: r.tag_name,
          publishedAt: r.published_at ?? null,
          body: r.body?.trim() || null,
          installer: installer
            ? { url: installer.browser_download_url, name: installer.name, size: installer.size }
            : null,
          portable: portable
            ? { url: portable.browser_download_url, name: portable.name, size: portable.size }
            : null,
        }
      })
      .sort((a, b) => {
        const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0
        const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0
        return tb - ta
      })
    return { releases, error: null }
  } catch {
    return { releases: [], error: 'Could not load release info' }
  }
}
