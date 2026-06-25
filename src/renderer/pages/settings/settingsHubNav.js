import { ArrowUpCircle, Blocks, Bot, Plug, Server, Smile, User } from 'lucide-react';

export const SETTINGS_HUB_NAV = [
  {
    to: '/settings/account',
    icon: User,
    title: 'Account',
    subtitle: 'Profile, identity, and local data',
  },
  {
    to: '/settings/connection',
    icon: Plug,
    title: 'Connection',
    subtitle: 'Peers, network, and ports',
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
    to: '/settings/updates',
    icon: ArrowUpCircle,
    title: 'Updates',
    subtitle: 'Automatic checks, downloads, and installs',
  },
  {
    to: '/settings/application',
    icon: Server,
    title: 'Application',
    subtitle: 'Notifications, theme, startup, and debug',
  },
];
