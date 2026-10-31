import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function make(paths: ReactNode) {
  return function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
        {paths}
      </svg>
    );
  };
}

export const IconPlus = make(<><path d="M12 5v14" /><path d="M5 12h14" /></>);
export const IconFolder = make(<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />);
export const IconFile = make(<><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10z" /><path d="M14 3.5v5h5" /></>);
export const IconSearch = make(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>);
export const IconSettings = make(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>);
export const IconStop = make(<rect x="6.5" y="6.5" width="11" height="11" rx="2" />);
export const IconRetry = make(<><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>);
export const IconReset = make(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>);
export const IconSend = make(<><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>);
export const IconCheck = make(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconX = make(<><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>);
export const IconChevronRight = make(<path d="m9 6 6 6-6 6" />);
export const IconChevronDown = make(<path d="m6 9 6 6 6-6" />);
export const IconPanelRight = make(<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M14.5 4.5v15" /></>);
export const IconPanelLeft = make(<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9.5 4.5v15" /></>);
export const IconTerminal = make(<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="m7.5 9.5 3 2.5-3 2.5" /><path d="M12.5 15h4" /></>);
export const IconEye = make(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>);
export const IconPencil = make(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>);
export const IconListTree = make(<><path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><circle cx="4" cy="6" r=".8" /><circle cx="4" cy="12" r=".8" /><circle cx="4" cy="18" r=".8" /></>);
export const IconShield = make(<><path d="M12 3.5 5 6v5.5c0 4.3 3 7.7 7 9 4-1.3 7-4.7 7-9V6z" /><path d="m9 12 2 2 4-4" /></>);
export const IconLock = make(<><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>);
export const IconDiff = make(<><path d="M6 3.5v11" /><path d="M2.5 7h7" /><path d="M14.5 17h7" /><path d="M18 9.5v11" /></>);
export const IconSparkle = make(<path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5zM18.5 15.5c.3 1.6 1 2.3 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.2 2.2-.9 2.5-2.5z" />);
export const IconFlask = make(<><path d="M9.5 3.5h5" /><path d="M10.5 3.5v6L5 18.5a1.5 1.5 0 0 0 1.3 2.2h11.4a1.5 1.5 0 0 0 1.3-2.2L13.5 9.5v-6" /><path d="M7.5 14.5h9" /></>);
export const IconBox = make(<><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" /><path d="M3.5 7.5 12 12l8.5-4.5" /><path d="M12 12v9" /></>);
export const IconClock = make(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
export const IconGitBranch = make(<><circle cx="6.5" cy="5.5" r="2" /><circle cx="6.5" cy="18.5" r="2" /><circle cx="17.5" cy="7.5" r="2" /><path d="M6.5 7.5v9" /><path d="M17.5 9.5c0 4-5 3.5-9.5 7" /></>);
export const IconCopy = make(<><rect x="8.5" y="8.5" width="12" height="12" rx="2" /><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" /></>);
export const IconAlert = make(<><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4" /><path d="M12 17h.01" /></>);
export const IconInfo = make(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5" /><path d="M12 8h.01" /></>);
export const IconCommand = make(<path d="M9 6.5a2.5 2.5 0 1 0-2.5 2.5H17.5A2.5 2.5 0 1 0 15 6.5v11a2.5 2.5 0 1 0 2.5-2.5h-11A2.5 2.5 0 1 0 9 17.5z" />);
export const IconDot = make(<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />);
export const IconMoon = make(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />);
export const IconArchive = make(<><rect x="3.5" y="4.5" width="17" height="4" rx="1" /><path d="M5 8.5v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9" /><path d="M10 12.5h4" /></>);

export const IconCompose = make(<><path d="M12 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V12" /><path d="M17.6 3.9a1.9 1.9 0 0 1 2.7 2.7L12.5 14.4 9 15l.6-3.5z" /></>);
export const IconChat = make(<path d="M5.5 18.5 4 21l3.8-1.4A8.5 8.5 0 1 0 4 12.5a8.4 8.4 0 0 0 1.5 6z" />);
export const IconPaperclip = make(<path d="m20 11.5-7.7 7.7a5 5 0 0 1-7.1-7.1l8.1-8.1a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" />);
export const IconPuzzle = make(<path d="M9.5 4.5a2 2 0 1 1 4 0v1h4a1 1 0 0 1 1 1v4h-1a2 2 0 1 0 0 4h1v4a1 1 0 0 1-1 1h-4v-1a2 2 0 1 0-4 0v1h-4a1 1 0 0 1-1-1v-4h1a2 2 0 1 0 0-4h-1v-4a1 1 0 0 1 1-1h4z" />);
export const IconTarget = make(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r=".8" fill="currentColor" /></>);
export const IconLaptop = make(<><rect x="4.5" y="5.5" width="15" height="10" rx="1.5" /><path d="M2.5 18.5h19" /></>);
export const IconPalette = make(<><path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-1 .8-1.7 1.9-1.7h2a3.8 3.8 0 0 0 3.8-3.8c0-4.1-3.8-7.2-8.5-7.2z" /><circle cx="7.8" cy="11" r=".9" fill="currentColor" /><circle cx="10.5" cy="7.5" r=".9" fill="currentColor" /><circle cx="15" cy="7.8" r=".9" fill="currentColor" /></>);
export const IconKey = make(<><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.7-8.7" /><path d="m16.5 6.5 2.5 2.5" /><path d="m14 9 2 2" /></>);
export const IconSliders = make(<><path d="M4 7h9" /><path d="M17 7h3" /><circle cx="15" cy="7" r="2" /><path d="M4 17h3" /><path d="M11 17h9" /><circle cx="9" cy="17" r="2" /></>);
export const IconChart = make(<><path d="M4 20h16" /><path d="M7 16.5v-5" /><path d="M12 16.5v-10" /><path d="M17 16.5v-7" /></>);
export const IconBell = make(<><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>);
export const IconMic = make(<><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v2.5" /></>);
export const IconWrench = make(<path d="M14.5 6.5a4 4 0 0 0 5 5l-8.7 8.7a2.1 2.1 0 0 1-3-3L16.5 8.5a4 4 0 0 1-2-2zM14.5 6.5l3-3a4 4 0 0 0-3 3z" />);
export const IconMore = make(<><circle cx="6" cy="12" r="1.1" fill="currentColor" /><circle cx="12" cy="12" r="1.1" fill="currentColor" /><circle cx="18" cy="12" r="1.1" fill="currentColor" /></>);
export const IconFolderPlus = make(<><path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M12 11v5" /><path d="M9.5 13.5h5" /></>);
export const IconGauge = make(<><path d="M4.2 16.5a8.5 8.5 0 1 1 15.6 0" /><path d="m12 13 3.5-4" /><circle cx="12" cy="13.5" r="1.2" /></>);

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.4" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
