# Publish a reviewed preview

The desktop build workflow tests and packages four native targets. Publishing is a separate manual operation so a source push does not publish installers.

Before building the version you plan to publish, add its entry to `src/whats-new.ts`. The What's new dialog reads those notes from the app, not from the release, so a version without an entry shows nothing after an update.

1. Review a successful **Build desktop apps** run from this repository's `main` or `master` branch. Record its numeric run ID and full commit SHA.
2. Create a draft release named `vVERSION`, matching that commit's `package.json`. Set the draft target to the full reviewed commit SHA and write the release notes. The draft must contain only the expected Kamapathy installer files, skill ZIP, or checksums.
3. Run **Actions > Publish reviewed draft > Run workflow**, providing that native build run ID.

The publishing job checks the build's repository, workflow, branch, event, commit, overall result, and each target's validation, desktop test, skill test, packaging, and artifact upload steps. It checks out the reviewed commit, downloads the four artifact groups, verifies the complete installer set and ZIP integrity, and packages that commit's Kamapathy skill.

It uploads files to the matching unpublished draft and verifies GitHub's asset sizes and SHA-256 digests before publishing it as a prerelease. It can replace expected files in that draft, which makes a failed upload recoverable. It refuses to modify an already published release, publish incomplete artifacts, or reuse a tag pointing at another commit. Unrelated draft assets cause a failure instead of deletion.

This workflow transfers installers within GitHub's infrastructure, avoiding dependence on a developer device uploading large binaries. It uses a temporary Actions token with repository content write and Actions read access. It does not execute the downloaded installers or request any personal credentials.

## Updates and signing

The installer names `scripts/publish-release.mjs` enforces are an update contract. Kamapathy's updater asks GitHub for the newest release, picks the asset whose name matches this computer's install kind and the release's version, and checks it against that release's `SHA256SUMS.txt` and GitHub's digest. Renaming an asset hides the update from copies already installed, so keep the names as they are.

Every release this workflow publishes reaches everyone. Copies with update checks on find it within a day and offer to download it, there is no staged rollout, and a published release cannot be recalled, so publish only a build that has been run on each platform.

Signing is configured and dormant. `electron-builder.signed.yml` holds the macOS identity, notarization and entitlements and the Windows Azure Trusted Signing profile. The build workflow decides to sign when the secrets exist, `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` for macOS or `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` for Windows, and then runs **Verify signatures**. Set the repository variable `KAMAPATHY_SIGNED_RELEASES` to `true` once signing is in place: publishing then requires that step on the macOS and Windows jobs, beside **Test install scripts** and **Verify bundled skill**, which every job must pass.

## The website

[kamapathy.app](https://kamapathy.app) is the static site in `site/`, served by Cloudflare Pages. Deploy it by direct upload with `npx wrangler pages deploy site --project-name kamapathy`, which publishes the folder as it is, or connect this repository to the Pages project with no build command and `site` as the output directory so Pages rebuilds on every push to `main`. Either way, add `kamapathy.app` as the project's custom domain.

Cloudflare keeps CSS, JavaScript and images for up to four hours, at its edge and in browsers, and the tour screenshots in `site/images` for up to seven days. The pages link `styles.css`, `theme.js` and `app.js` with a hash of their contents, and `npm run check` fails until that hash matches, so a changed stylesheet or script gets a new link. Pages ignores the `?v=` part, so a request for a new link before the deploy gets the old file, and Cloudflare keeps that copy under the new link. After a deploy that changes a hash, check each changed link: `curl -s 'https://kamapathy.app/app.js?v=HASH' | shasum -a 256` must print a hash that starts with `HASH`. If it does not, purge that link under **Caching > Configuration > Custom Purge** in the Cloudflare dashboard and check again. A purge clears Cloudflare's copy but not the copy a browser already holds, so save a replaced screenshot under a new name in both themes and change its name in the `tour` list in `site/app.js`. After replacing any other image under an existing name, purge the zone's cache in the Cloudflare dashboard.

The download buttons read the newest published release from the GitHub API and link straight to its files, so publishing a release updates the site without a deploy. If the API is unreachable, the buttons fall back to the releases page.
