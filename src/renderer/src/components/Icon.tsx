import type { SVGProps } from 'react'

const paths: Record<string, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <path d="M16 4.5v5M8 14.5v5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </>
  ),
  share: (
    <>
      <path d="M12 16V3" />
      <path d="m7.5 7.5 4.5-4.5 4.5 4.5" />
      <path d="M5 13v7h14v-7" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v13" />
      <path d="m7.5 11.5 4.5 4.5 4.5-4.5" />
      <path d="M5 20h14" />
    </>
  ),
  check: <path d="m4 12.5 5 5L20 6.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  folder: (
    <>
      <path d="M3 6h6l2 2h10v11H3z" />
      <path d="M3 10h18" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M18 13v7H4V6h7" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v5h-5" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </>
  ),
  waveform: (
    <>
      <path d="M3 12h2M7 8v8M11 4v16M15 7v10M19 10v4M21 12h1" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2 21h20z" />
      <path d="M12 9v5M12 17.5v.5" />
    </>
  ),
  arrowLeft: <path d="M19 12H5m6-6-6 6 6 6" />,
  arrowRight: <path d="M5 12h14m-6-6 6 6-6 6" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  play: <path d="M7 4v16l13-8z" />,
  pause: (
    <>
      <path d="M7 4h4v16H7zM14 4h4v16h-4z" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
      <path d="m6 6 3 3M15 15l3 3M18 6l-3 3M9 15l-3 3" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  cpu: (
    <>
      <rect x="7" y="7" width="10" height="10" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </>
  )
}

export type IconName = keyof typeof paths

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName
  size?: number
}

export function Icon({ name, size = 20, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths[name]}
    </svg>
  )
}

export function BrandMark({ size = 30 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size * 1.2}
      viewBox="0 0 34 40"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path pathLength="1" style={{ ['--i' as string]: 0 }} d="M1 1 H23 L33 11 V39 H1 Z" />
      <path
        pathLength="1"
        style={{ ['--i' as string]: 1 }}
        className="fill-accent"
        d="M23 1 V11 H33"
      />
      <path pathLength="1" style={{ ['--i' as string]: 2 }} d="M11 16 L22 24 L11 32 Z" />
      <path pathLength="1" style={{ ['--i' as string]: 3 }} d="M7 35 H20" />
    </svg>
  )
}
