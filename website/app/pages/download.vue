<script setup lang="ts">
useSeoMeta({
  title: 'Download',
  ogTitle: 'BlueTalk Download',
  description: 'Download the latest BlueTalk installer or portable build.',
  ogDescription: 'Download the latest BlueTalk installer or portable build.',
})

type ReleaseAsset = { url: string; name: string; size: number }

type ReleasePayload = {
  tag: string | null
  installer: ReleaseAsset | null
  portable: ReleaseAsset | null
  error: string | null
  pendingLatestTag: string | null
}

type ReleaseEntry = {
  tag: string
  publishedAt: string | null
  body: string | null
  installer: ReleaseAsset | null
  portable: ReleaseAsset | null
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

const { data, pending, error } = await useFetch<ReleasePayload>('/api/releases/latest', {
  key: 'bluetalk-latest-release',
})

const { data: allData, pending: allPending } = await useFetch<{
  releases: ReleaseEntry[]
  error: string | null
}>('/api/releases/all', { key: 'bluetalk-all-releases' })

/** Same repo as `server/utils/releases.ts` — external URL so static prerender never crawls /api/releases/download (404 without assets). */
const githubReleasesPage = 'https://github.com/Bluetalk/bluetalk/releases'

const baseMeta = ['Setup · Windows · .exe', 'No install · Windows · .exe'] as const

const allReleases = computed<ReleaseEntry[]>(() => allData.value?.releases ?? [])

/** Newest published release (GitHub order); drives the featured block and headline tag. */
const newestRelease = computed(() => allReleases.value[0] ?? null)

/** Older releases only — shown as a timeline below the featured newest release. */
const timelineReleases = computed(() => allReleases.value.slice(1))

/**
 * Prefer Windows assets from the newest GitHub release when present; otherwise use the
 * fallback from `/api/releases/latest` (e.g. newest tag has no .exe yet).
 */
const downloadSource = computed(() => {
  const n = newestRelease.value
  if (n && (n.installer || n.portable)) {
    return {
      tag: n.tag,
      installer: n.installer,
      portable: n.portable,
    }
  }
  return {
    tag: data.value?.tag ?? null,
    installer: data.value?.installer ?? null,
    portable: data.value?.portable ?? null,
  }
})

const pagePending = computed(() => pending.value || allPending.value)

const cards = computed(() => {
  const d = downloadSource.value
  const installerMeta = d?.installer?.size
    ? `Setup · Windows · .exe · ${formatBytes(d.installer.size)}`
    : baseMeta[0]
  const portableMeta = d?.portable?.size
    ? `No install · Windows · .exe · ${formatBytes(d.portable.size)}`
    : baseMeta[1]

  return [
    {
      key: 'installer',
      eyebrow: 'Windows Setup',
      title: 'Installer',
      description:
        'Standard desktop installation with shortcuts, updates and a familiar Windows install flow.',
      meta: installerMeta,
      href: d?.installer?.url ?? githubReleasesPage,
    },
    {
      key: 'portable',
      eyebrow: 'Portable Build',
      title: 'Portable',
      description: 'Single executable for environments where installation should stay optional.',
      meta: portableMeta,
      href: d?.portable?.url ?? githubReleasesPage,
    },
  ]
})

const releaseVersionText = computed(() => {
  const tag = data.value?.tag?.trim()
  return tag || null
})

/** Tag for the release that actually supplies the download URLs in the cards (may differ when the newest tag has no Windows build yet). */
const offeredReleaseTag = computed(() => downloadSource.value.tag?.trim() || null)

const pendingLatestTag = computed(() => data.value?.pendingLatestTag?.trim() || null)

/** Headline: true newest tag from the full release list, then GitHub “latest” pending tag, then API fallback. */
const headlineReleaseTag = computed(() => {
  return (
    newestRelease.value?.tag?.trim() || pendingLatestTag.value || releaseVersionText.value || null
  )
})

const showBuildPendingNotice = computed(
  () => Boolean(!pagePending.value && pendingLatestTag.value),
)

const buildPendingNoticeText = computed(() => {
  const pend = pendingLatestTag.value
  const offered = offeredReleaseTag.value
  if (!pend) return ''
  if (offered && offered !== pend) {
    return `GitHub's current release ${pend} does not list Windows installers yet—the build may still be uploading. The downloads below are from ${offered}, the newest release that already includes Windows installers.`
  }
  return `GitHub's current release ${pend} does not list Windows installers yet—the build may still be uploading. Check back soon or browse past releases on GitHub.`
})

const showApiWarning = computed(() => Boolean(error.value || data.value?.error))
const apiWarningText = computed(() => {
  if (error.value) {
    return 'Could not load release details (sizes). The download buttons link to GitHub releases until asset metadata is available.'
  }
  if (data.value?.error) {
    return `${data.value.error} The buttons below open GitHub releases; publish a Windows .exe there for one-click downloads.`
  }
  return ''
})

</script>

<template>
  <div class="download-page">
    <section class="section download-hero-section">
      <div class="container download-hero">
        <div class="download-hero-panel">
          <SectionHeading
            tag="Get BlueTalk"
            title="Download Options"
            heading-level="h1"
          />
          <p v-if="pagePending" class="download-version-indicator" aria-live="polite">
            Download BlueTalk …
          </p>
          <p v-else-if="headlineReleaseTag" class="download-version-indicator">
            <span class="download-version-line">
              Download BlueTalk {{ headlineReleaseTag }}
              <span v-if="newestRelease" class="release-latest-badge download-latest-pill"
                >Latest release</span
              >
            </span>
          </p>
          <p v-else class="download-version-indicator download-version-indicator--muted">
            Download BlueTalk
          </p>
          <p>
            Pick the installer for a standard desktop setup or use the portable build
            when you need to keep installation overhead low.
          </p>
          <p v-if="showBuildPendingNotice" class="download-build-pending" role="status">
            {{ buildPendingNoticeText }}
          </p>
          <p v-if="showApiWarning" class="download-api-hint" role="status">
            {{ apiWarningText }}
          </p>
        </div>

        <div v-if="pagePending" class="download-placeholder" aria-live="polite">
          Resolving latest release and download links…
        </div>

        <template v-else>
          <div class="download-grid">
            <DownloadCard
              v-for="item in cards"
              :key="item.key"
              :eyebrow="item.eyebrow"
              :title="item.title"
              :description="item.description"
              :meta="item.meta"
              :href="item.href"
            />
          </div>

          <details
            v-if="newestRelease?.body"
            class="release-changelog release-changelog--featured"
            open
          >
            <summary class="release-changelog-toggle">
              Changelog · {{ newestRelease.tag }}
            </summary>
            <pre class="release-changelog-body">{{ newestRelease.body }}</pre>
          </details>
        </template>
      </div>
    </section>

    <!-- Older releases timeline -->
    <section v-if="timelineReleases.length" class="section releases-section">
      <div class="container">
        <div class="releases-header">
          <h2 class="releases-title">Earlier releases</h2>
          <a
            :href="githubReleasesPage"
            target="_blank"
            rel="noopener noreferrer"
            class="releases-github-link"
          >View on GitHub</a>
        </div>
        <p class="releases-timeline-intro">
          Newest version is above; older builds stay available below.
        </p>

        <div class="releases-timeline" role="list">
          <div
            v-for="release in timelineReleases"
            :key="release.tag"
            class="release-item releases-timeline-item"
            role="listitem"
          >
            <div class="release-item-top">
              <div class="release-item-meta">
                <span class="release-tag-badge">{{ release.tag }}</span>
                <span v-if="release.publishedAt" class="release-date">
                  {{ formatDate(release.publishedAt) }}
                </span>
              </div>
              <div v-if="release.installer || release.portable" class="release-item-actions">
                <a
                  v-if="release.installer"
                  :href="release.installer.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="release-dl-btn"
                >
                  Installer
                  <span class="release-dl-size">{{ formatBytes(release.installer.size) }}</span>
                </a>
                <a
                  v-if="release.portable"
                  :href="release.portable.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="release-dl-btn"
                >
                  Portable
                  <span class="release-dl-size">{{ formatBytes(release.portable.size) }}</span>
                </a>
              </div>
              <span v-else class="release-no-assets">No Windows builds</span>
            </div>

            <details v-if="release.body" class="release-changelog">
              <summary class="release-changelog-toggle">Changelog</summary>
              <pre class="release-changelog-body">{{ release.body }}</pre>
            </details>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
