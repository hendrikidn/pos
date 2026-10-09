import { Injectable } from '@nestjs/common';

type Gauge = number | { labels: Record<string, string | number>; value: number }[];
const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const lbl = (labels: Record<string, string | number>) => {
  const k = Object.keys(labels);
  return k.length === 0 ? '' : `{${k.map((n) => `${n}="${esc(String(labels[n]))}"`).join(',')}}`;
};

/**
 * Penghitung metrik di memori dalam format teks Prometheus (tanpa pustaka tambahan): permintaan HTTP (jumlah dan lama per rute), penghitung
 * bebas (`inc`), dan pengukur yang dihitung saat discrape (`gauge`). Rute memakai pola (`/v1/orders/:id`), bukan alamat mentah, supaya
 * jumlah seri tetap kecil dan tidak ada id atau token yang bocor ke label.
 */
@Injectable()
export class Telemetry {
  private readonly startedAt = Date.now();
  private readonly http = new Map<string, { count: number; sum: number; buckets: number[] }>();
  private readonly counters = new Map<string, { help: string; values: Map<string, number> }>();
  private readonly gauges = new Map<string, { help: string; fn: () => Gauge | Promise<Gauge> }>();

  observeHttp(method: string, route: string, status: number, seconds: number): void {
    const key = JSON.stringify([method, route, `${Math.floor(status / 100)}xx`]);
    const h = this.http.get(key) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    h.count++;
    h.sum += seconds;
    BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i]!++; });
    this.http.set(key, h);
  }

  inc(name: string, help: string, labels: Record<string, string | number> = {}, by = 1): void {
    const c = this.counters.get(name) ?? { help, values: new Map<string, number>() };
    const k = lbl(labels);
    c.values.set(k, (c.values.get(k) ?? 0) + by);
    this.counters.set(name, c);
  }

  /** Nilai terakhir (bukan penjumlahan): mis. lama evaluasi terakhir. */
  set(name: string, help: string, value: number, labels: Record<string, string | number> = {}): void {
    const c = this.counters.get(name) ?? { help, values: new Map<string, number>() };
    c.values.set(lbl(labels), value);
    this.counters.set(name, c);
  }

  gauge(name: string, help: string, fn: () => Gauge | Promise<Gauge>): void {
    this.gauges.set(name, { help, fn });
  }

  read(name: string, labels: Record<string, string | number> = {}): number {
    return this.counters.get(name)?.values.get(lbl(labels)) ?? 0;
  }

  async render(): Promise<string> {
    const out: string[] = [];
    out.push('# HELP pos_http_requests_total Jumlah permintaan HTTP per metode, rute, dan kelas status.', '# TYPE pos_http_requests_total counter');
    for (const [k, h] of this.http) {
      const [m, r, s] = JSON.parse(k) as [string, string, string];
      out.push(`pos_http_requests_total${lbl({ method: m, route: r, status: s })} ${h.count}`);
    }
    out.push('# HELP pos_http_request_duration_seconds Lama pemrosesan permintaan HTTP.', '# TYPE pos_http_request_duration_seconds histogram');
    for (const [k, h] of this.http) {
      const [m, r, s] = JSON.parse(k) as [string, string, string];
      const base = { method: m, route: r, status: s };
      BUCKETS.forEach((b, i) => out.push(`pos_http_request_duration_seconds_bucket${lbl({ ...base, le: b })} ${h.buckets[i]}`));
      out.push(`pos_http_request_duration_seconds_bucket${lbl({ ...base, le: '+Inf' })} ${h.count}`);
      out.push(`pos_http_request_duration_seconds_sum${lbl(base)} ${h.sum}`, `pos_http_request_duration_seconds_count${lbl(base)} ${h.count}`);
    }
    for (const [name, c] of this.counters) {
      out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} ${name.endsWith('_total') ? 'counter' : 'gauge'}`);
      for (const [k, v] of c.values) out.push(`${name}${k} ${v}`);
    }
    for (const [name, g] of this.gauges) {
      out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
      try {
        const v = await g.fn();
        for (const r of Array.isArray(v) ? v : [{ labels: {}, value: v }]) out.push(`${name}${lbl(r.labels)} ${r.value}`);
      } catch { /* pengukur yang gagal tidak boleh menggagalkan seluruh scrape */ }
    }
    const mem = process.memoryUsage();
    out.push(
      '# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${(Date.now() - this.startedAt) / 1000}`,
      '# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`,
      '# TYPE process_heap_used_bytes gauge', `process_heap_used_bytes ${mem.heapUsed}`,
    );
    return `${out.join('\n')}\n`;
  }
}
