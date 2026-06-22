<script setup lang="ts">
useSeoMeta({
  title: 'Features',
  ogTitle: 'BlueTalk Features',
  description: 'Everything built into BlueTalk — peer-to-peer messaging, end-to-end encryption, stealth mode, and more.',
  ogDescription: 'Everything built into BlueTalk — peer-to-peer messaging, end-to-end encryption, stealth mode, and more.',
})

const features = [
  {
    title: 'Peer-to-Peer',
    description:
      'Messages travel directly between devices with no relay server in the path. As long as two peers can reach each other on the network, they can talk.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  },
  {
    title: 'End-to-End Encrypted',
    description:
      'Every conversation is secured with an ECDH key exchange and AES-256-GCM encryption. Keys never leave your device — not even BlueTalk can read your messages.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>`,
  },
  {
    title: 'No Cloud Required',
    description:
      'Nothing passes through third-party servers. All message data is stored locally on your machine and shared only with the peers you choose to talk to.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"/><path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"/></svg>`,
  },
  {
    title: 'Stealth Mode',
    description:
      'A minimal network footprint designed for restricted or monitored environments. BlueTalk keeps its presence quiet and avoids unnecessary outbound traffic.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
  },
  {
    title: 'Any Network',
    description:
      'Works across LAN, VPN, and direct IP connections without special configuration. If you can ping it, BlueTalk can reach it.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`,
  },
  {
    title: 'No Account Needed',
    description:
      'No sign-up, no email, no tracking. Pick a display name on first launch and you are ready to connect — zero data collected about you.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><line x1="17" y1="8" x2="23" y2="14"/><line x1="23" y1="8" x2="17" y2="14"/></svg>`,
  },
  {
    title: 'Auto Updates',
    description:
      'BlueTalk checks for new releases in the background and applies updates automatically. You always run the latest version without manual effort.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  },
  {
    title: 'Windows Native',
    description:
      'Built as a proper desktop application with system tray integration, native notifications, and support for both an installer and a portable single-file executable.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  },
  {
    title: 'File Sharing',
    description:
      'Send files directly to a peer without uploading to any third-party service. Transfers are encrypted in transit just like your messages.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
  },
  {
    title: 'Read Receipts',
    description:
      'Optional per-conversation read receipts let you know when your messages have been seen, delivered peer-to-peer with no server middleman.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  },
  {
    title: 'Contact Management',
    description:
      'Pin important conversations, set custom nicknames, and block contacts. Everything is local — your contact list belongs to you.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="23" y1="11" x2="17" y2="11"/></svg>`,
  },
  {
    title: 'Portable Build',
    description:
      'The portable edition is a single .exe with no installation required — carry it on a USB drive or run it from any folder on any Windows machine.',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`,
  },
]
</script>

<template>
  <div class="features-page">
    <!-- Hero -->
    <section class="section">
      <div class="container features-hero">
        <div class="section-heading">
          <span class="section-tag">What's included</span>
          <h1>Everything in BlueTalk</h1>
          <p>
            A focused set of capabilities built around one idea: direct, private communication
            with no infrastructure in the way.
          </p>
        </div>

        <div class="features-cta">
          <NuxtLink to="/download" class="button button-primary">Download</NuxtLink>
          <a
            href="https://github.com/Bluetalk/bluetalk"
            target="_blank"
            rel="noreferrer"
            class="button button-secondary"
          >View on GitHub</a>
        </div>
      </div>
    </section>

    <!-- Feature grid -->
    <section class="section features-grid-section">
      <div class="container">
        <div class="features-grid">
          <div
            v-for="feature in features"
            :key="feature.title"
            class="feature-item"
          >
            <div class="feature-item-icon" v-html="feature.icon" />
            <div class="feature-item-body">
              <h3>{{ feature.title }}</h3>
              <p>{{ feature.description }}</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- CTA -->
    <section class="section section-accent">
      <div class="container">
        <div class="cta-panel">
          <div>
            <h2>Ready to try it?</h2>
            <p>Download BlueTalk for Windows — installer or portable, your choice.</p>
          </div>
          <div class="cta-actions">
            <NuxtLink to="/download" class="button button-primary">Download now</NuxtLink>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.features-page {
  padding-top: 24px;
}

.features-hero {
  display: grid;
  gap: 20px;
}

.features-hero h1 {
  font-size: clamp(1.75rem, 4vw, 2.35rem);
  line-height: 1.2;
  font-weight: 600;
  letter-spacing: -0.45px;
}

.features-cta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.features-grid-section {
  padding-top: 0;
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.feature-item {
  display: flex;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background: var(--bg-1);
  transition: border-color 0.15s ease, background 0.15s ease;
}

.feature-item:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.feature-item-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-md);
  background: var(--bg-3);
  color: var(--fg-2);
  transition: color 0.15s ease, background 0.15s ease;
}

.feature-item:hover .feature-item-icon {
  color: var(--blue);
  background: var(--blue-soft);
}

.feature-item-icon :deep(svg) {
  width: 16px;
  height: 16px;
}

.feature-item-body {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.feature-item-body h3 {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--fg-0);
}

.feature-item-body p {
  font-size: 13px;
  line-height: 1.6;
  color: var(--fg-2);
}

@media (max-width: 680px) {
  .features-grid {
    grid-template-columns: 1fr;
  }

  .features-cta {
    flex-direction: column;
  }

  .features-cta .button {
    width: 100%;
  }
}
</style>
