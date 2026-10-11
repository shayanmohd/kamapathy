// Writes the API reference from the schema: skills/kamapathy/references/api.md
// and the generated tables in docs/automation.md. A test fails until this runs
// after a schema change.
import { readFile, writeFile } from "node:fs/promises";
import { generateReference } from "../skills/kamapathy/scripts/help.mjs";

const { apiMarkdown, routesBlock, errorsBlock } = generateReference();
await writeFile(
  new URL("../skills/kamapathy/references/api.md", import.meta.url),
  apiMarkdown,
);
const docsUrl = new URL("../docs/automation.md", import.meta.url);
let docs = await readFile(docsUrl, "utf8");
for (const [name, block] of [
  ["routes", routesBlock],
  ["errors", errorsBlock],
]) {
  const start = `<!-- generated:${name} -->`;
  const end = `<!-- /generated:${name} -->`;
  const from = docs.indexOf(start);
  const to = docs.indexOf(end);
  if (from < 0 || to < from)
    throw new Error(`docs/automation.md has no ${start} block.`);
  docs = `${docs.slice(0, from + start.length)}${block}${docs.slice(to)}`;
}
await writeFile(docsUrl, docs);
console.log(
  "Wrote skills/kamapathy/references/api.md and the generated tables in docs/automation.md.",
);
