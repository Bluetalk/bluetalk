// Haupt-Renderbaum (Router, Routen, Modals), ausgelagert aus App.jsx.
// Reine Präsentations-Hülle: sämtlicher State kommt per Props aus App().
import React, { lazy, Suspense } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';

import ChatsPage from '../pages/Chats';
import ErrorBoundary from '../components/ErrorBoundary';
import { ToastProvider } from '../components/ToastProvider';
import PluginScreenHost from '../plugins/PluginScreenHost';
import VersionWelcomeModal from '../components/VersionWelcomeModal';
import UsernameOnboardingModal from '../components/UsernameOnboardingModal';
import AgentAskUserModal from '../components/AgentAskUserModal';
import TitleBar from './TitleBar';
import Sidebar from './Sidebar';
import { InboundToastBridge, PluginRuntimeToastBridge } from './bridges';

const SettingsPage = lazy(() => import('../pages/Settings'));
const AccountSettingsPage = lazy(() => import('../pages/settings/AccountSettings'));
const ConnectionSettingsPage = lazy(() => import('../pages/settings/ConnectionSettings'));
const UpdatesSettingsPage = lazy(() => import('../pages/settings/UpdatesSettings'));
const ApplicationSettingsPage = lazy(() => import('../pages/settings/ApplicationSettings'));
const StickersSettingsPage = lazy(() => import('../pages/settings/StickersSettings'));
const AiSettingsPage = lazy(() => import('../pages/settings/AiSettings'));
const NewConnectionsPage = lazy(() => import('../pages/NewConnections'));
const CloudSyncPage = lazy(() => import('../pages/CloudSync'));
const LibraryPage = lazy(() => import('../pages/Library'));
const GamesPage = lazy(() => import('../pages/Games'));
const DocumentsLauncherPage = lazy(() => import('../pages/DocumentsLauncher'));
const NotFoundPage = lazy(() => import('../pages/NotFound'));
const PluginsPage = lazy(() => import('../pages/Plugins'));
const PluginTabView = lazy(() => import('../plugins/PluginTabView'));
const DocsPage = lazy(() => import('../docs/DocsPage'));

export default function AppShell({
  inboundToastRef,
  showUsernameOnboarding,
  completeUsernameOnboarding,
  versionWelcomeNotes,
  showVersionWelcome,
  dismissVersionWelcome,
  loadError,
  setLoadError,
  agentAskUser,
  setAgentAskUser,
}) {
  return (
    <ToastProvider solidBottomRight>
      <ErrorBoundary>
          <HashRouter>
          <InboundToastBridge toastRef={inboundToastRef} />
          <PluginRuntimeToastBridge />
          <Suspense fallback={<div className="page"><div className="page-body">Wird geladen…</div></div>}>
          <Routes>
            <Route path="/docs/*" element={<DocsPage />} />
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
              <main className="content">
                <Routes>
                  <Route path="/" element={<ChatsPage />} />
                  <Route path="/new" element={<NewConnectionsPage />} />
                  <Route path="/library" element={<LibraryPage />} />
                  <Route path="/documents" element={<DocumentsLauncherPage />} />
                  <Route path="/games" element={<GamesPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/settings/account" element={<AccountSettingsPage />} />
                  <Route path="/settings/connection" element={<ConnectionSettingsPage />} />
                  <Route path="/settings/updates" element={<UpdatesSettingsPage />} />
                  <Route path="/settings/application" element={<ApplicationSettingsPage />} />
                  <Route path="/settings/stickers" element={<StickersSettingsPage />} />
                  <Route path="/settings/ai" element={<AiSettingsPage />} />
                  <Route path="/cloud-sync" element={<CloudSyncPage />} />
                  <Route path="/plugins" element={<PluginsPage />} />
                  <Route path="/plugin/:tabId" element={<PluginTabView />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </main>
            </div>
            <PluginScreenHost />
            <AgentAskUserModal
              open={Boolean(agentAskUser)}
              question={agentAskUser?.question}
              onSubmit={(answer) => {
                const rid = agentAskUser?.requestId;
                if (rid) window.bluetalk?.ollama?.replyAskUser?.(rid, answer);
                setAgentAskUser(null);
              }}
              onCancel={() => {
                const rid = agentAskUser?.requestId;
                if (rid) window.bluetalk?.ollama?.replyAskUser?.(rid, '');
                setAgentAskUser(null);
              }}
            />
          </div>
              )}
            />
          </Routes>
          </Suspense>
        </HashRouter>
      </ErrorBoundary>
    </ToastProvider>
  );
}
