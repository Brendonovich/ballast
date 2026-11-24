import type { JSX } from "solid-js";

export interface IconProps {
  readonly size?: number;
  readonly class?: string;
}

const Icon = (props: IconProps & { readonly children: JSX.Element }): JSX.Element => (
  <svg
    width={props.size ?? 14}
    height={props.size ?? 14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class={props.class}
  >
    {props.children}
  </svg>
);

export const ProjectsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    <path d="M3 11h18" />
  </Icon>
);

export const ConnectionsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 7V4" />
    <path d="M15 7V4" />
    <path d="M7 7h10v4a5 5 0 0 1-10 0V7Z" />
    <path d="M12 16v4" />
  </Icon>
);

export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h10" />
    <path d="M18 7h2" />
    <path d="M4 17h2" />
    <path d="M10 17h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="17" r="2" />
  </Icon>
);

export const CodeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m8 8-4 4 4 4" />
    <path d="m16 8 4 4-4 4" />
    <path d="m13.5 5-3 14" />
  </Icon>
);

export const WorkspaceIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
    <path d="M9 13h12" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
);

export const PlayIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m8 5 11 7-11 7V5Z" />
  </Icon>
);

export const StopIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </Icon>
);

export const RefreshIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 6v5h-5" />
    <path d="M4 18v-5h5" />
    <path d="M6.1 9A7 7 0 0 1 18.6 7.4L20 11" />
    <path d="M17.9 15A7 7 0 0 1 5.4 16.6L4 13" />
  </Icon>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const ArrowLeftIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m15 18-6-6 6-6" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 6 12 12" />
    <path d="M18 6 6 18" />
  </Icon>
);

export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </Icon>
);

export const AlertIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3 2.5 20h19L12 3Z" />
    <path d="M12 9v5" />
    <path d="M12 17.2v.1" />
  </Icon>
);

export const ErrorIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5" />
    <path d="M12 16.4v.1" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const TrashIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="m6 7 1 13h10l1-13" />
    <path d="M10 11v5" />
    <path d="M14 11v5" />
  </Icon>
);

export const MaximizeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 4H4v5" />
    <path d="M15 4h5v5" />
    <path d="M9 20H4v-5" />
    <path d="M15 20h5v-5" />
  </Icon>
);

export const MinimizeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 9h5V4" />
    <path d="M20 9h-5V4" />
    <path d="M4 15h5v5" />
    <path d="M20 15h-5v5" />
  </Icon>
);

export const PanelRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </Icon>
);

export const ArrowDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14" />
    <path d="m6 13 6 6 6-6" />
  </Icon>
);

export const MoreIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </Icon>
);

export const ExternalLinkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 4h6v6" />
    <path d="m20 4-9 9" />
    <path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
  </Icon>
);
