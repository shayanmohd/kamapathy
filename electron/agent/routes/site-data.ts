import { send, type RouteDeps, type RouteImpl } from "../http";
import { clearSiteDataFields } from "../validate";

// POST /tabs/:id/clear-site-data: one origin's cookies, storage or cache.
// It runs none of the agent's code in the page, so the Page scripts switch
// leaves it alone.
export function siteDataRoutes(deps: RouteDeps): Record<string, RouteImpl> {
  const { siteData } = deps;
  return {
    "POST /tabs/:id/clear-site-data": {
      handler: async ({ response, body, tab, run }) =>
        send(
          response,
          200,
          await siteData.clear(
            tab!.id,
            clearSiteDataFields(body!, tab!.url),
            run,
          ),
        ),
    },
  };
}
