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

export const ScriptsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5L14.5 3Z" />
    <path d="M14 3v5h5" />
    <path d="m9.5 13-2 2 2 2" />
    <path d="m14.5 13 2 2-2 2" />
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

export const TrashIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="m6 7 1 13h10l1-13" />
    <path d="M10 11v5" />
    <path d="M14 11v5" />
  </Icon>
);

export const ExternalLinkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 4h6v6" />
    <path d="m20 4-9 9" />
    <path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
  </Icon>
);
