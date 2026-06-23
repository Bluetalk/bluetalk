<template>
  <footer class="site-footer">
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand-block">
          <div class="footer-brand">
            <span class="brand-orb" />
            <span>BlueTalk</span>
          </div>
          <p class="footer-tagline">
            Peer-to-peer messaging built for silence. No servers, no accounts, no traces.
          </p>
        </div>

        <div class="footer-col">
          <h4 class="footer-col-title">Product</h4>
          <div class="footer-links">
            <NuxtLink to="/features">Features</NuxtLink>
            <NuxtLink to="/download">Download</NuxtLink>
            <a href="https://github.com/Bluetalk/bluetalk/releases" target="_blank" rel="noreferrer">
              Releases
            </a>
          </div>
        </div>

        <div class="footer-col">
          <h4 class="footer-col-title">Project</h4>
          <div class="footer-links">
            <a href="https://github.com/Bluetalk/bluetalk" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="https://github.com/Bluetalk/bluetalk/issues" target="_blank" rel="noreferrer">
              Issues
            </a>
          </div>
        </div>
      </div>

      <div class="footer-bottom">
        <span class="footer-copy">© {{ new Date().getFullYear() }} BlueTalk. Open source.</span>
        <span class="footer-badge">Windows · P2P · E2E</span>
      </div>
    </div>
  </footer>
</template>
