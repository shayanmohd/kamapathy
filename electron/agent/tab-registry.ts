import { agentRules } from "../../shared/state";
import type {
  BrowserState,
  ClosedBy,
  ControlReason,
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
// What changed while the person had control: tabs opened and labels
// retired since control left the agent, and the tab the space shows.
export interface Boundary {
  active: Tab | null;
  opened: Tab[];
  closed: string[];
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
// so a caller can tell which labels closed after a given point. `mark` holds
// the tabs and count from when control left the agent, and `last` what
// changed until it came back.
interface SpaceRecord {
  nextLabel: number;
  retired: number;
  closed: (ClosedLabel & { sequence: number })[];
  mark?: { tabs: Set<string>; retired: number };
  last?: { opened: string[]; closed: string[] };
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

  // Gives the person control. When the agent had it, this is where the next
  // boundary starts; otherwise only the reason changes.
  handOver(
    spaceId: string,
    control: { reason: ControlReason; prompt?: string; hold?: string },
  ): void {
    const space = this.space(spaceId);
    if (space.owner === "agent") {
      const record = this.record(spaceId);
      record.mark = {
        tabs: new Set(
          this.state()
            .tabs.filter((tab) => tab.spaceId === spaceId)
            .map((tab) => tab.id),
        ),
        retired: record.retired,
      };
      delete record.last;
    }
    space.owner = "human";
    space.control = {
      reason: control.reason,
      ...(control.prompt === undefined ? {} : { prompt: control.prompt }),
      since: this.now(),
      ...(control.hold === undefined ? {} : { hold: control.hold }),
    };
  }

  // Gives the agent control and returns what changed meanwhile. Taking back
  // control the agent already has changes nothing.
  takeBack(spaceId: string, active: Tab | null): Boundary {
    const space = this.space(spaceId);
    if (space.owner === "agent") return this.lastBoundary(spaceId, active);
    const record = this.record(spaceId);
    const mark = record.mark ?? { tabs: new Set<string>(), retired: 0 };
    record.last = {
      opened: this.state()
        .tabs.filter((tab) => tab.spaceId === spaceId && !mark.tabs.has(tab.id))
        .map((tab) => tab.id),
      closed: record.closed
        .filter((item) => item.sequence > mark.retired)
        .map((item) => item.label),
    };
    delete record.mark;
    space.owner = "agent";
    delete space.control;
    return this.lastBoundary(spaceId, active);
  }

  // The boundary of the last time control came back, listing only tabs
  // still open, until control leaves again.
  lastBoundary(spaceId: string, active: Tab | null): Boundary {
    const last = this.spaces.get(spaceId)?.last;
    const opened = new Set(last?.opened);
    return {
      active,
      opened: this.state().tabs.filter((tab) => opened.has(tab.id)),
      closed: [...(last?.closed ?? [])],
    };
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

  private space(spaceId: string) {
    const space = this.state().spaces.find((item) => item.id === spaceId);
    if (!space) throw new Error("Space was not found.");
    return space;
  }

  private nextLabel(spaceId: string): string {
    return `p${this.record(spaceId).nextLabel++}`;
  }

  private publish(event: RegistryEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
