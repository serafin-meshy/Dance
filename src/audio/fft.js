/** Minimal in-place radix-2 complex FFT (re/im Float32Arrays, length power of two). */
export class FFT {
  constructor(n) {
    if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2); this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(-2 * Math.PI * i / n); this.sin[i] = Math.sin(-2 * Math.PI * i / n); }
  }
  transform(re, im) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const l = i + j, r = l + half;
          const tr = re[r] * this.cos[k] - im[r] * this.sin[k];
          const ti = re[r] * this.sin[k] + im[r] * this.cos[k];
          re[r] = re[l] - tr; im[r] = im[l] - ti;
          re[l] += tr; im[l] += ti;
        }
      }
    }
  }
}

/** Blackman window, matching what AnalyserNode applies before its FFT. */
export function blackman(n) {
  const w = new Float32Array(n), a0 = 0.42, a1 = 0.5, a2 = 0.08;
  for (let i = 0; i < n; i++) w[i] = a0 - a1 * Math.cos(2 * Math.PI * i / (n - 1)) + a2 * Math.cos(4 * Math.PI * i / (n - 1));
  return w;
}
