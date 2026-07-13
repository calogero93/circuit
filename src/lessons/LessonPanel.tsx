// Pannello lezioni: elenco, avanzamento a passi (riproducibile davanti a un
// pubblico), carica-circuito, scorciatoia per il punto di confronto A/B.

import { replaceCircuit } from '../store/commands.ts';
import { PROBE_COLORS, useStudio } from '../store/studio.ts';
import { LESSONS, getLesson, type Lesson } from './data.ts';

export function loadLesson(lesson: Lesson): void {
  const s = useStudio.getState();
  s.execute(replaceCircuit(`lezione: ${lesson.title}`, s.circuit, lesson.circuit));
  s.setProbes(
    lesson.probes.map((p, i) => ({
      id: `lesson-probe-${i}`,
      pin: p.pin,
      color: PROBE_COLORS[i % PROBE_COLORS.length],
      label: p.label,
    })),
  );
  s.setScopeTimespan(lesson.scopeTimespan);
  s.setTimestep(lesson.timestep);
  s.setAB(lesson.ab ? { componentId: lesson.ab.componentId, mode: lesson.ab.mode } : null);
  s.setABGhost(false);
  s.setLesson(lesson.id, 0);
  s.setSelection([]);
  s.setRunning(true);
}

export function LessonPanel() {
  const lessonId = useStudio((s) => s.lessonId);
  const step = useStudio((s) => s.lessonStep);
  const setLesson = useStudio((s) => s.setLesson);
  const setLessonStep = useStudio((s) => s.setLessonStep);
  const abGhost = useStudio((s) => s.abGhost);
  const setABGhost = useStudio((s) => s.setABGhost);
  const presentation = useStudio((s) => s.presentation);

  const lesson = lessonId ? getLesson(lessonId) : null;

  if (!lesson) {
    return (
      <div className="lesson-list">
        <p className="muted">
          Ogni lezione ruota attorno al ruolo di UN componente: lo togli, lo rimetti, e vedi la differenza.
        </p>
        {LESSONS.map((l) => (
          <div key={l.id} className="lesson-card">
            <h4>{l.title}</h4>
            <p>{l.objective}</p>
            <button className="btn primary" onClick={() => loadLesson(l)}>
              Inizia
            </button>
          </div>
        ))}
      </div>
    );
  }

  const current = lesson.steps[Math.min(step, lesson.steps.length - 1)];

  return (
    <div className={`lesson-active${presentation ? ' big' : ''}`}>
      <div className="lesson-head">
        <h3>{lesson.title}</h3>
        {!presentation && (
          <button className="btn small" onClick={() => setLesson(null)}>
            ✕ esci
          </button>
        )}
      </div>
      {step === 0 && (
        <>
          <p className="lesson-objective">{lesson.objective}</p>
          <p className="lesson-why">
            <b>Perché:</b> {lesson.why}
          </p>
        </>
      )}
      <div className="lesson-step">
        <div className="lesson-step-head">
          <span className="step-count">
            passo {step + 1} / {lesson.steps.length}
          </span>
          <h4>{current.title}</h4>
        </div>
        <p>{current.text}</p>
      </div>
      <div className="lesson-nav">
        <button className="btn" disabled={step === 0} onClick={() => setLessonStep(step - 1)}>
          ← precedente
        </button>
        <button
          className="btn primary"
          disabled={step >= lesson.steps.length - 1}
          onClick={() => setLessonStep(step + 1)}
        >
          successivo →
        </button>
      </div>
      <div className="lesson-tools">
        {lesson.ab && (
          <button className={`btn${abGhost ? ' on' : ''}`} onClick={() => setABGhost(!abGhost)}>
            {abGhost ? '▣ A/B attivo' : `▣ A/B: ${lesson.ab.label}`}
          </button>
        )}
        <button className="btn" onClick={() => loadLesson(lesson)}>
          ↺ ricarica circuito
        </button>
      </div>
    </div>
  );
}
