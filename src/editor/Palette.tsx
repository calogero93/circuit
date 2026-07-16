// Palette dei componenti nella sidebar: click per entrare in modalità
// piazzamento. Icona = simbolo 2D del registro in miniatura.

import { listDefs } from '../model/registry.ts';
import { useStudio } from '../store/studio.ts';
import { SymbolView } from './SymbolView.tsx';

const CATEGORIES: { key: string; title: string }[] = [
  { key: 'sorgenti', title: 'Sorgenti' },
  { key: 'passivi', title: 'Passivi' },
  { key: 'semiconduttori', title: 'Semiconduttori' },
  { key: 'digitale', title: 'Digitale' },
  { key: 'altro', title: 'Altro' },
];

export function Palette() {
  const tool = useStudio((s) => s.tool);
  const setTool = useStudio((s) => s.setTool);
  const defs = listDefs();

  return (
    <div className="palette">
      {CATEGORIES.map((cat) => (
        <div key={cat.key} className="palette-group">
          <div className="palette-title">{cat.title}</div>
          {defs
            .filter((d) => d.category === cat.key && d.type !== 'node')
            .map((def) => {
              const active = tool.kind === 'place' && tool.type === def.type;
              return (
                <button
                  key={def.type}
                  className={`palette-item${active ? ' active' : ''}`}
                  title={def.description}
                  onClick={() =>
                    active ? setTool({ kind: 'select' }) : setTool({ kind: 'place', type: def.type, rot: 0 })
                  }
                >
                  <svg viewBox="-48 -34 96 68" className="palette-icon">
                    <g className="symbol">
                      <SymbolView prims={def.symbol(def.defaults)} />
                    </g>
                  </svg>
                  <span>{def.name}</span>
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
}
