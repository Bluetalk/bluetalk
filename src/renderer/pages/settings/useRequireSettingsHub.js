import { useApp } from '../../App';
import { getEffectiveFlag } from '../../featureFlags';

export function useRequireSettingsHub() {
  const { settings } = useApp();
  return getEffectiveFlag(settings, 'settingsHub');
}
