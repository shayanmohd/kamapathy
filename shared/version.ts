// Release versions are plain x.y.z numbers, compared part by part.
export const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

export function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) return null;
  const [major, minor, patch] = value.split(".").map(Number);
  return [major, minor, patch];
}

export function isVersion(value: unknown): value is string {
  return parseVersion(value) !== null;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [left, right] = [a, b].map((value) => {
    const parts = parseVersion(value);
    if (!parts) throw new RangeError(`Invalid version: ${value}`);
    return parts;
  });
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index])
      return left[index] > right[index] ? 1 : -1;
  return 0;
}
