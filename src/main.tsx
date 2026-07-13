import { createRoot } from 'react-dom/client';
import { registerLibrary } from './library/index.ts';
import { App } from './components/App.tsx';
import { simController } from './viz/controller.ts';
import { applyScenario, scenarioFromHash } from './scenarios/scenario.ts';
import './styles.css';

registerLibrary();

// scenario condiviso via link (#s=...)
const shared = scenarioFromHash();
if (shared) applyScenario(shared);

simController.start();

createRoot(document.getElementById('root')!).render(<App />);
