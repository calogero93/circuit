// Marcatori didattici dell'oscilloscopio (dati, definiti dalle lezioni).

export type ScopeMarker = {
  kind: 'rc-tau';
  /** Componenti da cui leggere R, C e V∞ (valori vivi). */
  rComponent: string;
  cComponent: string;
  sourceComponent: string;
  /** L'istante t₀ è l'ultimo evento su questo componente (chiusura interruttore). */
  switchComponent: string;
};
