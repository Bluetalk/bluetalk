<script setup lang="ts">
useSeoMeta({
  title: 'Stealth P2P Chat',
  ogTitle: 'BlueTalk',
  description: 'Peer-to-peer messaging built for silence. No servers, no accounts, no traces.',
  ogDescription: 'Peer-to-peer messaging built for silence. No servers, no accounts, no traces.',
})

const features = [
  'Peer-to-peer by default',
  'No cloud relay required',
  'Encrypted transport',
  'Stealth-minded desktop UX',
  'Portable Windows builds',
  'Auto-update support',
]
</script>

<template>
  <div>
    <section class="hero">
      <HeroBackdrop />

      <div class="container hero-inner">
        <div class="eyebrow-pill">
          <span class="eyebrow-dot" />
          P2P Messaging
        </div>

        <div class="hero-copy">
          <h1>BlueTalk keeps the signal direct and the surface area small.</h1>
          <p>
            Desktop messaging for restricted networks and low-noise environments.
          </p>
        </div>

        <div class="peer-strip" aria-label="Peer-to-peer link illustration">
          <div class="peer-node">
            <span class="peer-node-dot" />
            Peer A
          </div>
          <div class="peer-bridge">
            <span class="peer-line" />
            <span class="peer-lock">+</span>
          </div>
          <div class="peer-node">
            <span class="peer-node-dot" />
            Peer B
          </div>
        </div>

        <div class="hero-actions">
          <NuxtLink to="/download" class="button button-primary">Download</NuxtLink>
          <a href="https://github.com/Bluetalk/bluetalk" target="_blank" rel="noreferrer" class="button button-secondary">
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  </div>
</template>
