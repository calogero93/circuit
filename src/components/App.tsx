// Guscio UI: toolbar, palette a sinistra, canvas + oscilloscopio al centro,
// pannelli a destra (Proprietà / Matematica / Lezione / Tutor AI).
// In modalità presentazione la UI si riduce e la tipografia cresce.

import { lazy, Suspense, useEffect } from 'react';
import { CanvasEditor } from '../editor/CanvasEditor.tsx';
import { Palette } from '../editor/Palette.tsx';
import { PropertiesPanel } from '../editor/PropertiesPanel.tsx';
import { MathPanel } from '../math/MathPanel.tsx';
import { LessonPanel } from '../lessons/LessonPanel.tsx';
import { getLesson } from '../lessons/data.ts';
import { TutorPanel } from '../ai/TutorPanel.tsx';
import { ScenarioPanel } from '../scenarios/ScenarioPanel.tsx';
import { LogicPanel } from '../editor/LogicPanel.tsx';

// three.js caricato solo all'apertura del pannello 3D (chunk separato)
const Panel3D = lazy(() => import('../viz3d/Panel3D.tsx'));
import { Scope } from '../viz/Scope.tsx';
import { addItems, removeItems, rotateComponent } from '../store/commands.ts';
import { GRID } from '../editor/geometry.ts';
import { freshId, type ComponentInstance, type Wire } from '../model/types.ts';
import { getDef } from '../model/registry.ts';
import { useStudio, type RightTab } from '../store/studio.ts';
import { Toolbar } from './Toolbar.tsx';

let clipboard: { comps: ComponentInstance[]; wires: Wire[] } | null = null;

/** Duplica componenti + fili interni con id nuovi e offset, e li seleziona. */
function duplicateInto(s: ReturnType<typeof useStudio.getState>, comps: ComponentInstance[], wires: Wire[]): void {
  if (!comps.length) return;
  const off = GRID * 2;
  const idMap: Record<string, string> = {};
  const takenC = (id: string) => s.circuit.components.some((c) => c.id === id) || Object.values(idMap).includes(id);
  const newComps = comps.map((c) => {
    const prefix = c.id.match(/^[A-Za-z]+/)?.[0] ?? 'U';
    const nid = freshId(prefix, takenC);
    idMap[c.id] = nid;
    return { ...c, id: nid, x: c.x + off, y: c.y + off, params: { ...c.params } };
  });
  const takenW = (id: string) => s.circuit.wires.some((w) => w.id === id);
  const newWires: Wire[] = wires.map((w) => ({
    ...w,
    id: freshId('w', takenW),
    from: { component: idMap[w.from.component], pin: w.from.pin },
    to: { component: idMap[w.to.component], pin: w.to.pin },
    route: w.route?.map((p) => ({ x: p.x + off, y: p.y + off })),
  }));
  s.execute(addItems(newComps, newWires));
  s.setSelection(newComps.map((c) => c.id));
}

/** Componenti selezionati + fili con entrambi i capi nella selezione. */
function selectedItems(s: ReturnType<typeof useStudio.getState>): { comps: ComponentInstance[]; wires: Wire[] } {
  const ids = new Set(s.selection);
  const comps = s.circuit.components.filter((c) => ids.has(c.id));
  const compIds = new Set(comps.map((c) => c.id));
  const wires = s.circuit.wires.filter((w) => compIds.has(w.from.component) && compIds.has(w.to.component));
  return { comps, wires };
}

