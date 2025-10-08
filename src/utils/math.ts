export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function snap(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize;
}
