/** Logo Anatta POS (berkas `public/logo.png`, tile bersudut membulat). */
export function Logo({ size = 36 }: { size?: number }) {
  return <img src="/logo.png" width={size} height={size} alt="" aria-hidden="true" className="logo" />;
}
