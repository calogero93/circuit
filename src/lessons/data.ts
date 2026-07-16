// Lezioni guidate M1: ognuna è DATI (circuito iniziale, sonde, passi, punto di
// confronto A/B, formule con termini mappati sui valori vivi, marcatori scope).

import type { Circuit, ComponentInstance, ParamValue, PinRef, Rotation, Wire } from '../model/types.ts';
import type { FormulaDef } from '../math/formula.ts';
import type { ScopeMarker } from '../viz/markers.ts';

export interface LessonStep {
  title: string;
  text: string;
}

export interface Lesson {
  id: string;
  title: string;
  /** Il componente protagonista. */
  focus: string;
  objective: string;
  why: string;
  circuit: Circuit;
  probes: { pin: PinRef; label: string }[];
  scopeTimespan: number;
  timestep: number;
  ab: { componentId: string; mode: 'remove' | 'bypass'; label: string } | null;
  steps: LessonStep[];
  formulas: FormulaDef[];
  markers?: ScopeMarker[];
}

function comp(
  id: string,
  type: string,
  x: number,
  y: number,
  rot: Rotation = 0,
  params: Record<string, ParamValue> = {},
): ComponentInstance {
  return { id, type, x, y, rot, params };
}

function wire(id: string, from: [string, number], to: [string, number]): Wire {
  return { id, from: { component: from[0], pin: from[1] }, to: { component: to[0], pin: to[1] } };
}

function circuit(components: ComponentInstance[], wires: Wire[]): Circuit {
  return { components, wires, groups: [], boundaries: [] };
}

const pin = (component: string, p: number): PinRef => ({ component, pin: p });

// ---------------------------------------------------------------- 1. partitore

