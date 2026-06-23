<script setup lang="ts">
defineProps<{
  title: string
  description: string
  icon: string
  compact?: boolean
}>()
</script>

<template>
  <article class="feature-card" :class="{ 'feature-card--compact': compact }">
    <div class="feature-card-icon" v-html="icon" />
    <div class="feature-card-body">
      <h3>{{ title }}</h3>
      <p>{{ description }}</p>
    </div>
  </article>
</template>
