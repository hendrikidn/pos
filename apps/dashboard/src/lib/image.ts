/** Batas sisi foto menu (piksel) dan mutu JPEG: cukup tajam untuk kartu menu di layar kasir, dan hasilnya ± 30–60 KB. */
export const MENU_IMAGE_SIZE = 480;
const QUALITY = 0.82;

/**
 * Mengecilkan foto dari berkas pilihan pengguna menjadi JPEG persegi (potong tengah) lalu mengembalikannya sebagai base64. Dilakukan di
 * browser agar unggahan kecil dan terminal tidak mengunduh foto ponsel berukuran megabyte. Berkas yang bukan gambar ditolak.
 */
export async function resizeToJpeg(file: File, size = MENU_IMAGE_SIZE): Promise<{ contentType: 'image/jpeg'; data: string }> {
  if (!file.type.startsWith('image/')) throw new Error('Pilih berkas gambar (JPG, PNG, atau WebP).');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Gambar tidak bisa dibaca. Coba berkas lain.');
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(size, side);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Browser tidak mendukung pengolahan gambar.');
  ctx.fillStyle = '#fff'; // PNG transparan menjadi latar putih, bukan hitam
  ctx.fillRect(0, 0, out, out);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close();
  const url = canvas.toDataURL('image/jpeg', QUALITY);
  return { contentType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
}
