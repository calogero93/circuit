// Soluzione di sistemi lineari densi con eliminazione di Gauss e pivoting
// parziale. I circuiti didattici sono piccoli: il denso è la scelta semplice.

/**
 * Risolve A x = b in place (A e b vengono modificati). A è n×n row-major.
 * Ritorna x, o null se la matrice è singolare.
 */
export function solveInPlace(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  for (let col = 0; col < n; col++) {
    // pivoting parziale
    let pivotRow = col;
    let pivotAbs = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const a = Math.abs(A[r * n + col]);
      if (a > pivotAbs) {
        pivotAbs = a;
        pivotRow = r;
      }
    }
    if (pivotAbs < 1e-13) return null;
    if (pivotRow !== col) {
      for (let c = col; c < n; c++) {
        const t = A[col * n + c];
        A[col * n + c] = A[pivotRow * n + c];
        A[pivotRow * n + c] = t;
      }
      const t = b[col];
      b[col] = b[pivotRow];
      b[pivotRow] = t;
    }
    const pivot = A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] / pivot;
      if (f === 0) continue;
      A[r * n + col] = 0;
      for (let c = col + 1; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r * n + c] * x[c];
    x[r] = s / A[r * n + r];
  }
  return x;
}
