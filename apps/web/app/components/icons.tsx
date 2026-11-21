import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const PlusIcon = (p: IconProps) => <Icon {...p}><path d="M8 3v10M3 8h10" /></Icon>;
export const XIcon = (p: IconProps) => <Icon {...p}><path d="M4 4l8 8M12 4l-8 8" /></Icon>;
export const CheckIcon = (p: IconProps) => <Icon {...p}><path d="M3.5 8.5l3 3 6-7" /></Icon>;
export const ChevronDownIcon = (p: IconProps) => <Icon {...p}><path d="M4 6l4 4 4-4" /></Icon>;
export const ReasoningIcon = (p: IconProps) => <Icon {...p}><path d="M4 12.5v-2M8 12.5v-5M12 12.5v-8" /></Icon>;
export const ArrowDownIcon = (p: IconProps) => <Icon {...p}><path d="M8 3v10M4 9l4 4 4-4" /></Icon>;
export const ArrowUpIcon = (p: IconProps) => <Icon {...p}><path d="M8 13V3M4 7l4-4 4 4" /></Icon>;
export const StopIcon = (p: IconProps) => (
  <Icon {...p}><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" /></Icon>
);
export const DotsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
  </Icon>
);
export const PencilIcon = (p: IconProps) => <Icon {...p}><path d="M10.5 2.5l3 3-8 8H2.5v-3l8-8z" /></Icon>;
export const TrashIcon = (p: IconProps) => (
  <Icon {...p}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4" /></Icon>
);
export const DownloadIcon = (p: IconProps) => <Icon {...p}><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" /></Icon>;
export const EyeIcon = (p: IconProps) => (
  <Icon {...p}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></Icon>
);
export const BookmarkIcon = (p: IconProps) => <Icon {...p}><path d="M4 2.5h8v11L8 10.5l-4 3v-11z" /></Icon>;
export const CopyIcon = (p: IconProps) => (
  <Icon {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></Icon>
);
export const RefreshIcon = (p: IconProps) => (
  <Icon {...p}><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3.3H9.7" /></Icon>
);
export const PaperclipIcon = (p: IconProps) => (
  <Icon {...p}><path d="M13 7.5l-5.3 5.3a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.2 11.3a1.1 1.1 0 0 1-1.5-1.5L9.8 4.7" /></Icon>
);
export const KeyIcon = (p: IconProps) => <Icon {...p}><circle cx="5.5" cy="10.5" r="2.5" /><path d="M7.3 8.7L13.5 2.5M11 5l1.8 1.8" /></Icon>;
export const SearchIcon = (p: IconProps) => <Icon {...p}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></Icon>;
export const MenuIcon = (p: IconProps) => <Icon {...p}><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" /></Icon>;
export const InfoIcon = (p: IconProps) => <Icon {...p}><circle cx="8" cy="8" r="6" /><path d="M8 7.3v3.7M8 5v.1" /></Icon>;
export const ClockIcon = (p: IconProps) => <Icon {...p}><circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2.2 1.4" /></Icon>;
export const RulesIcon = (p: IconProps) => (
  <Icon {...p}><path d="M4 2.5h6l2.5 2.5v8.5H4v-11z" /><path d="M6 8h4.5M6 10.5h3" /></Icon>
);
export const ChatIcon = (p: IconProps) => (
  <Icon {...p}><path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11A1.5 1.5 0 0 1 2.5 9.5V4z" /></Icon>
);
export const AlertIcon = (p: IconProps) => <Icon {...p}><circle cx="8" cy="8" r="6" /><path d="M8 4.8v3.8M8 11v.1" /></Icon>;
export const ToolIcon = (p: IconProps) => (
  <Icon {...p}><path d="M9.5 2.5a3 3 0 0 0-2.9 3.8L2.5 10.4a1.4 1.4 0 0 0 2 2l4.1-4.1a3 3 0 0 0 3.8-2.9l-1.9 1.1-1.6-.4-.4-1.6 1.1-1.9z" /></Icon>
);
export const ImageIcon = (p: IconProps) => (
  <Icon {...p}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1" /><path d="M13.5 10.5l-3-3-6 5.5" /></Icon>
);
export const SparkIcon = (p: IconProps) => (
  <Icon {...p}><path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3L8 2.5z" /></Icon>
);
export const FileIcon = (p: IconProps) => (
  <Icon {...p}><path d="M4 2.5h5l3 3v8H4v-11z" /><path d="M9 2.5v3h3" /></Icon>
);