const TABS: { key: RightTab; label: string }[] = [
  { key: 'props', label: 'Proprietà' },
  { key: 'math', label: 'Matematica' },
  { key: 'lesson', label: 'Lezioni' },
  { key: 'logica', label: 'Logica' },
  { key: '3d', label: '3D' },
  { key: 'scenari', label: 'Scenari' },
  { key: 'ai', label: 'Tutor AI' },
];

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStudio.getState();
      const inField =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement ||
        document.activeElement instanceof HTMLSelectElement;
      if (inField) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        const { comps, wires } = selectedItems(s);
        if (comps.length) {
          clipboard = {
            comps: comps.map((c) => ({ ...c, params: { ...c.params } })),
            wires: wires.map((w) => ({ ...w, route: w.route?.map((p) => ({ ...p })) })),
          };
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        if (!clipboard) return;
        e.preventDefault();
        duplicateInto(s, clipboard.comps, clipboard.wires);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const { comps, wires } = selectedItems(s);
        duplicateInto(s, comps, wires);
        return;
      }
      switch (e.key) {
        case 'Escape':
          s.setTool({ kind: 'select' });
          break;
        case 'w':
          s.setTool({ kind: 'wire', from: null });
          break;
        case 'p':
          s.setTool({ kind: 'probe' });
          break;
        case 'r': {
          if (s.tool.kind === 'place') {
            s.setTool({ ...s.tool, rot: ((s.tool.rot + 1) % 4) as 0 | 1 | 2 | 3 });
            break;
          }
          const inst = s.circuit.components.find((c) => s.selection.includes(c.id));
          if (inst) s.execute(rotateComponent(inst.id, inst.rot, ((inst.rot + 1) % 4) as 0 | 1 | 2 | 3));
          break;
        }
        case 'a': {
          // confronto A/B in un gesto sul componente selezionato
          if (e.ctrlKey || e.metaKey) break;
          const inst = s.circuit.components.find((c) => s.selection.includes(c.id));
          if (!inst) break;
          const def = getDef(inst.type);
          if (def.isGround || def.pins.length < 2) break;
          const active = s.ab?.componentId === inst.id && s.abGhost;
          if (active) {
            s.setAB(null);
            s.setABGhost(false);
          } else {
            s.setAB({ componentId: inst.id, mode: 'remove' });
            s.setABGhost(true);
          }
          break;
        }
        case 'Delete':
        case 'Backspace':
          if (s.selection.length) s.execute(removeItems(s.circuit, s.selection));
          break;
        case 'ArrowRight': {
          const lesson = s.lessonId ? getLesson(s.lessonId) : null;
          if (lesson && s.lessonStep < lesson.steps.length - 1) s.setLessonStep(s.lessonStep + 1);
          break;
        }
        case 'ArrowLeft':
          if (s.lessonId && s.lessonStep > 0) s.setLessonStep(s.lessonStep - 1);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const rightTab = useStudio((s) => s.rightTab);
  const setRightTab = useStudio((s) => s.setRightTab);
  const presentation = useStudio((s) => s.presentation);
  const lessonId = useStudio((s) => s.lessonId);
  const lesson = lessonId ? getLesson(lessonId) : null;
  useKeyboard();

  return (
    <div className={`app${presentation ? ' presentation' : ''}`}>
      <Toolbar />
      <div className="main">
        <aside className="left">
          <Palette />
        </aside>
        <section className="center">
          <CanvasEditor />
          <Scope markers={lesson?.markers ?? []} />
        </section>
        <aside className="right">
          <nav className="tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`tab${rightTab === t.key ? ' on' : ''}`}
                onClick={() => setRightTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {rightTab === 'props' && <PropertiesPanel />}
            {rightTab === 'math' && <MathPanel />}
            {rightTab === 'lesson' && <LessonPanel />}
            {rightTab === 'logica' && <LogicPanel />}
            {rightTab === '3d' && (
              <Suspense fallback={<p className="muted">Carico il visore 3D…</p>}>
                <Panel3D />
              </Suspense>
            )}
            {rightTab === 'scenari' && <ScenarioPanel />}
            {rightTab === 'ai' && <TutorPanel />}
          </div>
        </aside>
      </div>
      {presentation && (
        <div className="presentation-lesson">
          <LessonPanel />
        </div>
      )}
    </div>
  );
}
