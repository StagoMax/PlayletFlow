import type { SVGProps } from "react";

const glyphs = {
  "chevron-down": <path d="m7 10 5 5 5-5" />,
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  "square-pen": <><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3L12 15l-4 1 1-4z" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  film: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 5v14M17 5v14M3 9h4m10 0h4M3 15h4m10 0h4" /></>,
  sparkles: <><path d="m12 3 1.1 3.3a4 4 0 0 0 2.6 2.6L19 10l-3.3 1.1a4 4 0 0 0-2.6 2.6L12 17l-1.1-3.3a4 4 0 0 0-2.6-2.6L5 10l3.3-1.1a4 4 0 0 0 2.6-2.6L12 3Z" /><path d="m19 16 .5 1.5L21 18l-1.5.5L19 20l-.5-1.5L17 18l1.5-.5L19 16Z" /></>,
  "file-text": <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
  folder: <path d="M3 6h7l2 2h9v11H3z" />,
  save: <><path d="M5 3h12l2 2v16H5z" /><path d="M8 3v6h8V3M8 21v-7h8v7" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m4 17 5-5 4 4 2-2 5 5" /></>,
  play: <><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4z" /></>,
  pause: <><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></>,
  box: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="m4.5 7.5 7.5 4 7.5-4M12 11.5V21" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 9A7 7 0 0 1 18 6l2 6M18 15a7 7 0 0 1-11.9 3L4 12" /></>,
  alert: <><path d="M10.3 4.3 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 3h.01" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  send: <><path d="m4 4 17 8-17 8 3-8z" /><path d="M7 12h14" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />,
  "arrow-down": <path d="M12 4v15M6.5 13.5 12 19l5.5-5.5" />,
} as const;

export type IconName = keyof typeof glyphs;
export type IconProps = SVGProps<SVGSVGElement> & { name: IconName };

/**
 * Stable Fast Refresh boundary for the shared icon set. Adding a glyph changes
 * data inside this component instead of changing the module's runtime exports.
 */
export function Icon({ name, ...props }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {glyphs[name]}
    </svg>
  );
}
