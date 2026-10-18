import type { BrowserState, Space } from "../../shared/types";
import { activityTime, spaceActivity } from "../lib/spaces";
import { spacesCopy } from "../copy";
import { Modal } from "./ui";
import "./Spaces.css";

export function ActivityDialog({
  space,
  state,
  onClose,
}: {
  space: Space | undefined;
  state: BrowserState;
  onClose: () => void;
}) {
  const items = space ? spaceActivity(state.activity, space.id) : [];
  return (
    <Modal
      open={!!space}
      onClose={onClose}
      title={space ? spacesCopy.activityTitle(space.name) : ""}
      className="activity-dialog"
    >
      {items.length ? (
        <ol className="activity-entries">
          {items.map((item) => (
            <li key={item.id}>
              <span>
                {item.message}
                {item.agentText && (
                  <>
                    {" "}
                    <span className="agent-text">{item.agentText}</span>
                  </>
                )}
              </span>
              <time>{activityTime(item.time)}</time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="info-note">{spacesCopy.noActivity}</p>
      )}
    </Modal>
  );
}
