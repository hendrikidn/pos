/**
 * Foto saat absen: dipotret seketika dari kamera depan tanpa pratinjau dan tanpa langkah konfirmasi. Kamera dibuka, satu frame diambil
 * (frame kedua, supaya tidak gelap), foto diperkecil ke 320 px JPEG kualitas 0,6 (sekitar 10-25 KB), lalu kamera ditutup lagi. Seluruhnya
 * dibatasi waktu: bila kamera lambat atau gagal, absen jalan terus dengan alasan tidak ada foto.
 */
export type CaptureResult = { hash: string; bytes: number; base64: string } | { missing: 'NO_CAMERA' | 'DENIED' | 'TIMEOUT' | 'ERROR' };

const WIDTH = 320;

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function capturePhoto(timeoutMs = 2500): Promise<CaptureResult> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return { missing: 'NO_CAMERA' };
  const deadline = Date.now() + timeoutMs;
  let stream: MediaStream | null = null;
  try {
    stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: WIDTH }, height: { ideal: 240 } }, audio: false }),
      new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs)),
    ]);
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'TimeoutError') return { missing: 'TIMEOUT' };
    if (name === 'NotAllowedError' || name === 'SecurityError') return { missing: 'DENIED' };
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return { missing: 'NO_CAMERA' };
    return { missing: 'ERROR' };
  }
  try {
    const video = document.createElement('video') as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // Tunggu dua frame: frame pertama sering gelap karena eksposur belum menyesuaikan.
    await new Promise<void>((resolve) => {
      const left = Math.max(200, deadline - Date.now());
      const timer = setTimeout(resolve, left);
      const done = () => { clearTimeout(timer); resolve(); };
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => video.requestVideoFrameCallback!(done));
      else video.onloadeddata = done;
    });
    if (!video.videoWidth) return { missing: 'ERROR' };
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * WIDTH) || 240;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { missing: 'ERROR' };
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.6));
    if (!blob || blob.size < 100) return { missing: 'ERROR' };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = toHex(await crypto.subtle.digest('SHA-256', bytes));
    return { hash, bytes: bytes.length, base64: toBase64(bytes) };
  } catch {
    return { missing: 'ERROR' };
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}
