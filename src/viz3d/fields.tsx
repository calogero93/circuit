// Campi 3D (M2): overlay del campo caratteristico del componente selezionato,
// animati e guidati dai dati vivi di simulazione — la causa-effetto resa fisica.
//   • flusso di corrente: particelle lungo l'asse, verso ∝ segno(I), velocità ∝ |I|
//   • campo magnetico (induttore): spire con particelle circolanti ∝ I
//   • campo elettrico (condensatore): frecce fra le armature ∝ V (verso + → −)

import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import type { ComponentInstance } from '../model/types.ts';
import type { DeviceOutputs } from '../model/device.ts';

function CurrentFlow({ current }: { current: number }) {
  const g = useRef<THREE.Group>(null);
  const phase = useRef(0);
  const N = 9;
  const L = 3.2;
  const spacing = L / N;
  useFrame((_, dt) => {
    if (!g.current) return;
    const speed = Math.sign(current) * (0.4 + Math.min(3, Math.abs(current) * 50));
    phase.current += speed * dt;
    g.current.children.forEach((c, i) => {
      // offset dall'asse: fuori dal corpo opaco, così il flusso è visibile
      c.position.set(0.72, ((((i * spacing + phase.current) % L) + L) % L) - L / 2, 0);
    });
  });
  if (Math.abs(current) < 1e-9) return null;
  const lit = 0.5 + Math.min(1, Math.abs(current) / 0.02);
  return (
    <group ref={g}>
      {Array.from({ length: N }).map((_, i) => (
        <mesh key={i} position={[0.72, 0, 0]}>
          <sphereGeometry args={[0.1, 8, 8]} />
          <meshStandardMaterial color="#ffd166" emissive="#ffd166" emissiveIntensity={lit} />
        </mesh>
      ))}
    </group>
  );
}

function BField({ current }: { current: number }) {
  const parts = useRef<THREE.Mesh[]>([]);
  const ang = useRef(0);
  const mag = Math.min(1, Math.abs(current) / 0.01);
  const ys = [-1, 0, 1];
  useFrame((_, dt) => {
    ang.current += Math.sign(current) * (0.5 + mag * 4) * dt;
    parts.current.forEach((m, i) => {
      if (!m) return;
      const a = ang.current + i * ((Math.PI * 2) / 3);
      m.position.set(Math.cos(a) * 0.95, ys[i], Math.sin(a) * 0.95);
    });
  });
  if (Math.abs(current) < 1e-9) return null;
  return (
    <group>
      {ys.map((y, i) => (
        <mesh key={i} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.95, 0.02, 8, 44]} />
          <meshStandardMaterial color="#4aa3ff" emissive="#4aa3ff" emissiveIntensity={0.3 + mag} transparent opacity={0.35 + 0.5 * mag} />
        </mesh>
      ))}
      {ys.map((_, i) => (
        <mesh key={i} ref={(el) => { if (el) parts.current[i] = el; }}>
          <sphereGeometry args={[0.08, 8, 8]} />
          <meshStandardMaterial color="#a8d5ff" emissive="#a8d5ff" emissiveIntensity={1} />
        </mesh>
      ))}
    </group>
  );
}

function EField({ voltage }: { voltage: number }) {
  const mag = Math.min(1, Math.abs(voltage) / 5);
  if (Math.abs(voltage) < 1e-6) return null;
  const flip = voltage < 0 ? Math.PI : 0; // V<0 inverte il verso del campo
  return (
    <group>
      {[-0.32, 0, 0.32].map((x, i) => (
        <group key={i} position={[x, 0, 0]} rotation={[flip, 0, 0]}>
          <mesh>
            <cylinderGeometry args={[0.022, 0.022, 0.7, 6]} />
            <meshStandardMaterial color="#ff7be5" emissive="#ff7be5" emissiveIntensity={0.4 + mag} transparent opacity={0.45 + 0.55 * mag} />
          </mesh>
          <mesh position={[0, -0.42, 0]} rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[0.09, 0.2, 10]} />
            <meshStandardMaterial color="#ff7be5" emissive="#ff7be5" emissiveIntensity={0.4 + mag} transparent opacity={0.45 + 0.55 * mag} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

const HORIZONTAL = new Set(['resistor', 'diode', 'zener', 'schottky']);

/** Sceglie e orienta i campi per il tipo di componente, dai dati vivi. */
export function FieldOverlay({ inst, outputs, show }: { inst: ComponentInstance; outputs?: DeviceOutputs; show: boolean }) {
  if (!show || !outputs) return null;
  const current = outputs.pinCurrents?.[0] ?? Number(outputs.data?.i ?? outputs.data?.id ?? 0);
  const voltage = Number(outputs.data?.v ?? outputs.data?.vd ?? 0);
  const flow = HORIZONTAL.has(inst.type) ? (
    <group rotation={[0, 0, Math.PI / 2]}>
      <CurrentFlow current={current} />
    </group>
  ) : (
    <CurrentFlow current={current} />
  );

  switch (inst.type) {
    case 'inductor':
      return (
        <>
          {flow}
          <BField current={current} />
        </>
      );
    case 'capacitor':
      return (
        <>
          {flow}
          <EField voltage={voltage} />
        </>
      );
    case 'resistor':
    case 'diode':
    case 'zener':
    case 'schottky':
    case 'led':
      return flow;
    default:
      return null;
  }
}
