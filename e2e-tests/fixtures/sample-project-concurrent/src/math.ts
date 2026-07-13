export function add(a: number, b: number): number {
  return a - b; // BUG: should be a + b
}
