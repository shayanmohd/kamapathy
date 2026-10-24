import {
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  X,
  GlobeHemisphereWest,
  GithubLogo,
  FigmaLogo,
  YoutubeLogo,
  BookOpen,
  Terminal,
  Play,
  MagnifyingGlass,
  FileText,
} from "@phosphor-icons/react";
import { hostname, isFileUrl } from "../../shared/url";
import { HOME_URL } from "../../shared/state";
import type { Tab } from "../../shared/types";
import { fileCopy } from "../copy";

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  );
}
export function SiteIcon({ url, size = 20 }: { url: string; size?: number }) {
  if (isFileUrl(url))
    return (
      <span className="file-icon" role="img" aria-label={fileCopy.icon}>
        <FileText size={size} />
      </span>
    );
  const host = hostname(url);
  if (host.includes("github")) return <GithubLogo size={size} weight="fill" />;
  if (host.includes("figma")) return <FigmaLogo size={size} />;
  if (host.includes("youtube"))
    return <YoutubeLogo size={size} weight="fill" />;
  if (host.includes("notion"))
    return (
      <span className="notion-icon" style={{ fontSize: size }}>
        N
      </span>
    );
  if (host.includes("linear"))
    return (
      <span className="linear-icon" style={{ width: size, height: size }} />
    );
  if (host.includes("developer.mozilla")) return <BookOpen size={size} />;
  if (host.includes("localhost")) return <Terminal size={size} />;
  if (host.includes("vimeo")) return <Play size={size} />;
  return <GlobeHemisphereWest size={size} />;
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className = "",
  initialFocus,
  autoFocus = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  // Off when the content focuses its own primary control once it has loaded.
  autoFocus?: boolean;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${className}`}
          onOpenAutoFocus={(event) => {
            if (!autoFocus) {
              event.preventDefault();
              return;
            }
            if (!initialFocus?.current) return;
            event.preventDefault();
            initialFocus.current.focus();
          }}
          {...(!description ? { "aria-describedby": undefined } : {})}
        >
          <div className="modal-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close dialog">
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </div>
          {description && (
            <Dialog.Description className="modal-description">
              {description}
            </Dialog.Description>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function EmptyState({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
export function Favicon({
  tab,
  size = 16,
}: {
  tab: Pick<Tab, "url" | "favicon" | "loading">;
  size?: number;
}) {
  const [failed, setFailed] = useState<string>();
  if (tab.loading)
    return (
      <span
        className="favicon-spinner"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  if (tab.url === HOME_URL) return <MagnifyingGlass size={size} />;
  if (tab.favicon && tab.favicon !== failed)
    return (
      <img
        className="favicon"
        src={tab.favicon}
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(tab.favicon)}
      />
    );
  return <SiteIcon url={tab.url} size={size} />;
}
