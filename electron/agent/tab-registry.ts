import { agentRules } from "../../shared/state";
import type {
  BrowserState,
  ClosedBy,
  OpenedBy,
  Tab,
} from "../../shared/types";

export interface TabOrigin {
  openedBy: OpenedBy;
  openerId?: string;
  managed: boolean;
}
export interface ClosedLabel {
  label: string;
  closedBy: ClosedBy;
  at: number;
}
export type RegistryEvent =
  | {
      type: "opened";
      spaceId: string;
      tabId: string;
      label?: string;
      openedBy: OpenedBy;
      openerId?: string;
    }
  | {
      type: "closed";
      spaceId: string;
      tabId: string;
      label?: string;
      closedBy: ClosedBy;
    };

const CLOSED_LABELS = 100;

// What the registry keeps for a space during this app run. `retired` counts
// the labels the space has retired, and each closed entry keeps its count,
// so a caller can tell which labels closed after a given point.
interface SpaceRecord {
  nextLabel: number;
  retired: number;
  closed: (ClosedLabel & { sequence: number })[];
}

// Origins, managed flags and labels of tabs. Labels count per space in the
// order tabs appear and are never reused while the app runs; nothing here is
// saved.
export class TabRegistry {
  private spaces = new Map<string, SpaceRecord>();
  private listeners = new Set<(event: RegistryEvent) => void>();

  constructor(
    private readonly state: () => BrowserState,
    private readonly now: () => number = Date.now,
  ) {}

  // Call before the tab joins the state, so view listeners already see its
  // origin and managed flag.
  register(tab: Tab, origin: TabOrigin): void {
    tab.createdAt ??= this.now();
    tab.openedBy = origin.openedBy;
    if (origin.openerId) tab.openerId = origin.openerId;
    tab.managed = origin.managed;
    const space = this.state().spaces.find((item) => item.id === tab.spaceId);
    if (space && agentRules(space)) {
      tab.label = this.nextLabel(tab.spaceId);
      // A popup stays unseen until something reports it to the agent.
      if (origin.openedBy === "page") tab.unseen = true;
    }
    this.publish({
      type: "opened",
      spaceId: tab.spaceId,
      tabId: tab.id,
      ...(tab.label ? { label: tab.label } : {}),
      openedBy: origin.openedBy,
      ...(origin.openerId ? { openerId: origin.openerId } : {}),
    });
  }

  // Labels the space's unlabeled tabs in tab-strip order, pinned tabs first.
  labelSpace(spaceId: string): void {
    const tabs = this.state().tabs.filter((tab) => tab.spaceId === spaceId);
    for (const tab of [
      ...tabs.filter((tab) => tab.pinned),
      ...tabs.filter((tab) => !tab.pinned),
    ])
      tab.label ??= this.nextLabel(spaceId);
  }

  setManaged(tab: Tab, managed: boolean): void {
    tab.managed = managed;
  }

  // Call before the tab leaves the state. Only labeled tabs are remembered.
  retire(tab: Tab, closedBy: ClosedBy): void {
    if (tab.label) {
      const record = this.record(tab.spaceId);
      record.retired += 1;
      record.closed.push({
        label: tab.label,
        closedBy,
        at: this.now(),
        sequence: record.retired,
      });
      if (record.closed.length > CLOSED_LABELS) record.closed.shift();
    }
    this.publish({
      type: "closed",
      spaceId: tab.spaceId,
      tabId: tab.id,
      ...(tab.label ? { label: tab.label } : {}),
      closedBy,
    });
  }

  // The space's last 100 retired labels, oldest first.
  closed(spaceId: string): ClosedLabel[] {
    return (this.spaces.get(spaceId)?.closed ?? []).map(
      ({ label, closedBy, at }) => ({ label, closedBy, at }),
    );
  }

  // Managed tabs are the ones that count toward a space's page budget.
  used(spaceId: string): number {
    return this.state().tabs.filter(
      (tab) => tab.spaceId === spaceId && tab.managed,
    ).length;
  }

  on(listener: (event: RegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // A deleted space's counter and retired labels go with it.
  forget(spaceId: string): void {
    this.spaces.delete(spaceId);
  }

  private record(spaceId: string): SpaceRecord {
    let record = this.spaces.get(spaceId);
    if (!record) {
      record = { nextLabel: 1, retired: 0, closed: [] };
      this.spaces.set(spaceId, record);
    }
    return record;
  }

  private nextLabel(spaceId: string): string {
    return `p${this.record(spaceId).nextLabel++}`;
  }

  private publish(event: RegistryEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
