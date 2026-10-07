/** Logo Anatta POS (sama dengan dashboard owner): perisai dengan tanda centang. */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false" className="logo">
      <rect width="40" height="40" rx="12" fill="var(--primary)" />
      <path d="M20 8.5l9 3.6v6.4c0 5.6-3.8 10-9 12.5-5.2-2.5-9-6.9-9-12.5v-6.4l9-3.6z" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M15.8 20.2l3 3 5.6-5.8" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
