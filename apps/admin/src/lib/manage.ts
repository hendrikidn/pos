/** Memanggil API admin lewat server konsol. Mengembalikan data respons atau pesan kesalahan. */
export async function manage<T = unknown>(path: string, body?: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  const res = await fetch('/api/manage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, path, body }),
  }).catch(() => null);
  if (!res) return { ok: false, message: 'Tidak dapat menghubungi server.' };
  if (res.ok) return { ok: true, data: (await res.json().catch(() => null)) as T };
  const j = (await res.json().catch(() => ({}))) as { message?: string | string[] };
  return { ok: false, message: (Array.isArray(j.message) ? j.message.join('; ') : j.message) ?? 'Permintaan gagal.' };
}
