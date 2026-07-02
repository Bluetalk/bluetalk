import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import './styles/global.css';

const GAME_WINDOW_ROUTES = new Set([
  '/poker-game',
  '/uno-game',
  '/connect-four-game',
  '/chess-game',
  '/tic-tac-toe-game',
  '/racing-game',
  '/docs-editor',
]);

const hashPath = window.location.hash.slice(1).split(/[?#]/, 1)[0] || '/';
const RootApp = React.lazy(() => (
  GAME_WINDOW_ROUTES.has(hashPath)
    ? import('./GameWindowApp')
    : import('./App')
));

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Suspense fallback={<main className="page"><div className="page-body">BlueTalk wird geladen…</div></main>}>
      <RootApp />
    </Suspense>
  </React.StrictMode>
);
