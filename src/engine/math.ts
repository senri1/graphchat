export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function hypot2(dx: number, dy: number): number {
  return Math.hypot(dx, dy);
}

export function roundTo(n: number, decimals: number): number {
  const p = 10 ** Math.max(0, Math.min(12, Math.floor(decimals)));
  return Math.round(n * p) / p;
}

export function chooseNiceStep(target: number): number {
  const t = Math.max(1e-9, Math.abs(target));
  const pow10 = 10 ** Math.floor(Math.log10(t));
  const unit = t / pow10;
  const candidates = [1, 2, 5, 10];
  let best = candidates[0];
  let bestErr = Math.abs(unit - best);
  for (const c of candidates) {
    const err = Math.abs(unit - c);
    if (err < bestErr) {
      best = c;
      bestErr = err;
    }
  }
  return best * pow10;
}
