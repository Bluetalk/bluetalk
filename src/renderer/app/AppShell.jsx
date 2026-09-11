// Haupt-Renderbaum (Router, Routen, Modals), ausgelagert aus App.jsx.
// Reine Präsentations-Hülle: sämtlicher State kommt per Props aus App().
import React, { lazy, Suspense } from 'react';
import { HashRouter, Navigate, Routes, Route } from 'react-router-dom';

import ChatsPage from '../pages/Chats';
import SettingsLayout from '../pages/Settings';
import AccountSettingsPage from '../pages/settings/AccountSettings';
import ConnectionSettingsPage from '../pages/settings/ConnectionSettings';
import UpdatesSettingsPage from '../pages/settings/UpdatesSettings';
import ApplicationSettingsPage from '../pages/settings/ApplicationSettings';
import StickersSettingsPage from '../pages/settings/StickersSettings';
import AiSettingsPage from '../pages/settings/AiSettings';
import NewConnectionsPage from '../pages/NewConnections';
import CloudSyncPage from '../pages/CloudSync';
import LibraryPage from '../pages/Library';
import GamesPage from '../pages/Games';
import NotFoundPage from '../pages/NotFound';
import PluginsPage from '../pages/Plugins';
import ErrorBoundary from '../components/ErrorBoundary';
import { ToastProvider } from '../components/ToastProvider';
import PluginScreenHost from '../plugins/PluginScreenHost';
import VersionWelcomeModal from '../components/VersionWelcomeModal';
import UsernameOnboardingModal from '../components/UsernameOnboardingModal';
import TitleBar from './TitleBar';
import Sidebar from './Sidebar';
import { InboundToastBridge, PluginRuntimeToastBridge } from './bridges';

const PluginTabView = lazy(() => import('../plugins/PluginTabView'));

function ContentFallback() {
  return (
    <div className="page page-loading" role="status" aria-label="Wird geladen">
      <span className="spinner spinner--md" />
    </div>
  );
}

export default function AppShell({
  inboundToastRef,
  showUsernameOnboarding,
  completeUsernameOnboarding,
  versionWelcomeNotes,
  showVersionWelcome,
  dismissVersionWelcome,
  loadError,
  setLoadError,
}) {
  return (
    <ToastProvider solidBottomRight>
      <ErrorBoundary>
        <HashRouter>
          <InboundToastBridge toastRef={inboundToastRef} />
          <PluginRuntimeToastBridge />
          <Routes>
            <Route
              path="*"
              element={(
          <div className="app">
            <UsernameOnboardingModal
              open={showUsernameOnboarding}
              onSubmit={completeUsernameOnboarding}
            />
            <VersionWelcomeModal
              open={Boolean(versionWelcomeNotes && showVersionWelcome)}
              title={versionWelcomeNotes?.title}
              items={versionWelcomeNotes?.items}
              onContinue={dismissVersionWelcome}
            />
            <TitleBar />
            {loadError ? (
              <div className="app-banner app-banner--error" role="alert">
                <span>{loadError}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLoadError('')}>
                  Dismiss
                </button>
              </div>
            ) : null}
            <div className="app-body">
              <Sidebar />
              <div className="content-frame">
                <main className="content">
                  <Suspense fallback={<ContentFallback />}>
                  <Routes>
                  <Route path="/" element={<ChatsPage />} />
                  <Route path="/new" element={<NewConnectionsPage />} />
                  <Route path="/library" element={<LibraryPage />} />
                  <Route path="/games" element={<GamesPage />} />
                  <Route path="/settings" element={<SettingsLayout />}>
                    <Route index element={<Navigate to="account" replace />} />
                    <Route path="account" element={<AccountSettingsPage />} />
                    <Route path="application" element={<ApplicationSettingsPage />} />
                    <Route path="connection" element={<ConnectionSettingsPage />} />
                    <Route path="ai" element={<AiSettingsPage />} />
                    <Route path="stickers" element={<StickersSettingsPage />} />
                    <Route path="updates" element={<UpdatesSettingsPage />} />
                  </Route>
                  <Route path="/cloud-sync" element={<CloudSyncPage />} />
                  <Route path="/plugins" element={<PluginsPage />} />
                  <Route path="/plugin/:tabId" element={<PluginTabView />} />
                  <Route path="*" element={<NotFoundPage />} />
                  </Routes>
                  </Suspense>
                </main>
                <div id="shell-profile-slot" className="shell-profile-slot" />
              </div>
            </div>
            <PluginScreenHost />
          </div>
              )}
            />
          </Routes>
        </HashRouter>
      </ErrorBoundary>
    </ToastProvider>
  );
}
