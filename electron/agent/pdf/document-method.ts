import type { TabSession } from "../session/tab-session";

const DOCUMENTS = 64;

// Each document's HTTP method by loaderId, per tab session, so a form
// submission's result is never fetched again. Section 6's NavigationTracker
// replaces this with document.method.
export class DocumentMethods {
  private sessions = new WeakMap<TabSession, Map<string, string>>();

  watch(session: TabSession): () => void {
    const methods = this.methods(session);
    return session.on("Network.requestWillBeSent", (event) => {
      const params = event.params as {
        requestId?: string;
        loaderId?: string;
        type?: string;
        request?: { method?: string };
      };
      const method = params.request?.method;
      // A document's own request has its loaderId for requestId. A redirect
      // hop keeps both, so the last hop's method stays.
      if (
        params.type !== "Document" ||
        !params.loaderId ||
        params.requestId !== params.loaderId ||
        !method
      )
        return;
      methods.set(params.loaderId, method);
      for (const loaderId of methods.keys()) {
        if (methods.size <= DOCUMENTS) break;
        methods.delete(loaderId);
      }
    });
  }

  // Undefined means unknown: a document that loaded before tracking began.
  method(session: TabSession, loaderId: string): string | undefined {
    return this.sessions.get(session)?.get(loaderId);
  }

  private methods(session: TabSession): Map<string, string> {
    let methods = this.sessions.get(session);
    if (!methods) {
      methods = new Map<string, string>();
      this.sessions.set(session, methods);
    }
    return methods;
  }
}
