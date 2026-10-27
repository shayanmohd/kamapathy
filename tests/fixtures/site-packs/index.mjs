// Every page the sample packs are measured against, one module per sample.
import { githubPages } from "./github.mjs";
import { googlePages } from "./google.mjs";
import { xPages } from "./x.mjs";

// Several samples answer the same paths as each other, so a pack's pages sit
// under a prefix of its own, chosen by the host a tool navigates to.
export const sitePackPrefixes = {
  "www.google.com": "/google",
  "google.com": "/google",
  "consent.google.com": "/google",
  "x.com": "/x",
  "twitter.com": "/x",
};

export const sitePackPages = { ...githubPages, ...googlePages, ...xPages };
