import qrcode from 'qrcode-generator';

/**
 * Kode QR sebagai SVG (satu path, tepi tajam). Selalu hitam di atas putih dengan tepi kosong 4 modul, walau tema gelap, agar
 * terbaca kamera ponsel. Koreksi kesalahan M: cukup tahan goresan dan layar kusam tanpa membuat kodenya terlalu rapat.
 */
export function Qr({ value, size = 240, label = 'Kode QR' }: { value: string; size?: number; label?: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const box = n + quiet * 2;
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${box} ${box}`} shapeRendering="crispEdges" className="qr">
      <rect width={box} height={box} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
