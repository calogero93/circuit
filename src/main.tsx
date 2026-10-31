import { createRoot } from 'react-dom/client';
import { registerLibrary } from './library/index.ts';
import { App } from './components/App.tsx';
import { simController } from './viz/controller.ts';
import { applyScenario, scenarioFromHash } from './scenarios/scenario.ts';
import { connectToolBridge } from './ai/toolBridge.ts';
import { useStudio } from './store/studio.ts';
import './styles.css';

registerLibrary();

// Espone i tool a un client esterno (es. multiagente Python) via WebSocket.
// Usa il proxy /tool-bridge; VITE_TOOL_BRIDGE_URL può sovrascrivere l'URL:
// window.__circuitStudio.connectToolBridge('ws://localhost:8787')
connectToolBridge();
(window as any).__circuitStudio = { ...(window as any).__circuitStudio, connectToolBridge };

// scenario condiviso via link (#s=...)
try {
  const shared = scenarioFromHash();
  if (shared && !applyScenario(shared, alert)) useStudio.getState().setRunning(false);
} catch (error) {
  useStudio.getState().setRunning(false);
  alert(error instanceof Error ? error.message : 'Scenario condiviso non valido');
}

simController.start();

createRoot(document.getElementById('root')!).render(<App />);
