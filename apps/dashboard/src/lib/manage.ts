/** Memanggil API pengelolaan lewat server dashboard. Mengembalikan pesan kesalahan bila gagal. */
export async function manage(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  const res = await fetch('/api/manage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, path, body }),
  }).catch(() => null);
  if (!res) return { ok: false, message: 'Tidak dapat menghubungi server.' };
  if (res.ok) return { ok: true, data: await res.json().catch(() => null) };
  const j = (await res.json().catch(() => ({}))) as { message?: string | string[] };
  return { ok: false, message: (Array.isArray(j.message) ? j.message.join('; ') : j.message) ?? 'Permintaan gagal.' };
}

export const ROLE_LABEL = { CASHIER: 'Kasir', SUPERVISOR: 'Supervisor', MANAGER: 'Manager', OWNER: 'Owner' } as const;
