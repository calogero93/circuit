// Registrazione della libreria M1. Aggiungere un componente = aggiungere una
// voce qui (o registrarla altrove): il nucleo non cambia (seam §4.4).

import { registerComponent, listDefs } from '../model/registry.ts';
import { resistorDef, capacitorDef, inductorDef } from './passives.ts';
import { vdcDef, vsinDef, idcDef } from './sources.ts';
import { diodeDef, ledDef, bjtDef } from './semiconductors.ts';
import { groundDef, switchDef } from './misc.ts';

let registered = false;

export function registerLibrary(): void {
  if (registered) return;
  registered = true;
  for (const def of [
    groundDef,
    vdcDef,
    vsinDef,
    idcDef,
    resistorDef,
    capacitorDef,
    inductorDef,
    diodeDef,
    ledDef,
    switchDef,
    bjtDef,
  ]) {
    registerComponent(def);
  }
}

export { listDefs };
