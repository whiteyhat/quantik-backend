export function applyLongshotBias(price: number): number {
  if (price < 0.15) return price * 0.75;
  if (price > 0.75) return price * 1.08;
  return price;
}
