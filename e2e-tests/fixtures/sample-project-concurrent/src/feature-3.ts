export function greet(name: string): string {
  return name; // BUG: should return "Hello, " + name + "!"
}
