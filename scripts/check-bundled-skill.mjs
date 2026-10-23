// CI step "Verify bundled skill": the skill packaged in the app's resources
// equals skills/kamapathy file for file.
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const RESOURCES = [
  "release/mac-arm64/Kamapathy.app/Contents/Resources",
  "release/mac/Kamapathy.app/Contents/Resources",
  "release/win-unpacked/resources",
  "release/linux-unpacked/resources",
];

// Files and links by relative path. Packaging leaves out .DS_Store files, so
// they are skipped here too.
async function entries(folder, relative = "", found = new Map()) {
  const items = await readdir(join(folder, relative), { withFileTypes: true });
  for (const item of items) {
    if (item.name === ".DS_Store") continue;
    const path = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) await entries(folder, path, found);
    else found.set(path, item.isFile() ? "file" : "link");
  }
  return found;
}

/**
 * @param {string} expected
 * @param {string} actual
 * @returns {Promise<string[]>} each "<relative path>: missing | extra | differs | link"
 */
export async function compareSkillFolders(expected, actual) {
  const [want, have] = await Promise.all([entries(expected), entries(actual)]);
  const problems = [];
  for (const path of [...new Set([...want.keys(), ...have.keys()])].sort()) {
    const wanted = want.get(path);
    const found = have.get(path);
    if (wanted === "link" || found === "link") problems.push(`${path}: link`);
    else if (!found) problems.push(`${path}: missing`);
    else if (!wanted) problems.push(`${path}: extra`);
    else if (
      !(await readFile(join(expected, path))).equals(
        await readFile(join(actual, path)),
      )
    )
      problems.push(`${path}: differs`);
  }
  return problems;
}

async function main() {
  const resources = RESOURCES.map((path) => join(root, path)).find((path) =>
    existsSync(path),
  );
  if (!resources) {
    console.error(`No packaged app found. Looked for ${RESOURCES.join(", ")}.`);
    return 1;
  }
  const skill = join(root, "skills", "kamapathy");
  const problems = await compareSkillFolders(
    skill,
    join(resources, "skills", "kamapathy"),
  );
  for (const problem of problems) console.error(problem);
  if (problems.length) return 1;
  console.log(
    `Bundled skill matches skills/kamapathy (${(await entries(skill)).size} files).`,
  );
  return 0;
}

function startedDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (startedDirectly()) process.exitCode = await main();