const partitore: Lesson = {
  id: 'partitore',
  title: 'Partitore di tensione',
  focus: 'R2',
  objective: 'Capire come due resistori in serie dividono una tensione secondo la legge di Ohm.',
  why:
    'È il circuito più usato in assoluto: da un riferimento fisso ricava una tensione più bassa. ' +
    'Il ruolo di R2 è "reclamare" una frazione della tensione: la sua quota è R2/(R1+R2).',
  circuit: circuit(
    [
      comp('V1', 'vdc', 160, 240, 1, { V: 9 }),
      comp('R1', 'resistor', 320, 160, 0, { R: 10_000 }),
      comp('R2', 'resistor', 480, 240, 1, { R: 20_000 }),
      comp('GND1', 'ground', 160, 320),
      comp('GND2', 'ground', 480, 320),
    ],
    [
      wire('w1', ['V1', 0], ['R1', 0]),
      wire('w2', ['R1', 1], ['R2', 0]),
      wire('w3', ['R2', 1], ['GND2', 0]),
      wire('w4', ['V1', 1], ['GND1', 0]),
    ],
  ),
  probes: [
    { pin: pin('V1', 0), label: 'Vin' },
    { pin: pin('R1', 1), label: 'Vout' },
  ],
  scopeTimespan: 0.5,
  timestep: 1e-4,
  ab: { componentId: 'R2', mode: 'remove', label: 'Togli R2: senza percorso verso massa, Vout sale fino a Vin' },
  steps: [
    {
      title: 'Osserva',
      text:
        'La sorgente impone 9 V. I fili sono colorati per tensione e i puntini mostrano la corrente: ' +
        'la STESSA corrente attraversa R1 e R2 (sono in serie). Passa il mouse sui nodi per leggere le tensioni.',
    },
    {
      title: 'Causa → effetto',
      text:
        'Seleziona R2 e muovi lo slider: Vout segue in tempo reale. Più R2 è grande rispetto a R1, ' +
        'più tensione "reclama". Prova R2 = R1: Vout diventa esattamente metà di Vin.',
    },
    {
      title: 'Confronto A/B',
      text:
        'Attiva il confronto A/B (R2 tolto): senza R2 non scorre corrente, su R1 non cade nulla ' +
        'e Vout sale fino a Vin. La traccia tratteggiata sull\'oscilloscopio mostra il circuito senza R2.',
    },
    {
      title: 'La matematica',
      text:
        'Apri il pannello Matematica: la derivazione da Kirchhoff e Ohm arriva a Vout = Vin·R2/(R1+R2). ' +
        'Passa il mouse sui simboli: si illuminano i componenti corrispondenti, con i valori correnti.',
    },
  ],
  formulas: [
    {
      id: 'partitore-derivazione',
      title: 'Derivazione del partitore',
      description: 'Da KCL (stessa corrente in serie) e dalla legge di Ohm.',
      steps: [
        { latex: 'I_{R_1} = I_{R_2} = I', note: 'KCL: nel nodo Vout non entra altra corrente' },
        {
          latex: '\\htmlClass{fx-vin}{V_{in}} = I\\,(\\htmlClass{fx-r1}{R_1} + \\htmlClass{fx-r2}{R_2})',
          note: 'KVL: la tensione della sorgente si ripartisce sulla serie',
        },
        { latex: 'V_{out} = I\\,\\htmlClass{fx-r2}{R_2}', note: 'legge di Ohm su R2' },
        {
          latex:
            '\\htmlClass{fx-vout}{V_{out}} = \\htmlClass{fx-vin}{V_{in}}\\cdot\\frac{\\htmlClass{fx-r2}{R_2}}{\\htmlClass{fx-r1}{R_1}+\\htmlClass{fx-r2}{R_2}}',
          note: 'sostituendo I: ecco il partitore',
        },
      ],
      terms: [
        { term: 'vin', label: 'V_in', unit: 'V', target: { kind: 'param', component: 'V1', param: 'V' }, highlight: { kind: 'component', id: 'V1' } },
        { term: 'r1', label: 'R₁', unit: 'Ω', target: { kind: 'param', component: 'R1', param: 'R' }, highlight: { kind: 'component', id: 'R1' } },
        { term: 'r2', label: 'R₂', unit: 'Ω', target: { kind: 'param', component: 'R2', param: 'R' }, highlight: { kind: 'component', id: 'R2' } },
        {
          term: 'vout',
          label: 'V_out (simulata)',
          unit: 'V',
          target: { kind: 'netVoltage', pin: pin('R1', 1) },
          highlight: { kind: 'net', pin: pin('R1', 1) },
        },
        {
          term: 'voutf',
          label: 'V_out (formula)',
          unit: 'V',
          target: {
            kind: 'derived',
            expr: {
              op: 'div',
              a: {
                op: 'mul',
                args: [
                  { op: 'value', target: { kind: 'param', component: 'V1', param: 'V' } },
                  { op: 'value', target: { kind: 'param', component: 'R2', param: 'R' } },
                ],
              },
              b: {
                op: 'add',
                args: [
                  { op: 'value', target: { kind: 'param', component: 'R1', param: 'R' } },
                  { op: 'value', target: { kind: 'param', component: 'R2', param: 'R' } },
                ],
              },
            },
          },
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------- 2. RC

const rc: Lesson = {
  id: 'rc',
  title: 'Carica e scarica RC',
  focus: 'C1',
  objective: 'Vedere la costante di tempo τ = RC: il condensatore si carica in modo esponenziale, non istantaneo.',
  why:
    'Il condensatore si oppone alle variazioni di tensione: la corrente che lo carica è limitata da R, ' +
    'quindi la carica richiede tempo. τ = RC è IL parametro: a t = τ ha raggiunto il 63,2% del valore finale.',
  circuit: circuit(
    [
      comp('V1', 'vdc', 140, 240, 1, { V: 5 }),
      comp('SW1', 'switch', 280, 160, 0, { closed: false }),
      comp('R1', 'resistor', 420, 160, 0, { R: 1_000 }),
      comp('C1', 'capacitor', 560, 240, 1, { C: 1e-3 }),
      comp('GND1', 'ground', 140, 320),
      comp('GND2', 'ground', 560, 320),
    ],
    [
      wire('w1', ['V1', 0], ['SW1', 0]),
      wire('w2', ['SW1', 1], ['R1', 0]),
      wire('w3', ['R1', 1], ['C1', 0]),
      wire('w4', ['C1', 1], ['GND2', 0]),
      wire('w5', ['V1', 1], ['GND1', 0]),
    ],
  ),
  probes: [
    // stessa net di C1:0, ma su un pin che sopravvive al confronto A/B (C tolto)
    { pin: pin('R1', 1), label: 'Vc' },
    { pin: pin('V1', 0), label: 'Vin' },
  ],
  scopeTimespan: 5,
  timestep: 1e-3,
  ab: { componentId: 'C1', mode: 'remove', label: 'Togli C: la tensione salta istantaneamente (nessuna memoria)' },
  markers: [{ kind: 'rc-tau', rComponent: 'R1', cComponent: 'C1', sourceComponent: 'V1', switchComponent: 'SW1' }],
  steps: [
    {
      title: 'Chiudi il circuito',
      text:
        'Fai doppio click sull\'interruttore SW1 (o usa il pannello proprietà). La corrente inizia a caricare ' +
        'il condensatore: guarda i puntini rallentare man mano che C1 si riempie.',
    },
    {
      title: 'Il marcatore τ',
      text:
        'Sull\'oscilloscopio: la linea orizzontale è il 63,2% di Vin, quella verticale è t₀+τ. ' +
        'La traccia Vc le attraversa ESATTAMENTE nel punto di incrocio: τ = R·C = 1 s con i valori attuali.',
    },
    {
      title: 'Causa → effetto',
      text:
        'Riapri l\'interruttore (scarica), poi cambia R o C e richiudi: τ si sposta di conseguenza. ' +
        'Raddoppi R? La carica dura il doppio. Il marcatore segue i valori vivi.',
    },
    {
      title: 'Confronto A/B',
      text:
        'Attiva il confronto A/B (C tolto): senza condensatore la tensione salta istantaneamente al valore finale. ' +
        'È la differenza tra un sistema con memoria e uno senza.',
    },
    {
      title: 'La matematica',
      text:
        'Nel pannello Matematica c\'è l\'equazione differenziale RC·dV/dt + V = Vin e la sua soluzione ' +
        'esponenziale. I simboli R, C, τ sono agganciati ai valori correnti del circuito.',
    },
  ],
  formulas: [
    {
      id: 'rc-derivazione',
      title: 'L\'equazione differenziale della carica',
      description: 'Da KVL e dalla relazione i = C·dv/dt del condensatore.',
      steps: [
        {
          latex: '\\htmlClass{fx-vin}{V_{in}} = \\htmlClass{fx-r}{R}\\,i(t) + \\htmlClass{fx-vc}{v_C(t)}',
          note: 'KVL sulla maglia (interruttore chiuso)',
        },
        { latex: 'i(t) = \\htmlClass{fx-c}{C}\\,\\frac{dv_C}{dt}', note: 'relazione costitutiva del condensatore' },
        {
          latex: '\\htmlClass{fx-r}{R}\\htmlClass{fx-c}{C}\\,\\frac{dv_C}{dt} + v_C = \\htmlClass{fx-vin}{V_{in}}',
          note: 'equazione differenziale lineare del primo ordine',
        },
        {
          latex: 'v_C(t) = \\htmlClass{fx-vin}{V_{in}}\\left(1 - e^{-t/\\htmlClass{fx-tau}{\\tau}}\\right)',
          note: 'soluzione con condensatore inizialmente scarico',
        },
        {
          latex:
            '\\htmlClass{fx-tau}{\\tau} = \\htmlClass{fx-r}{R}\\,\\htmlClass{fx-c}{C}, \\qquad v_C(\\tau) = 0{,}632\\,V_{in}',
          note: 'a t = τ: 1 − e⁻¹ = 63,2% — il marcatore sull\'oscilloscopio',
        },
      ],
      terms: [
        { term: 'r', label: 'R', unit: 'Ω', target: { kind: 'param', component: 'R1', param: 'R' }, highlight: { kind: 'component', id: 'R1' } },
        { term: 'c', label: 'C', unit: 'F', target: { kind: 'param', component: 'C1', param: 'C' }, highlight: { kind: 'component', id: 'C1' } },
        {
          term: 'tau',
          label: 'τ = RC',
          unit: 's',
          target: {
            kind: 'derived',
            expr: {
              op: 'mul',
              args: [
                { op: 'value', target: { kind: 'param', component: 'R1', param: 'R' } },
                { op: 'value', target: { kind: 'param', component: 'C1', param: 'C' } },
              ],
            },
          },
        },
        { term: 'vin', label: 'V_in', unit: 'V', target: { kind: 'param', component: 'V1', param: 'V' }, highlight: { kind: 'component', id: 'V1' } },
        { term: 'vc', label: 'v_C (simulata)', unit: 'V', target: { kind: 'componentData', component: 'C1', key: 'v' }, highlight: { kind: 'component', id: 'C1' } },
      ],
    },
  ],
};

// -------------------------------------------------------------- 3. raddrizzatore

const raddrizzatore: Lesson = {
  id: 'raddrizzatore',
  title: 'Raddrizzatore con condensatore di livellamento',
  focus: 'C1',
  objective:
    'Trasformare una tensione alternata in continua: il diodo raddrizza, il condensatore livella. Togli il condensatore e l\'ondulazione ricompare.',
  why:
    'È il cuore di ogni alimentatore. Il diodo lascia passare solo le semionde positive; senza condensatore ' +
    'l\'uscita pulsa tra 0 e il picco. Il condensatore fa da serbatoio: si riempie sul picco e sostiene il carico tra un picco e l\'altro.',
  circuit: circuit(
    [
      comp('V1', 'vsin', 140, 240, 1, { amp: 5, freq: 50, offset: 0 }),
      comp('D1', 'diode', 300, 160, 0),
      comp('C1', 'capacitor', 460, 240, 1, { C: 100e-6 }),
      comp('RL', 'resistor', 600, 240, 1, { R: 1_000 }),
      comp('GND1', 'ground', 140, 320),
      comp('GND2', 'ground', 460, 320),
    ],
    [
      wire('w1', ['V1', 0], ['D1', 0]),
      wire('w2', ['D1', 1], ['C1', 0]),
      wire('w3', ['C1', 0], ['RL', 0]),
      wire('w4', ['C1', 1], ['GND2', 0]),
      wire('w5', ['RL', 1], ['C1', 1]),
      wire('w6', ['V1', 1], ['GND1', 0]),
    ],
  ),
  probes: [
    { pin: pin('V1', 0), label: 'Vin' },
    { pin: pin('RL', 0), label: 'Vout' },
  ],
  scopeTimespan: 0.1,
  timestep: 1e-4,
  ab: { componentId: 'C1', mode: 'remove', label: 'Togli C: l\'ondulazione ricompare (uscita pulsante)' },
  steps: [
    {
      title: 'Osserva le due tracce',
      text:
        'Vin (sinusoide) e Vout (quasi piatta). Il diodo conduce solo quando Vin supera Vout di ~0,7 V: ' +
        'guarda i puntini di corrente comparire a impulsi, solo sui picchi.',
    },
    {
      title: 'Il confronto che spiega tutto',
      text:
        'Attiva il confronto A/B (C tolto): la traccia fantasma mostra l\'uscita SENZA condensatore — ' +
        'semionde pulsanti tra 0 e ~4,3 V. La differenza tra le due tracce È il ruolo del condensatore.',
    },
    {
      title: 'Causa → effetto',
      text:
        'Seleziona C1 e riduci la capacità: l\'ondulazione (ripple) cresce. Riduci RL (più carico → più corrente): ' +
        'il serbatoio si svuota più in fretta, di nuovo più ripple. La formula del pannello Matematica lo prevede.',
    },
    {
      title: 'Perché ~4,3 V e non 5?',
      text:
        'Il picco dell\'uscita è il picco d\'ingresso meno la caduta del diodo (~0,7 V). Seleziona D1 e apri ' +
        'Matematica: la curva di Shockley mostra il punto di lavoro sui picchi di conduzione.',
    },
  ],
  formulas: [
    {
      id: 'ripple',
      title: 'Stima dell\'ondulazione residua',
      description:
        'Tra un picco e l\'altro (durata ≈ 1/f) il condensatore alimenta da solo il carico: si scarica di ΔV.',
      steps: [
        { latex: 'Q = C\\,\\Delta V \\quad\\Rightarrow\\quad \\Delta V = \\frac{I\\,\\Delta t}{C}', note: 'bilancio di carica del serbatoio' },
        {
          latex:
            '\\htmlClass{fx-vr}{V_{ripple}} \\approx \\frac{\\htmlClass{fx-i}{I_{load}}}{\\htmlClass{fx-f}{f}\\,\\htmlClass{fx-c}{C}}',
          note: 'con Δt ≈ 1/f (raddrizzatore a semionda)',
        },
      ],
      terms: [
        { term: 'i', label: 'I_load', unit: 'A', target: { kind: 'componentData', component: 'RL', key: 'i' }, highlight: { kind: 'component', id: 'RL' } },
        { term: 'f', label: 'f', unit: 'Hz', target: { kind: 'param', component: 'V1', param: 'freq' }, highlight: { kind: 'component', id: 'V1' } },
        { term: 'c', label: 'C', unit: 'F', target: { kind: 'param', component: 'C1', param: 'C' }, highlight: { kind: 'component', id: 'C1' } },
        {
          term: 'vr',
          label: 'V_ripple (formula)',
          unit: 'V',
          target: {
            kind: 'derived',
            expr: {
              op: 'div',
              a: { op: 'value', target: { kind: 'componentData', component: 'RL', key: 'i' } },
              b: {
                op: 'mul',
                args: [
                  { op: 'value', target: { kind: 'param', component: 'V1', param: 'freq' } },
                  { op: 'value', target: { kind: 'param', component: 'C1', param: 'C' } },
                ],
              },
            },
          },
        },
      ],
    },
  ],
};

// ------------------------------------------------------------------ 4. clipping

const clipping: Lesson = {
  id: 'clipping',
  title: 'Clipping con diodo',
  focus: 'D1',
  objective: 'Usare la soglia del diodo per "tosare" un segnale: sopra ~0,7 V il diodo conduce e blocca la salita.',
  why:
    'Protezione degli ingressi, shaping del segnale, distorsione volontaria (i pedali per chitarra!): ' +
    'tutto nasce dal fatto che oltre la soglia il diodo diventa un percorso a bassa impedenza verso massa.',
  circuit: circuit(
    [
      comp('V1', 'vsin', 140, 240, 1, { amp: 5, freq: 50, offset: 0 }),
      comp('R1', 'resistor', 300, 160, 0, { R: 1_000 }),
      comp('D1', 'diode', 440, 240, 1),
      comp('GND1', 'ground', 140, 320),
      comp('GND2', 'ground', 440, 320),
    ],
    [
      wire('w1', ['V1', 0], ['R1', 0]),
      wire('w2', ['R1', 1], ['D1', 0]),
      wire('w3', ['D1', 1], ['GND2', 0]),
      wire('w4', ['V1', 1], ['GND1', 0]),
    ],
  ),
  probes: [
    { pin: pin('V1', 0), label: 'Vin' },
    { pin: pin('R1', 1), label: 'Vout' },
  ],
  scopeTimespan: 0.05,
  timestep: 1e-4,
  ab: { componentId: 'D1', mode: 'remove', label: 'Togli il diodo: il segnale passa intero, niente tosatura' },
  steps: [
    {
      title: 'Osserva',
      text:
        'Vout segue Vin nelle semionde negative, ma sopra ~0,65 V si appiattisce: il diodo conduce e ' +
        '"scarica" a massa tutto ciò che eccede. R1 limita la corrente di scarica.',
    },
    {
      title: 'Confronto A/B',
      text:
        'Attiva il confronto A/B (diodo tolto): la traccia fantasma è la sinusoide integra. ' +
        'La differenza tra le due tracce è esattamente ciò che il diodo si è "mangiato".',
    },
    {
      title: 'Causa → effetto',
      text:
        'Seleziona D1 e guarda la curva di Shockley in Matematica: durante il clipping il punto di lavoro ' +
        'sale sul ginocchio della curva. Aumenta l\'ampiezza di V1: il tosaggio diventa più netto.',
    },
  ],
  formulas: [
    {
      id: 'clipping-kvl',
      title: 'Dove finisce la tensione in eccesso',
      steps: [
        {
          latex:
            '\\htmlClass{fx-vout}{v_{out}} = \\htmlClass{fx-vin}{v_{in}} - \\htmlClass{fx-r}{R}\\,\\htmlClass{fx-i}{i_D}',
          note: 'KVL: quando il diodo conduce, l\'eccesso cade su R',
        },
        {
          latex: 'i_D = I_S\\left(e^{\\htmlClass{fx-vout}{v_{out}}/(n V_T)}-1\\right)',
          note: 'la soglia non è un gradino: è l\'esponenziale di Shockley',
        },
      ],
      terms: [
        { term: 'vin', label: 'v_in', unit: 'V', target: { kind: 'componentData', component: 'V1', key: 'v' }, highlight: { kind: 'component', id: 'V1' } },
        { term: 'vout', label: 'v_out (simulata)', unit: 'V', target: { kind: 'netVoltage', pin: pin('R1', 1) }, highlight: { kind: 'net', pin: pin('R1', 1) } },
        { term: 'r', label: 'R', unit: 'Ω', target: { kind: 'param', component: 'R1', param: 'R' }, highlight: { kind: 'component', id: 'R1' } },
        { term: 'i', label: 'i_D', unit: 'A', target: { kind: 'componentData', component: 'D1', key: 'id' }, highlight: { kind: 'component', id: 'D1' } },
      ],
    },
  ],
};

// ----------------------------------------------------------------------- 5. LED

const led: Lesson = {
  id: 'led',
  title: 'LED con resistenza di limitazione',
  focus: 'R1',
  objective: 'Capire perché un LED non si collega MAI direttamente a una sorgente: la resistenza fissa la corrente.',
  why:
    'La curva del LED è esponenziale: sopra la soglia, una variazione di pochi millivolt moltiplica la corrente. ' +
    'La sorgente imporrebbe una tensione, non una corrente: senza R la corrente diverge e il LED brucia. ' +
    'R trasforma "tensione imposta" in "corrente scelta da te".',
  circuit: circuit(
    [
      comp('V1', 'vdc', 140, 240, 1, { V: 5 }),
      comp('R1', 'resistor', 300, 160, 0, { R: 330 }),
      comp('LED1', 'led', 460, 240, 1),
      comp('GND1', 'ground', 140, 320),
      comp('GND2', 'ground', 460, 320),
    ],
    [
      wire('w1', ['V1', 0], ['R1', 0]),
      wire('w2', ['R1', 1], ['LED1', 0]),
      wire('w3', ['LED1', 1], ['GND2', 0]),
      wire('w4', ['V1', 1], ['GND1', 0]),
    ],
  ),
  probes: [{ pin: pin('R1', 1), label: 'Va' }],
  scopeTimespan: 0.5,
  timestep: 1e-4,
  ab: { componentId: 'R1', mode: 'bypass', label: 'Bypassa R: la corrente diverge, il LED si brucia' },
  steps: [
    {
      title: 'Osserva',
      text:
        'Il LED è acceso: l\'alone cresce con la corrente REALE simulata (~10 mA con questi valori). ' +
        'Passa il mouse sul LED: I e V ai capi. Nota: ai capi del LED cadono ~2 V, il resto (3 V) su R1.',
    },
    {
      title: 'Causa → effetto',
      text:
        'Seleziona R1 e muovi lo slider: meno resistenza → più corrente → più luce. Sotto ~150 Ω superi ' +
        'i 20 mA di targa: stai accorciando la vita del LED.',
    },
    {
      title: 'Il disastro, in sicurezza',
      text:
        'Attiva il confronto A/B (R bypassata): senza resistenza la corrente simulata diverge ad ampere — ' +
        'il simbolo del LED mostra la ✗ di "bruciato". Nella realtà: fumo. Ecco perché R è obbligatoria.',
    },
    {
      title: 'La matematica',
      text:
        'La corrente la scegli TU con R: I = (Vcc − V_F)/R. Il pannello Matematica mostra la formula con i ' +
        'valori vivi: verifica che la previsione coincida con la corrente simulata del LED.',
    },
  ],
  formulas: [
    {
      id: 'led-resistenza',
      title: 'Dimensionare la resistenza di limitazione',
      description: 'KVL sulla maglia: la sorgente si divide tra R e la caduta (quasi costante) del LED.',
      steps: [
        {
          latex: '\\htmlClass{fx-vcc}{V_{cc}} = R\\,I + \\htmlClass{fx-vf}{V_F}',
          note: 'KVL sulla maglia',
        },
        {
          latex:
            '\\htmlClass{fx-i}{I} = \\frac{\\htmlClass{fx-vcc}{V_{cc}} - \\htmlClass{fx-vf}{V_F}}{\\htmlClass{fx-r}{R}}',
          note: 'risolta per la corrente: R decide I',
        },
      ],
      terms: [
        { term: 'vcc', label: 'V_cc', unit: 'V', target: { kind: 'param', component: 'V1', param: 'V' }, highlight: { kind: 'component', id: 'V1' } },
        { term: 'vf', label: 'V_F (simulata)', unit: 'V', target: { kind: 'componentData', component: 'LED1', key: 'vd' }, highlight: { kind: 'component', id: 'LED1' } },
        { term: 'r', label: 'R', unit: 'Ω', target: { kind: 'param', component: 'R1', param: 'R' }, highlight: { kind: 'component', id: 'R1' } },
        { term: 'i', label: 'I (simulata)', unit: 'A', target: { kind: 'componentData', component: 'LED1', key: 'id' }, highlight: { kind: 'component', id: 'LED1' } },
        {
          term: 'if',
          label: 'I (formula)',
          unit: 'A',
          target: {
            kind: 'derived',
            expr: {
              op: 'div',
              a: {
                op: 'add',
                args: [
                  { op: 'value', target: { kind: 'param', component: 'V1', param: 'V' } },
                  {
                    op: 'mul',
                    args: [
                      { op: 'const', value: -1 },
                      { op: 'value', target: { kind: 'componentData', component: 'LED1', key: 'vd' } },
                    ],
                  },
                ],
              },
              b: { op: 'value', target: { kind: 'param', component: 'R1', param: 'R' } },
            },
          },
        },
      ],
    },
  ],
};

// ------------------------------------------------------------- ZENER REGULATOR
const zenerReg: Lesson = {
  id: 'zener-reg',
  title: 'Regolatore con Diodo Zener',
  focus: 'D1',
  objective: 'Stabilizzare una tensione d\'uscita a 5,1 V usando un diodo Zener in inversa.',
  why: 'Il diodo Zener conduce quando la tensione inversa supera Vz (5,1 V), mantenendola fissa e stabile anche se la tensione di alimentazione o il carico cambiano.',
  circuit: circuit(
    [
      comp('V1', 'vdc', 140, 240, 1, { V: 9 }),
      comp('R1', 'resistor', 300, 160, 0, { R: 220 }),
      comp('D1', 'zener', 440, 240, 1, { Vz: 5.1 }),
      comp('RL', 'resistor', 580, 240, 1, { R: 1000 }),
      comp('GND1', 'ground', 140, 320),
      comp('GND2', 'ground', 440, 320),
      comp('GND3', 'ground', 580, 320),
    ],
    [
      wire('w1', ['V1', 0], ['R1', 0]),
      wire('w2', ['R1', 1], ['D1', 1]),
      wire('w3', ['R1', 1], ['RL', 0]),
      wire('w4', ['D1', 0], ['GND2', 0]),
      wire('w5', ['RL', 1], ['GND3', 0]),
      wire('w6', ['V1', 1], ['GND1', 0]),
    ]
  ),
  probes: [
    { pin: pin('V1', 0), label: 'Vin' },
    { pin: pin('RL', 0), label: 'Vout' },
  ],
  scopeTimespan: 0.5,
  timestep: 1e-4,
  ab: { componentId: 'D1', mode: 'remove', label: 'Togli Zener: perdi la regolazione, la tensione sale a Vin' },
  steps: [
    {
      title: 'Regolazione',
      text: 'La tensione di ingresso è 9 V, ma sull\'uscita (Vout) misuri circa 5,1 V grazie allo Zener. La tensione in eccesso cade sulla resistenza R1.',
    },
    {
      title: 'Causa → effetto',
      text: 'Seleziona la sorgente V1 e varia la tensione da 7 V a 12 V: l\'uscita Vout rimane fissa e stabilizzata a ~5,1 V! Cambia ora RL: l\'uscita non si sposta.',
    },
    {
      title: 'Senza lo Zener',
      text: 'Attiva il confronto A/B (Zener rimosso): l\'uscita sale istantaneamente, perdendo ogni regolazione. Nella traccia fantasma vedi che l\'uscita segue l\'ingresso.',
    },
  ],
  formulas: [],
};

// ------------------------------------------------------------- BJT AMPLIFIER
const bjtAmp: Lesson = {
  id: 'bjt-amp',
  title: 'Amplificatore a BJT Emettitore Comune',
  focus: 'Q1',
  objective: 'Amplificare un piccolo segnale alternato usando un transistor NPN polarizzato.',
  why: 'Il transistor BJT, se opportunamente polarizzato in zona attiva, controlla la corrente di collettore tramite la corrente di base, fornendo un elevato guadagno di tensione.',
  circuit: circuit(
    [
      comp('V1', 'vdc', 100, 200, 1, { V: 12 }),
      comp('V2', 'vsin', 100, 340, 1, { amp: 0.1, freq: 1000, offset: 0 }),
      comp('C1', 'capacitor', 220, 340, 0, { C: 10e-6 }),
      comp('R1', 'resistor', 320, 140, 1, { R: 47000 }),
      comp('R2', 'resistor', 320, 280, 1, { R: 10000 }),
      comp('Q1', 'npn', 440, 240, 0, { beta: 100 }),
      comp('Rc', 'resistor', 440, 120, 1, { R: 3300 }),
      comp('Re', 'resistor', 440, 320, 1, { R: 1000 }),
      comp('GND1', 'ground', 100, 260),
      comp('GND2', 'ground', 100, 400),
      comp('GND3', 'ground', 320, 360),
      comp('GND4', 'ground', 440, 380),
    ],
    [
      wire('w1', ['V1', 0], ['Rc', 0]),
      wire('w2', ['V1', 0], ['R1', 0]),
      wire('w3', ['R1', 1], ['R2', 0]),
      wire('w4', ['R1', 1], ['C1', 1]),
      wire('w5', ['R1', 1], ['Q1', 0]),
      wire('w6', ['C1', 0], ['V2', 0]),
      wire('w7', ['Q1', 1], ['Rc', 1]),
      wire('w8', ['Q1', 2], ['Re', 0]),
      wire('w9', ['Re', 1], ['GND4', 0]),
      wire('w10', ['R2', 1], ['GND3', 0]),
      wire('w11', ['V1', 1], ['GND1', 0]),
      wire('w12', ['V2', 1], ['GND2', 0]),
    ]
  ),
  probes: [
    { pin: pin('V2', 0), label: 'Vin (AC)' },
    { pin: pin('Q1', 1), label: 'Vout (amplificata)' },
  ],
  scopeTimespan: 0.005,
  timestep: 1e-5,
  ab: null,
  steps: [
    {
      title: 'Osserva l\'amplificazione',
      text: 'La traccia Vin oscilla a ±100 mV, mentre la traccia Vout sul collettore oscilla a circa ±1 V con fase opposta (sfasamento di 180°). Il segnale è stato amplificato di ~10 volte!',
    },
    {
      title: 'Polarizzazione DC',
      text: 'Fai passare il mouse sui pin del transistor Q1: vedrai una tensione VBE stabile di circa 0,65 V e una VCE di circa 6 V. Questo posiziona il BJT esattamente al centro della zona attiva.',
    },
    {
      title: 'Accoppiamento AC',
      text: 'Il condensatore C1 fa passare il segnale AC ma blocca la componente DC della base. Prova a ridurne il valore per vedere come risponde alle basse frequenze!',
    },
  ],
  formulas: [],
};

// ------------------------------------------------------------- BRIDGE RECTIFIER
const bridgeRectifier: Lesson = {
  id: 'bridge-graetz',
  title: 'Raddrizzatore a Ponte di Graetz',
  focus: 'C1',
  objective: 'Esplorare il raddrizzamento a doppia semionda e il filtraggio capacitivo.',
  why: 'Il ponte di Graetz reindirizza la semionda negativa in modo che scorra nello stesso verso nel carico, dimezzando l\'ondulazione (ripple) residua rispetto al raddrizzatore a singola semionda.',
  circuit: circuit(
    [
      comp('V1', 'vsin', 140, 240, 1, { amp: 10, freq: 50, offset: 0 }),
      comp('BR1', 'bridge_rectifier', 300, 240),
      comp('C1', 'capacitor', 460, 240, 1, { C: 100e-6 }),
      comp('RL', 'resistor', 600, 240, 1, { R: 1000 }),
      comp('GND1', 'ground', 460, 320),
    ],
    [
      wire('w1', ['V1', 0], ['BR1', 0]),
      wire('w2', ['V1', 1], ['BR1', 1]),
      wire('w3', ['BR1', 2], ['C1', 0]),
      wire('w4', ['BR1', 2], ['RL', 0]),
      wire('w5', ['BR1', 3], ['C1', 1]),
      wire('w6', ['BR1', 3], ['RL', 1]),
      wire('w7', ['BR1', 3], ['GND1', 0]),
    ]
  ),
  probes: [
    { pin: pin('V1', 0), label: 'Vac (Vin)' },
    { pin: pin('RL', 0), label: 'Vdc (Vout)' },
  ],
  scopeTimespan: 0.1,
  timestep: 1e-4,
  ab: { componentId: 'C1', mode: 'remove', label: 'Togli condensatore: ottieni doppia semionda pura, senza livellamento' },
  steps: [
    {
      title: 'Doppia semionda',
      text: 'Il ponte raddrizza entrambe le semionde dell\'alternata. Attiva il confronto A/B per togliere il condensatore C1 e guarda la traccia fantasma: è una doppia semionda pulsante!',
    },
    {
      title: 'Confronto con semionda singola',
      text: 'Rispetto alla lezione sul raddrizzatore a singola semionda, qui l\'uscita non scende mai a zero per lunghi tratti: il ripple è dimezzato e l\'efficienza raddoppiata.',
    },
    {
      title: 'Causa → effetto',
      text: 'Riduci la capacità di C1 o riduci la resistenza di RL (aumentando il carico): vedrai aumentare l\'ondulazione residua (ripple).',
    },
  ],
  formulas: [],
};

export const LESSONS: Lesson[] = [partitore, rc, raddrizzatore, clipping, led, zenerReg, bjtAmp, bridgeRectifier];

export function getLesson(id: string): Lesson | null {
  return LESSONS.find((l) => l.id === id) ?? null;
}
