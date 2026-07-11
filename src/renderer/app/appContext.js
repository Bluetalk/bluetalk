// App-weite React-Contexts, ausgelagert aus App.jsx.
// App.jsx re-exportiert useApp/useAiProgress, damit bestehende Importe
// aus '../App' unverändert funktionieren.
import { createContext, useContext } from 'react';

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

// The AI streaming progress updates ~60x/second. Keeping it in its own context
// means only components that actually render live AI output re-render during a
// stream — the sidebar, chat list, and other pages stay untouched.
export const AiProgressContext = createContext(null);
export const useAiProgress = () => useContext(AiProgressContext);
