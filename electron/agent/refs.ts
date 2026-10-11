// API restarts in the same app process must not recycle an old element ref.
let nextElementReference = 1;

export function allocateRefs(): number {
  const firstRef = nextElementReference;
  nextElementReference += 100;
  return firstRef;
}
