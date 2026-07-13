export function capitalize(s: string): string {
  return s; // BUG: should return s[0].toUpperCase() + s.slice(1)
}
