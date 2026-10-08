import type { ReactNode } from 'react';

/** Ikon garis sederhana (24px). Dekoratif: teks di sebelahnya yang dibaca pembaca layar. */
function Svg({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconAlert = () => (
  <Svg><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" /><path d="M12 8v4" /><path d="M12 15.5h.01" /></Svg>
);
export const IconCard = () => (
  <Svg><rect x="2.5" y="5" width="19" height="14" rx="3" /><path d="M2.5 10h19" /><path d="M6.5 15h4" /></Svg>
);
export const IconSliders = () => (
  <Svg><path d="M4 6h8" /><path d="M18 6h2" /><circle cx="15" cy="6" r="2.2" /><path d="M4 12h2" /><path d="M12 12h8" /><circle cx="9" cy="12" r="2.2" /><path d="M4 18h9" /><path d="M19 18h1" /><circle cx="16" cy="18" r="2.2" /></Svg>
);
export const IconChart = () => (
  <Svg><path d="M5 20V11" /><path d="M12 20V4" /><path d="M19 20v-6" /></Svg>
);
export const IconBox = () => (
  <Svg><path d="M3.5 8L12 4l8.5 4v8L12 20l-8.5-4V8z" /><path d="M3.5 8L12 12l8.5-4" /><path d="M12 12v8" /></Svg>
);
export const IconLogout = () => (
  <Svg><path d="M15 17l5-5-5-5" /><path d="M20 12H9" /><path d="M12 4H6a2 2 0 00-2 2v12a2 2 0 002 2h6" /></Svg>
);
export const IconBack = () => (
  <Svg size={20}><path d="M15 6l-6 6 6 6" /></Svg>
);
export const IconChevron = () => (
  <Svg size={20}><path d="M9 6l6 6-6 6" /></Svg>
);
export const IconClock = () => (
  <Svg size={16}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>
);
export const IconInfo = () => (
  <Svg size={18}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></Svg>
);

/** Logo Anatta POS (berkas `public/logo.png`, tile bersudut membulat). */
export function Logo({ size = 40 }: { size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/logo.png" width={size} height={size} alt="" aria-hidden="true" className="logo" />;
}
export const IconBook = () => (
  <Svg><path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4z" /><path d="M5 17a3 3 0 013-3h11" /></Svg>
);
