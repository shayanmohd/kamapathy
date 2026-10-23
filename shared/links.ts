// Help pages Kamapathy opens. Only these fixed addresses reach the help
// links, and they open in a personal space no agent can reach.
export const HELP_URL = "https://kamapathy.app/#faq";
export const AGENT_GUIDE_URL =
  "https://github.com/shayanmohd/kamapathy/blob/main/docs/automation.md";
export const PRIVACY_URL = "https://kamapathy.app/#privacy";
export const ISSUES_URL = "https://github.com/shayanmohd/kamapathy/issues/new";

// The pages the window's help actions open.
export const HELP_LINKS: Readonly<
  Record<"help" | "report-issue" | "privacy", string>
> = {
  help: HELP_URL,
  "report-issue": ISSUES_URL,
  privacy: PRIVACY_URL,
};
