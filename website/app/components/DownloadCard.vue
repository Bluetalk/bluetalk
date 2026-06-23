<script setup lang="ts">
defineProps<{
  eyebrow: string
  title: string
  description: string
  href: string
  meta: string
}>()
</script>

<template>
  <a
    class="download-card"
    :href="href"
    rel="noopener noreferrer"
    :aria-label="`${title}: ${description} (download)`"
  >
    <div class="download-card-top">
      <span class="card-eyebrow">{{ eyebrow }}</span>
      <span class="download-card-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </span>
    </div>
    <h3>{{ title }}</h3>
    <p>{{ description }}</p>
    <div class="download-card-meta">{{ meta }}</div>
    <span class="download-card-action">
      Download
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
    </span>
  </a>
</template>
