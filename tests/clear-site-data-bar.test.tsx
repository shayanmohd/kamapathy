import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClearSiteDataBar } from "../src/components/ClearSiteDataBar";
import type { ClearSiteDataApproval, Space } from "../shared/types";

const space: Space = {
  id: "task",
  name: "Order lunch",
  color: "purple",
  kind: "agent",
  owner: "human",
  signIns: "shared",
  createdAt: 1,
};
function approval(
  fields: Partial<ClearSiteDataApproval> = {},
): ClearSiteDataApproval {
  return {
    id: "a1",
    spaceId: space.id,
    tabId: "t1",
    origin: "https://shop.example.com",
    ...fields,
  };
}
function bar(entry: ClearSiteDataApproval): string {
  return renderToStaticMarkup(
    <ClearSiteDataBar
      approval={entry}
      space={space}
      onAnswer={async () => ""}
    />,
  );
}
// The words the person reads, without the markup around them.
function plain(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}
// The buttons, in the order the bar shows them.
function buttons(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) =>
    plain(match[1]),
  );
}

describe("the clear data bar", () => {
  it("names what goes and who is signed out when cookies are included", () => {
    const markup = bar(
      approval({
        cookies: { count: 3, domains: ["example.com", "shop.example.com"] },
        storage: ["localStorage"],
        cache: true,
      }),
    );
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Order lunch"');
    expect(plain(markup)).toContain("Clear data for shop.example.com?");
    expect(plain(markup)).toContain(
      "An agent in Order lunch wants to clear 3 cookies, site storage and cached files for https://shop.example.com. You'll be signed out of example.com and shop.example.com in every space that shares your sign-ins.",
    );
    // Don't clear comes first, and Clear second.
    expect(buttons(markup)).toEqual(["Don't clear", "Clear"]);
    // One cookie, on a host with a port of its own.
    const local = plain(
      bar(
        approval({
          origin: "http://localhost:3000",
          cookies: { count: 1, domains: ["localhost"] },
        }),
      ),
    );
    expect(local).toContain("Clear data for localhost:3000?");
    expect(local).toContain(
      "An agent in Order lunch wants to clear 1 cookie for http://localhost:3000. You'll be signed out of localhost in",
    );
  });

  it("says sites may forget settings when no cookie would go", () => {
    for (const entry of [
      approval({ storage: ["indexedDB"] }),
      approval({ cache: true, cookies: { count: 0, domains: [] } }),
    ]) {
      const words = plain(bar(entry));
      expect(words).toContain(
        "Sites may forget your settings for https://shop.example.com in every space that shares your sign-ins.",
      );
      expect(words).not.toContain("signed out");
    }
  });
});
