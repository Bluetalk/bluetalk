import { ArrowUpCircle, Blocks, BookOpen, Bot, Plug, Server, Smile, User } from 'lucide-react';

export const SETTINGS_HUB_NAV = [
  {
    to: '/settings/account',
    icon: User,
    title: 'Konto',
    subtitle: 'Profil, Identität und lokale Daten',
  },
  {
    to: '/settings/connection',
    icon: Plug,
    title: 'Verbindung',
    subtitle: 'Peers, Netzwerk und Ports',
  },
  {
    to: '/settings/stickers',
    icon: Smile,
    title: 'Sticker',
    subtitle: 'Erstellen, Favoriten und Packs verwalten',
  },
  {
    to: '/settings/ai',
    icon: Bot,
    title: 'AI Chat',
    subtitle: 'Ollama, Modelle und lokale Dateien',
  },
  {
    to: '/plugins',
    icon: Blocks,
    title: 'Erweiterungen',
    subtitle: 'Spiele, Tools und Extras verwalten',
  },
  {
    to: '/docs/getting-started',
    icon: BookOpen,
    title: 'Plugin-API-Doku',
    subtitle: 'Entwicklerdokumentation für Erweiterungen',
  },
  {
    to: '/settings/updates',
    icon: ArrowUpCircle,
    title: 'Updates',
    subtitle: 'Automatische Prüfungen, Downloads und Installationen',
  },
  {
    to: '/settings/application',
    icon: Server,
    title: 'Anwendung',
    subtitle: 'Benachrichtigungen, Design, Autostart und Debug',
  },
];
