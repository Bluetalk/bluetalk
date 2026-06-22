<script setup lang="ts">
const route = useRoute()
const menuOpen = ref(false)
const { isLight, toggle, themeColor } = useColorMode()

useHead(() => ({
  meta: [{ name: 'theme-color', content: themeColor.value }],
}))

const navItems = [
  { to: '/', label: 'Overview' },
  { to: '/features', label: 'Features' },
  { to: '/download', label: 'Download' },
]

const isActive = (to: string) => {
  if (to === '/') {
    return route.path === '/'
  }

  return route.path.startsWith(to)
}

watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false
  },
)

const toggleMenu = () => {
  menuOpen.value = !menuOpen.value
}
</script>

<template>
  <div class="header-wrap">
    <a class="skip-link" href="#main-content">Skip to main content</a>

    <header class="site-header">
      <div class="container header-inner" :class="{ 'nav-open': menuOpen }">
        <NuxtLink to="/" class="brand-mark" aria-label="BlueTalk home">
          <span class="brand-orb" />
          <span class="brand-word">BlueTalk</span>
        </NuxtLink>

        <button
          type="button"
          class="nav-toggle"
          :aria-expanded="menuOpen"
          aria-controls="site-nav"
          @click="toggleMenu"
        >
          <span class="nav-toggle-bars" aria-hidden="true" />
          <span class="nav-toggle-label">{{ menuOpen ? 'Close menu' : 'Menu' }}</span>
        </button>

        <div id="site-nav" class="header-nav-panel">
          <nav class="main-nav" aria-label="Main navigation">
            <NuxtLink
              v-for="item in navItems"
              :key="item.to"
              :to="item.to"
              class="nav-link"
              :class="{ 'is-active': isActive(item.to) }"
            >
              {{ item.label }}
            </NuxtLink>
          </nav>

          <button
            type="button"
            class="theme-toggle"
            :aria-pressed="isLight"
            :aria-label="isLight ? 'Switch to dark theme' : 'Switch to light theme'"
            title="Toggle light / dark theme"
            @click="toggle"
          >
            <span class="theme-toggle-icon" aria-hidden="true">
              <svg
                class="theme-toggle-svg theme-toggle-svg--sun"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
              <svg
                class="theme-toggle-svg theme-toggle-svg--moon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            </span>
          </button>

          <a
            class="repo-link"
            href="https://github.com/Bluetalk/bluetalk"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>
      </div>
    </header>
  </div>
</template>
