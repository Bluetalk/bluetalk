import { Bot, Network, SlidersHorizontal, Smile, User } from 'lucide-react';

export const SETTINGS_NAV = [
  { to: '/settings/account', icon: User, title: 'Profil' },
  { to: '/settings/application', icon: SlidersHorizontal, title: 'App' },
  { to: '/settings/connection', icon: Network, title: 'Netzwerk', desktopOnly: true },
  { to: '/settings/ai', icon: Bot, title: 'Bots · Eingestellt', desktopOnly: true },
  { to: '/settings/stickers', icon: Smile, title: 'Sticker' },
];
