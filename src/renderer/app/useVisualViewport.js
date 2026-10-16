// Bindet visualViewport an CSS-Variablen, damit die App-Höhe der
// Bildschirmtastatur auf iOS Safari / Android Chrome folgt.
import { useEffect } from 'react';
import { MOBILE_MQ } from '../utils/touch.js';

function applyViewportVars() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const height = vv?.height || window.innerHeight;
  const offsetTop = vv?.offsetTop || 0;
  root.style.setProperty('--vv-height', `${Math.round(height)}px`);
  root.style.setProperty('--vv-offset-top', `${Math.round(offsetTop)}px`);
  root.style.setProperty('--sat', 'env(safe-area-inset-top, 0px)');
  root.style.setProperty('--sab', 'env(safe-area-inset-bottom, 0px)');
  root.style.setProperty('--sal', 'env(safe-area-inset-left, 0px)');
  root.style.setProperty('--sar', 'env(safe-area-inset-right, 0px)');
}

function syncMobileClass() {
  const mobile = window.matchMedia(MOBILE_MQ).matches;
  document.body.classList.toggle('bt-mobile', mobile);
  document.documentElement.classList.toggle('bt-mobile', mobile);
}

/**
 * Hält --vv-height aktuell und setzt .bt-mobile am body.
 * Auf Desktop (breites Fenster) bleibt height: 100vh aus layout.css maßgeblich.
 */
export function useVisualViewport() {
  useEffect(() => {
    applyViewportVars();
    syncMobileClass();
    const vv = window.visualViewport;
    const mq = window.matchMedia(MOBILE_MQ);
    const onResize = () => {
      applyViewportVars();
      syncMobileClass();
    };
    window.addEventListener('resize', onResize);
    mq.addEventListener('change', onResize);
    vv?.addEventListener('resize', onResize);
    vv?.addEventListener('scroll', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      mq.removeEventListener('change', onResize);
      vv?.removeEventListener('resize', onResize);
      vv?.removeEventListener('scroll', onResize);
      document.body.classList.remove('bt-mobile', 'bt-mobile-chat-open');
      document.documentElement.classList.remove('bt-mobile');
    };
  }, []);
}
