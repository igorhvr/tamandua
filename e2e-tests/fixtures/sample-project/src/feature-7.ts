export function strip(s: string): string {
  return s; // BUG: should return s.trim()
}
