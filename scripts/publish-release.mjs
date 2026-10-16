import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.BUILD_RUN_ID;
assert.match(repository || "", /^[\w.-]+\/[\w.-]+$/);
assert.match(runId || "", /^\d+$/);
const gh = (...args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const api = (path) => JSON.parse(gh("api", `repos/${repository}/${path}`));
const run = api(`actions/runs/${runId}`);
assert.equal(run.status, "completed");
assert.equal(run.conclusion, "success");
assert.equal(run.path, ".github/workflows/build.yml");
assert.equal(run.head_repository.full_name, repository);
assert.ok(["push", "workflow_dispatch"].includes(run.event));
assert.ok(["main", "master"].includes(run.head_branch));
assert.match(run.head_sha, /^[a-f0-9]{40}$/);
const targets = new Map([
  ["macOS Apple Silicon", "Kamapathy-mac-arm64"],
  ["macOS Intel", "Kamapathy-mac-x64"],
  ["Windows x64", "Kamapathy-win-x64"],
  ["Linux x64", "Kamapathy-linux-x64"],
]);
const jobs = api(`actions/runs/${runId}/jobs?per_page=100`).jobs;
for (const name of targets.keys()) {
  const job = jobs.find((entry) => entry.name === name);
  assert.equal(job?.conclusion, "success", `Missing successful job: ${name}`);
  const linux = name === "Linux x64";
  // Once releases are signed, the macOS and Windows builds must prove it.
  const signed = !linux && process.env.KAMAPATHY_SIGNED_RELEASES === "true";
  for (const stepName of [
    "Validate types, behavior, and copy",
    "Compile desktop app",
    linux
      ? "Smoke test desktop on Linux"
      : "Smoke test desktop on macOS and Windows",
    linux
      ? "Verify native Kamapathy identity on Linux"
      : "Verify native Kamapathy identity on macOS and Windows",
    linux
      ? "Test Kamapathy skill on Linux"
      : "Test Kamapathy skill on macOS and Windows",
    "Package native desktop app",
    ...(signed ? ["Verify signatures"] : []),
    "Verify bundled skill",
    "Upload installable artifacts",
  ])
    assert.equal(
      job.steps.find((step) => step.name === stepName)?.conclusion,
      "success",
      `${name}: ${stepName}`,
    );
}

if (process.argv[2] === "validate") {
  assert.ok(process.env.GITHUB_OUTPUT);
  appendFileSync(process.env.GITHUB_OUTPUT, `sha=${run.head_sha}\n`);
  console.log(`Verified all four native jobs at ${run.head_sha}.`);
} else if (process.argv[2] === "publish") {
  const source = resolve("reviewed-source");
  assert.equal(
    execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    run.head_sha,
  );
  const { version } = JSON.parse(
    readFileSync(join(source, "package.json"), "utf8"),
  );
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const tag = `v${version}`;
  const releases = api("releases?per_page=100");
  const release = releases.find((entry) => entry.tag_name === tag);
  assert.ok(
    release?.draft,
    "Create a draft release with reviewed notes before publishing.",
  );
  assert.equal(
    release.target_commitish,
    run.head_sha,
    "Draft must target the exact reviewed commit.",
  );
  assert.ok(release.body?.trim(), "Draft release notes are required.");
  const refs = api(`git/matching-refs/tags/${tag}`);
  if (refs.some((ref) => ref.ref === `refs/tags/${tag}`))
    assert.equal(
      api(`commits/${tag}`).sha,
      run.head_sha,
      "Existing tag targets another commit.",
    );

  const stage = resolve("release-stage");
  mkdirSync(stage, { recursive: true });
  const expected = new Set([
    `Kamapathy-${version}-mac-arm64.dmg`,
    `Kamapathy-${version}-mac-arm64.zip`,
    `Kamapathy-${version}-mac-x64.dmg`,
    `Kamapathy-${version}-mac-x64.zip`,
    `Kamapathy-${version}-windows-x64-setup.exe`,
    `Kamapathy-${version}-windows-x64-portable.exe`,
    `Kamapathy-${version}-linux-amd64.deb`,
    `Kamapathy-${version}-linux-x86_64.AppImage`,
  ]);
  for (const artifact of targets.values()) {
    const directory = resolve("release-artifacts", artifact);
    gh(
      "run",
      "download",
      runId,
      "--repo",
      repository,
      "--name",
      artifact,
      "--dir",
      directory,
    );
    for (const name of readdirSync(directory)) {
      assert.ok(expected.has(name), `Unexpected artifact: ${name}`);
      assert.ok(statSync(join(directory, name)).isFile());
      assert.ok(statSync(join(directory, name)).size > 1024 * 1024);
      copyFileSync(join(directory, name), join(stage, name));
    }
  }
  assert.deepEqual(
    new Set(readdirSync(stage)),
    expected,
    "Native artifact set is incomplete.",
  );
  const skill = `Kamapathy-skill-${version}.zip`;
  execFileSync(
    "python3",
    [
      "-c",
      `
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import sys
root = Path(sys.argv[1]) / 'skills'
with ZipFile(sys.argv[2], 'w', ZIP_DEFLATED) as archive:
    for path in sorted((root / 'kamapathy').rglob('*')):
        if path.is_file(): archive.write(path, path.relative_to(root))
for path in Path(sys.argv[2]).parent.glob('*.zip'):
    with ZipFile(path) as archive:
        assert archive.testzip() is None, path
`,
      source,
      join(stage, skill),
    ],
    { stdio: "inherit" },
  );
  expected.add(skill);
  const hashes = new Map(
    [...expected].sort().map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(join(stage, name)))
        .digest("hex"),
    ]),
  );
  writeFileSync(
    join(stage, "SHA256SUMS.txt"),
    [...hashes].map(([name, hash]) => `${hash}  ${name}\n`).join(""),
  );
  expected.add("SHA256SUMS.txt");
  hashes.set(
    "SHA256SUMS.txt",
    createHash("sha256")
      .update(readFileSync(join(stage, "SHA256SUMS.txt")))
      .digest("hex"),
  );
  assert.ok(
    release.assets.every((asset) => expected.has(asset.name)),
    "Draft contains unrelated assets.",
  );
  for (const name of expected) {
    // Only replace known files in this unpublished draft, never published assets.
    const current = api(`releases/${release.id}`);
    assert.ok(current.draft && current.target_commitish === run.head_sha);
    const asset = current.assets.find((entry) => entry.name === name);
    if (
      asset?.state === "uploaded" &&
      asset.digest === `sha256:${hashes.get(name)}`
    )
      continue;
    gh(
      "release",
      "upload",
      tag,
      join(stage, name),
      "--repo",
      repository,
      "--clobber",
    );
    console.log(`Uploaded ${name}.`);
  }
  const uploaded = api(`releases/${release.id}`);
  assert.ok(uploaded.draft && uploaded.target_commitish === run.head_sha);
  assert.deepEqual(
    new Set(uploaded.assets.map((asset) => asset.name)),
    expected,
  );
  for (const asset of uploaded.assets) {
    assert.equal(asset.state, "uploaded");
    assert.equal(asset.size, statSync(join(stage, asset.name)).size);
    assert.equal(
      asset.digest,
      `sha256:${hashes.get(asset.name)}`,
      `Checksum mismatch: ${asset.name}`,
    );
  }
  gh(
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    "--prerelease",
  );
  console.log(`Published ${tag} from verified build ${runId}.`);
} else throw new Error("Use validate or publish.");
