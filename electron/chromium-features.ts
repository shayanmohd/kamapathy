/** The value for Chromium's --enable-features with name added. Chromium reads
 *  only the last --enable-features, so the features a person or a launcher
 *  passed stay in the list, and an entry of theirs for the same feature, as
 *  "*Name", "Name<Study" or "Name:param/value", stays as they wrote it. */
export function withFeature(list: string, name: string): string {
  const entries = list
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const named = entries.some(
    (entry) => entry.replace(/^\*/, "").split(/[<.:]/)[0] === name,
  );
  return (named ? entries : [...entries, name]).join(",");
}
