<script setup lang="ts">
useSeoMeta({
  title: 'Stealth P2P Chat',
  ogTitle: 'BlueTalk',
  description: 'Peer-to-peer messaging built for silence. No servers, no accounts, no traces.',
  ogDescription: 'Peer-to-peer messaging built for silence. No servers, no accounts, no traces.',
})

const highlightFeatures = [
  {
    title: 'Peer-to-Peer',
    description: 'Messages travel directly between devices — no relay server in the path.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  },
  {
    title: 'End-to-End Encrypted',
    description: 'ECDH key exchange and AES-256-GCM. Keys never leave your device.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>`,
  },
  {
    title: 'No Cloud Required',
    description: 'Nothing passes through third-party servers. Your data stays on your machine.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"/><path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"/></svg>`,
  },
  {
    title: 'Stealth Mode',
    description: 'Minimal network footprint for restricted or monitored environments.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
  },
  {
    title: 'No Account Needed',
    description: 'Pick a display name on first launch. No sign-up, no email, no tracking.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><line x1="17" y1="8" x2="23" y2="14"/><line x1="23" y1="8" x2="17" y2="14"/></svg>`,
  },
  {
    title: 'Windows Native',
    description: 'Desktop app with tray integration, notifications, installer and portable builds.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  },
]

const steps = [
  {
    step: '01',
    title: 'Install & connect',
    description: 'Download the installer or portable build. BlueTalk discovers peers on your LAN, VPN, or direct IP.',
  },
  {
    step: '02',
    title: 'Exchange keys',
    description: 'An ECDH handshake establishes a shared secret. Every message is encrypted before it leaves your device.',
  },
  {
    step: '03',
    title: 'Talk directly',
    description: 'Messages and files flow peer-to-peer. No cloud relay, no account, no middleman.',
  },
]
</script>

<template>
  <div class="home-page">
    <!-- Hero -->
    <section class="hero hero--split">
      <HeroBackdrop />

      <div class="container hero-layout">
        <div class="hero-panel">
          <div class="eyebrow-pill">
            <span class="eyebrow-dot" />
            P2P Messaging for Windows
          </div>

          <div class="hero-copy">
            <h1>Direct conversations.<br />Minimal surface area.</h1>
            <p>
              BlueTalk is desktop messaging for restricted networks and low-noise environments.
              Peer-to-peer by default — no servers, no accounts, no traces.
            </p>
          </div>

          <div class="hero-actions">
            <NuxtLink to="/download" class="button button-primary button-lg">
              Download for Windows
            </NuxtLink>
            <NuxtLink to="/features" class="button button-secondary button-lg">
              Explore features
            </NuxtLink>
          </div>

          <div class="peer-strip" aria-label="Peer-to-peer link illustration">
            <div class="peer-node">
              <span class="peer-node-dot" />
              Peer A
            </div>
            <div class="peer-bridge">
              <span class="peer-line" />
              <span class="peer-lock" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              </span>
            </div>
            <div class="peer-node">
              <span class="peer-node-dot" />
              Peer B
            </div>
          </div>
        </div>

        <AppPreview />
      </div>
    </section>

    <!-- Trust strip -->
    <section class="section section-compact">
      <div class="container">
        <TrustStrip />
      </div>
    </section>

    <!-- Highlights -->
    <section class="section">
      <div class="container">
        <SectionHeading
          tag="Core capabilities"
          title="Built for privacy by architecture"
          description="Every feature follows one principle: keep communication direct, encrypted, and under your control."
        />

        <div class="feature-grid feature-grid--home">
          <FeatureCard
            v-for="feature in highlightFeatures"
            :key="feature.title"
            :title="feature.title"
            :description="feature.description"
            :icon="feature.icon"
            compact
          />
        </div>

        <div class="section-link-row">
          <NuxtLink to="/features" class="text-link">
            View all features
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </NuxtLink>
        </div>
      </div>
    </section>

    <!-- How it works -->
    <section class="section section-muted">
      <div class="container">
        <SectionHeading
          tag="How it works"
          title="Three steps to a direct link"
          description="No infrastructure to provision. If two peers can reach each other on the network, they can talk."
          align="center"
        />

        <ol class="steps-grid">
          <li v-for="item in steps" :key="item.step" class="step-card">
            <span class="step-number">{{ item.step }}</span>
            <h3>{{ item.title }}</h3>
            <p>{{ item.description }}</p>
          </li>
        </ol>
      </div>
    </section>

    <!-- CTA -->
    <section class="section section-accent">
      <div class="container">
        <div class="cta-panel cta-panel--prominent">
          <div class="cta-panel-copy">
            <span class="section-tag">Get started</span>
            <h2>Ready to keep the signal direct?</h2>
            <p>Download BlueTalk for Windows — choose the installer or carry the portable build anywhere.</p>
          </div>
          <div class="cta-actions">
            <NuxtLink to="/download" class="button button-primary button-lg">Download now</NuxtLink>
            <a
              href="https://github.com/Bluetalk/bluetalk"
              target="_blank"
              rel="noreferrer"
              class="button button-secondary button-lg"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home-page {
  overflow-x: clip;
}

.hero--split {
  padding: 40px 0 24px;
}

.hero-layout {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
  gap: 32px;
  align-items: center;
}

.hero-panel {
  display: grid;
  gap: 22px;
  padding: 32px clamp(18px, 3vw, 36px);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  background: color-mix(in srgb, var(--bg-1) 92%, transparent);
  backdrop-filter: blur(12px);
  box-shadow: var(--shadow-md);
}

.hero-copy h1 {
  font-size: clamp(2rem, 4.5vw, 2.75rem);
  line-height: 1.12;
  font-weight: 700;
  letter-spacing: -0.6px;
}

.section-compact {
  padding: 0 0 48px;
}

.section-muted {
  background: var(--bg-1);
  border-block: 1px solid var(--border);
}

.section-link-row {
  margin-top: 20px;
  display: flex;
  justify-content: center;
}

.text-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--blue);
  transition: gap 0.15s ease;
}

.text-link:hover {
  gap: 10px;
}

.steps-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin: 32px 0 0;
  padding: 0;
  list-style: none;
}

.step-card {
  display: grid;
  gap: 10px;
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background: var(--bg-0);
  transition: border-color 0.15s ease, transform 0.15s ease;
}

.step-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-2px);
}

.step-number {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px;
  font-weight: 500;
  color: var(--blue);
  letter-spacing: 0.05em;
}

.step-card h3 {
  font-size: 15px;
  font-weight: 600;
}

.step-card p {
  font-size: 13px;
  line-height: 1.6;
  color: var(--fg-2);
}

.cta-panel--prominent {
  flex-direction: column;
  align-items: stretch;
  padding: 32px;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--blue) 8%, var(--bg-1)),
    var(--bg-1)
  );
  border-color: color-mix(in srgb, var(--blue) 20%, var(--border));
}

.cta-panel-copy {
  display: grid;
  gap: 10px;
  max-width: 520px;
}

.cta-panel-copy h2 {
  font-size: clamp(1.35rem, 2.5vw, 1.65rem);
}

.cta-panel-copy p {
  color: var(--fg-2);
  font-size: 14px;
  line-height: 1.6;
}

@media (max-width: 960px) {
  .hero-layout {
    grid-template-columns: 1fr;
  }

  .steps-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 680px) {
  .hero-panel {
    padding: 24px 18px;
  }

  .peer-strip {
    display: none;
  }
}
</style>
