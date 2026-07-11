import { useCallback, useEffect, useState } from 'react';

/**
 * Ollama-Zustand (Setup, Modellstufe, Cloud-Modell) inkl. Auswahl-Aktionen.
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert.
 */
export function useOllamaAi(toast) {
  const [ollamaState, setOllamaState] = useState(null);

  useEffect(() => {
    if (!window.bluetalk?.ollama) return undefined;

    let mounted = true;
    let unsubscribe = null;

    const loadOllama = async () => {
      const state = await window.bluetalk.ollama.getState();
      if (mounted) setOllamaState(state);
      unsubscribe = window.bluetalk.on('ollama:state', (nextState) => {
        if (mounted) setOllamaState(nextState);
      });
    };

    loadOllama();

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  const refreshOllamaState = useCallback(async () => {
    if (!window.bluetalk?.ollama) return;
    const state = await window.bluetalk.ollama.getState();
    setOllamaState(state);
  }, []);

  const selectAiModelTier = useCallback(async (tierId) => {
    if (!window.bluetalk?.ollama?.selectModelTier) return;
    const result = await window.bluetalk.ollama.selectModelTier(tierId);
    if (result?.ok === false) {
      toast({
        variant: 'error',
        title: 'Modellwechsel fehlgeschlagen',
        message: result.error === 'cloud_auth_required'
          ? 'Melde dich zuerst bei Ollama Cloud in den Einstellungen an.'
          : (result.error || 'Das Modell konnte nicht gewechselt werden.'),
      });
    }
    await refreshOllamaState();
  }, [refreshOllamaState, toast]);

  const selectAiCloudModel = useCallback(async (cloudModelId) => {
    if (!window.bluetalk?.ollama?.selectCloudModel || !window.bluetalk?.ollama?.selectModelTier) return;
    const cloudResult = await window.bluetalk.ollama.selectCloudModel(cloudModelId);
    if (cloudResult?.ok === false) {
      toast({
        variant: 'error',
        title: 'Cloud-Modell fehlgeschlagen',
        message: cloudResult.error || 'Das Cloud-Modell konnte nicht gewählt werden.',
      });
      await refreshOllamaState();
      return;
    }
    const tierResult = await window.bluetalk.ollama.selectModelTier('cloud');
    if (tierResult?.ok === false) {
      toast({
        variant: 'error',
        title: 'Modellwechsel fehlgeschlagen',
        message: tierResult.error === 'cloud_auth_required'
          ? 'Melde dich zuerst bei Ollama Cloud in den Einstellungen an.'
          : (tierResult.error || 'Cloud konnte nicht aktiviert werden.'),
      });
    }
    await refreshOllamaState();
  }, [refreshOllamaState, toast]);

  return { ollamaState, selectAiModelTier, selectAiCloudModel };
}
