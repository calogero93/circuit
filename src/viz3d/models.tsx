// Modelli 3D procedurali dei componenti (M2). Geometria generata da three.js
// via R3F, ancorata ai parametri e ai dati vivi di simulazione (es. il LED si
// illumina con la corrente, il resistore mostra le sue bande di colore reali).
// Nessun accesso al motore: legge solo modello + output (seam §4.3).

import { useMemo } from 'react';
import * as THREE from 'three';
import type { ComponentInstance } from '../model/types.ts';
import type { DeviceOutputs } from '../model/device.ts';

// Codice colori delle resistenze, cifre 0–9.
const DIGIT_COLORS = ['#1a1a1a', '#7a4b2b', '#e21b1b', '#f08000', '#f5d000', '#2a9d2a', '#2a5bd7', '#8a3fbf', '#9a9a9a', '#efefef'];

/** Tre bande (2 cifre significative + moltiplicatore) dal valore in ohm. */
function resistorBands(R: number): string[] {
  if (!(R > 0)) return [DIGIT_COLORS[0], DIGIT_COLORS[0], DIGIT_COLORS[0]];
  const mult = Math.floor(Math.log10(R)) - 1;
  const sig = Math.round(R / Math.pow(10, mult)); // 10..99
  return [DIGIT_COLORS[Math.floor(sig / 10) % 10], DIGIT_COLORS[sig % 10], DIGIT_COLORS[((mult % 10) + 10) % 10]];
}

const Lead = ({ y }: { y: number }) => (
  <mesh position={[0, y, 0]}>
    <cylinderGeometry args={[0.07, 0.07, 0.9, 12]} />
    <meshStandardMaterial color="#c0c4cc" metalness={0.8} roughness={0.3} />
  </mesh>
);

function Resistor({ R }: { R: number }) {
  const bands = resistorBands(R);
  return (
    <group rotation={[0, 0, Math.PI / 2]}>
      <mesh>
        <cylinderGeometry args={[0.5, 0.5, 2, 32]} />
        <meshStandardMaterial color="#d8c59a" roughness={0.6} />
      </mesh>
      {bands.map((c, i) => (
        <mesh key={i} position={[0, -0.55 + i * 0.45, 0]}>
          <cylinderGeometry args={[0.53, 0.53, 0.14, 32]} />
          <meshStandardMaterial color={c} roughness={0.5} />
        </mesh>
      ))}
      <Lead y={1.4} />
      <Lead y={-1.4} />
    </group>
  );
}

function Led({ current, color }: { current: number; color: string }) {
  const lit = Math.min(1, current / 0.02);
  return (
    <group>
      <mesh position={[0, 0.55, 0]}>
        <sphereGeometry args={[0.6, 28, 20, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={lit * 2.5} transparent opacity={0.8} roughness={0.25} />
      </mesh>
      <mesh position={[0, 0.15, 0]}>
        <cylinderGeometry args={[0.6, 0.6, 0.35, 28]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={lit * 1.2} roughness={0.35} />
      </mesh>
      {lit > 0.02 && <pointLight position={[0, 0.8, 0]} color={color} intensity={lit * 3} distance={6} />}
      <Lead y={-0.5} />
    </group>
  );
}

function Diode({ band }: { band: string }) {
  return (
    <group rotation={[0, 0, Math.PI / 2]}>
      <mesh>
        <cylinderGeometry args={[0.45, 0.45, 1.8, 32]} />
        <meshStandardMaterial color="#151515" roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.6, 0]}>
        <cylinderGeometry args={[0.47, 0.47, 0.22, 32]} />
        <meshStandardMaterial color={band} roughness={0.4} />
      </mesh>
      <Lead y={1.3} />
      <Lead y={-1.3} />
    </group>
  );
}

function Capacitor() {
  return (
    <group>
      {[0.5, -0.5].map((y) => (
        <mesh key={y} position={[0, y, 0]}>
          <boxGeometry args={[1.3, 0.09, 1.3]} />
          <meshStandardMaterial color="#c9a24a" metalness={0.7} roughness={0.3} />
        </mesh>
      ))}
      <Lead y={1.35} />
      <Lead y={-1.35} />
    </group>
  );
}

function Transistor() {
  return (
    <group>
      <mesh position={[0, 0.5, 0]} rotation={[0, 0, 0]}>
        <cylinderGeometry args={[0.7, 0.7, 1, 24, 1, false, 0, Math.PI]} />
        <meshStandardMaterial color="#232323" roughness={0.5} side={2} />
      </mesh>
      {[-0.3, 0, 0.3].map((x) => (
        <mesh key={x} position={[x, -0.4, 0.1]}>
          <cylinderGeometry args={[0.06, 0.06, 0.9, 10]} />
          <meshStandardMaterial color="#c0c4cc" metalness={0.8} roughness={0.3} />
        </mesh>
      ))}
    </group>
  );
}

function Inductor() {
  const curve = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const turns = 6;
    const N = 160;
    const R = 0.55;
    const H = 2;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const a = t * turns * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * R, -H / 2 + t * H, Math.sin(a) * R));
    }
    return new THREE.CatmullRomCurve3(pts);
  }, []);
  return (
    <group>
      <mesh>
        <tubeGeometry args={[curve, 220, 0.09, 12]} />
        <meshStandardMaterial color="#c8792b" metalness={0.65} roughness={0.35} />
      </mesh>
      <Lead y={1.45} />
      <Lead y={-1.45} />
    </group>
  );
}

function Generic({ color }: { color: string }) {
  return (
    <mesh>
      <boxGeometry args={[1.6, 1, 1]} />
      <meshStandardMaterial color={color} roughness={0.5} />
    </mesh>
  );
}

/** Sceglie il modello 3D per il tipo di componente, con i dati vivi. */
export function ComponentModel({ inst, outputs }: { inst: ComponentInstance; outputs?: DeviceOutputs }) {
  switch (inst.type) {
    case 'resistor':
      return <Resistor R={Number(inst.params.R ?? 1000)} />;
    case 'led':
      return <Led current={Math.abs(Number(outputs?.data.id ?? 0))} color={String(inst.params.color ?? '#ff3b30')} />;
    case 'diode':
    case 'schottky':
      return <Diode band="#9a9a9a" />;
    case 'zener':
      return <Diode band="#f5d000" />;
    case 'capacitor':
      return <Capacitor />;
    case 'inductor':
      return <Inductor />;
    case 'npn':
    case 'pnp':
    case 'bjt':
      return <Transistor />;
    default:
      return <Generic color="#5a6b8c" />;
  }
}
