export function isEven(n: number): boolean {
  return n % 2 !== 0; // BUG: should be n % 2 === 0
}
