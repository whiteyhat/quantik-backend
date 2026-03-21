/** Convert an unknown value to a finite number, or return null. */
export function toFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
