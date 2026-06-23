<script setup lang="ts">
const items = [
  { value: 'P2P', label: 'Direct peer links' },
  { value: 'E2E', label: 'AES-256-GCM encryption' },
  { value: '0', label: 'Cloud servers required' },
  { value: '100%', label: 'Local data storage' },
]
</script>

<template>
  <div class="trust-strip" role="list" aria-label="Key product highlights">
    <div v-for="item in items" :key="item.label" class="trust-strip-item" role="listitem">
      <span class="trust-strip-value">{{ item.value }}</span>
      <span class="trust-strip-label">{{ item.label }}</span>
    </div>
  </div>
</template>
