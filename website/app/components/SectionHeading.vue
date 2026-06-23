<script setup lang="ts">
withDefaults(
  defineProps<{
    tag?: string
    title: string
    description?: string
    align?: 'left' | 'center'
    headingLevel?: 'h1' | 'h2'
  }>(),
  { headingLevel: 'h2' },
)
</script>

<template>
  <div class="section-heading" :class="{ 'section-heading--center': align === 'center' }">
    <span v-if="tag" class="section-tag">{{ tag }}</span>
    <h1 v-if="headingLevel === 'h1'">{{ title }}</h1>
    <h2 v-else>{{ title }}</h2>
    <p v-if="description">{{ description }}</p>
  </div>
</template>
