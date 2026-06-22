import React from 'react';
import { useApp } from '../App';
import { getEffectiveFlag } from '../featureFlags';
import SettingsHub from './settings/SettingsHub';
import SettingsLegacy from './settings/SettingsLegacy';

export default function SettingsPage() {
  const { settings } = useApp();
  const settingsHub = getEffectiveFlag(settings, 'settingsHub');

  if (settingsHub) {
    return <SettingsHub />;
  }

  return <SettingsLegacy />;
}
