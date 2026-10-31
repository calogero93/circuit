import test from 'node:test';
import assert from 'node:assert/strict';
import { csvField, timeCSV, bodeCSV } from '../../src/scenarios/csv.ts';

test('CSV encodes text fields and neutralizes formulas before quoting', () => {
  for (const [raw, expected] of [
    ['Vout', 'Vout'], ['a,b', '"a,b"'], ['a"b', '"a""b"'], ['a\nb', '"a\nb"'], ['a\rb', '"a\rb"'],
    ['=1+1', "'=1+1"], ['+SUM(A1)', "'+SUM(A1)"], ['-1+2', "'-1+2"], ['@SUM(A1)', "'@SUM(A1)"],
    [' \t=1', "' \t=1"], ['\u0000+1', "'\u0000+1"], ['\u200b@SUM(A1)', "'\u200b@SUM(A1)"],
    ['\r\n-1', '"\'\r\n-1"'], ['=SUM(1,2)', '"\'=SUM(1,2)"'],
  ]) assert.equal(csvField(raw), expected, JSON.stringify(raw));
  assert.equal(csvField(-1.25), '-1.25');
  assert.equal(csvField(1e-9), '1e-9');
});

test('time and Bode exports protect every label and preserve numeric precision', () => {
  const probes = [{ label: '=SUM(1,2)' }, { label: '"out"\nnext' }];
  assert.equal(timeCSV(probes, [{ t: 0.001, v: [-1.25, 2] }]),
    'Tempo (s),"\'=SUM(1,2) (V)","""out""\nnext (V)"\n0.001000,-1.2500,2.0000');
  assert.equal(bodeCSV([{ label: ' +1' }], [{ f: 100, gainDb: [-3.12], phaseDeg: [-45] }]),
    "Frequenza (Hz),' +1 Guadagno (dB),' +1 Fase (deg)\n100.00,-3.12,-45.0");
  assert.equal(timeCSV([{ label: 'Vout' }], [{ t: 0, v: [1] }]), 'Tempo (s),Vout (V)\n0.000000,1.0000');
});
