import React, { lazy, Suspense } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';

const PokerGamePage = lazy(() => import('./pages/PokerGamePage'));
const UnoGamePage = lazy(() => import('./pages/UnoGamePage'));
const ConnectFourGamePage = lazy(() => import('./pages/ConnectFourGamePage'));
const ChessGamePage = lazy(() => import('./pages/ChessGamePage'));
const TicTacToeGamePage = lazy(() => import('./pages/TicTacToeGamePage'));
const RacingGamePage = lazy(() => import('./pages/RacingGamePage'));

function GameWindowFallback() {
  return (
    <main className="page">
      <div className="page-body">Spiel wird geladen…</div>
    </main>
  );
}

export default function GameWindowApp() {
  return (
    <ErrorBoundary showHomeAction={false}>
      <HashRouter>
        <Suspense fallback={<GameWindowFallback />}>
          <Routes>
            <Route path="/poker-game" element={<PokerGamePage />} />
            <Route path="/uno-game" element={<UnoGamePage />} />
            <Route path="/connect-four-game" element={<ConnectFourGamePage />} />
            <Route path="/chess-game" element={<ChessGamePage />} />
            <Route path="/tic-tac-toe-game" element={<TicTacToeGamePage />} />
            <Route path="/racing-game" element={<RacingGamePage />} />
            <Route path="*" element={<GameWindowFallback />} />
          </Routes>
        </Suspense>
      </HashRouter>
    </ErrorBoundary>
  );
}
