export const UA_PLATFORM = /^Mozilla\/5\.0 \(([^()]+)\)/;

/** Chrome's reduced user agent around the fallback's platform group:
 *  Chrome/<major>.0.0.0, no Electron or app token. A fallback without the
 *  group comes back unchanged, and log hears about it. */
export function chromeUserAgent(
  fallback: string,
  chromeVersion: string,
  log?: (message: string) => void,
): string {
  const platform = UA_PLATFORM.exec(fallback);
  if (!platform) {
    log?.(
      `Kept the user agent ${JSON.stringify(fallback)}: it has no platform group to rebuild.`,
    );
    return fallback;
  }
  const major = chromeVersion.split(".")[0];
  return `Mozilla/5.0 (${platform[1]}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// The platform group Chrome reports on each system, for the identity
// Kamapathy answers about itself before any page is involved.
const UA_GROUPS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  win32: "Windows NT 10.0; Win64; x64",
};

/** The reduced user agent for this computer, with no fallback to rebuild. */
export function reducedUserAgent(
  chromeVersion: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const group = UA_GROUPS[platform] ?? "X11; Linux x86_64";
  return chromeUserAgent(`Mozilla/5.0 (${group})`, chromeVersion);
}
