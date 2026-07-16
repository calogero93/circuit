// Visore 3D (M2, prima fetta): mostra il componente selezionato come modello
// three.js ruotabile, ancorato ai dati vivi. Caricato in lazy dal guscio UI, così
// three.js non pesa sul bundle finché non apri il pannello.

import { useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { getDef } from '../model/registry.ts';
import { useStudio } from '../store/studio.ts';
import { simController, useSimTick } from '../viz/controller.ts';
import { ComponentModel } from './models.tsx';
import { FieldOverlay } from './fields.tsx';

export default function Panel3D() {
  const selection = useStudio((s) => s.selection);
  const circuit = useStudio((s) => s.circuit);
  const [fields, setFields] = useState(true);
  useSimTick((s) => s.tick); // re-render coi valori vivi (es. LED acceso)

  const inst = circuit.components.find((c) => selection.includes(c.id));
  if (!inst) {
    return <p className="muted">Seleziona un componente sul canvas per vederlo in 3D e ruotarlo.</p>;
  }
  const def = getDef(inst.type);
  const outputs = simController.frame?.result.outputs.get(inst.id);

  return (
    <div className="panel3d">
      <div className="panel3d-head">
        <h3>
          {def.name} · <span className="mono">{inst.id}</span>
        </h3>
        <label className="field-toggle">
          <input type="checkbox" checked={fields} onChange={(e) => setFields(e.target.checked)} />
          Campi
        </label>
      </div>
      <div className="panel3d-canvas">
        <Canvas camera={{ position: [3, 2.2, 3.5], fov: 45 }} dpr={[1, 2]}>
          <color attach="background" args={['#0f1219']} />
          <ambientLight intensity={0.55} />
          <directionalLight position={[4, 6, 3]} intensity={1.2} />
          <directionalLight position={[-3, 1, -4]} intensity={0.4} />
          <ComponentModel inst={inst} outputs={outputs} />
          <FieldOverlay inst={inst} outputs={outputs} show={fields} />
          <OrbitControls enablePan={false} minDistance={2.5} maxDistance={12} autoRotate autoRotateSpeed={0.8} />
        </Canvas>
      </div>
      <p className="muted">
        Trascina per ruotare · rotellina per zoom. I campi (corrente, E, B) riflettono i valori vivi del circuito.
      </p>
    </div>
  );
}
