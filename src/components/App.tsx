// Guscio UI: toolbar, palette a sinistra, canvas + oscilloscopio al centro,
// pannelli a destra (Proprietà / Matematica / Lezione / Tutor AI).
// In modalità presentazione la UI si riduce e la tipografia cresce.

import { useEffect } from 'react';
import { CanvasEditor } from '../editor/CanvasEditor.tsx';
import { Palette } from '../editor/Palette.tsx';
import { PropertiesPanel } from '../editor/PropertiesPanel.tsx';
import { MathPanel } from '../math/MathPanel.tsx';
import { LessonPanel } from '../lessons/LessonPanel.tsx';
import { getLesson } from '../lessons/data.ts';
import { TutorPanel } from '../ai/TutorPanel.tsx';
import { Scope } from '../viz/Scope.tsx';
import { removeItems, rotateComponent } from '../store/commands.ts';
import { useStudio, type RightTab } from '../store/studio.ts';
import { Toolbar } from './Toolbar.tsx';

const TABS: { key: RightTab; label: string }[] = [
  { key: 'props', label: 'Proprietà' },
  { key: 'math', label: 'Matematica' },
  { key: 'lesson', label: 'Lezioni' },
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
