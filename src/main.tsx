import { createRoot } from 'react-dom/client';
import { registerLibrary } from './library/index.ts';
import { App } from './components/App.tsx';
import { simController } from './viz/controller.ts';
import { applyScenario, scenarioFromHash } from './scenarios/scenario.ts';
import { connectToolBridge } from './ai/toolBridge.ts';
import './styles.css';

registerLibrary();

// Espone i tool a un client esterno (es. multiagente Python) via WebSocket.
// Si attiva solo se VITE_TOOL_BRIDGE_URL è definito; oppure a mano dalla console:
// window.__circuitStudio.connectToolBridge('ws://localhost:8787')
connectToolBridge();
(window as any).__circuitStudio = { ...(window as any).__circuitStudio, connectToolBridge };

// scenario condiviso via link (#s=...)
const shared = scenarioFromHash();
if (shared) applyScenario(shared);

simController.start();

createRoot(document.getElementById('root')!).render(<App />);
