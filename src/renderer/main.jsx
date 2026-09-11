import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import '../bridge/bluetalkBridge.js';
import './styles/global.css';
import App from './App';

const GAME_WINDOW_ROUTES = new Set([
  '/poker-game',
  '/uno-game',
  '/connect-four-game',
  '/chess-game',
  '/tic-tac-toe-game',
]);

// Natives WebView2-Rechtsklickmenü überall unterdrücken. Eigene Kontextmenüs
// öffnen über React-Handler und sind von preventDefault nicht betroffen.
window.addEventListener('contextmenu', (event) => event.preventDefault());

const hashPath = window.location.hash.slice(1).split(/[?#]/, 1)[0] || '/';
const isGameWindow = GAME_WINDOW_ROUTES.has(hashPath);
const GameWindowApp = lazy(() => import('./GameWindowApp'));

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isGameWindow ? (
      <Suspense fallback={<main className="page"><div className="page-body">BlueTalk wird geladen…</div></main>}>
        <GameWindowApp />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>
);
