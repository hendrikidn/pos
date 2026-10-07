import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(__dirname, '..');

export const hasCompiler = spawnSync('cc', ['--version']).status === 0;

/** Membangun alat uji C ke direktori sementara. Dilewati bila tidak ada kompilator C. */
export function build(): { genEvents: string; replay: string } | null {
  if (spawnSync('cc', ['--version']).status !== 0) return null;
  const dir = mkdtempSync(join(tmpdir(), 'sensor-node-'));
  execFileSync('make', ['-C', ROOT, `BUILD=${dir}`], { stdio: 'pipe' });
  return { genEvents: join(dir, 'gen_events'), replay: join(dir, 'replay') };
}

export interface FrameSpec {
  state?: number;
  moveDist?: number;
  moveEnergy?: number;
  staticDist?: number;
  staticEnergy?: number;
  detectDist?: number;
  engineering?: boolean;
}

const HEADER = [0xf4, 0xf3, 0xf2, 0xf1];
const TAIL = [0xf8, 0xf7, 0xf6, 0xf5];

/** Frame data LD2410 sesuai protokol serial pabrikan. */
export function frame(f: FrameSpec): number[] {
  const payload = [
    f.engineering ? 0x01 : 0x02, 0xaa, f.state ?? 0,
    (f.moveDist ?? 0) & 0xff, ((f.moveDist ?? 0) >> 8) & 0xff, f.moveEnergy ?? 0,
    (f.staticDist ?? 0) & 0xff, ((f.staticDist ?? 0) >> 8) & 0xff, f.staticEnergy ?? 0,
    (f.detectDist ?? 0) & 0xff, ((f.detectDist ?? 0) >> 8) & 0xff,
    ...(f.engineering ? Array.from({ length: 20 }, (_, i) => i) : []),
    0x55, 0x00,
  ];
  return [...HEADER, payload.length & 0xff, payload.length >> 8, ...payload, ...TAIL];
}

export const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

export const EMPTY: FrameSpec = { state: 0 };
/** Customer berdiri 80 cm di depan sensor. */
export const CUSTOMER: FrameSpec = { state: 3, moveDist: 80, moveEnergy: 60, staticDist: 82, staticEnergy: 55, detectDist: 80 };

export type Step = { t: number; frame?: FrameSpec | number[] } | { health: number };

/** Mengubah rangkaian langkah menjadi masukan replay. Frame dikirim tiap 100 ms dari `from` sampai `to`. */
export function script(parts: { from: number; to: number; frame?: FrameSpec; raw?: number[] }[], extra: string[] = []): string {
  const lines: string[] = [];
  for (const p of parts) {
    for (let t = p.from; t <= p.to; t += 100) {
      if (p.frame) lines.push(`F ${t} ${hex(frame(p.frame))}`);
      else if (p.raw) lines.push(`F ${t} ${hex(p.raw)}`);
      else lines.push(`T ${t}`);
    }
  }
  return [...lines, ...extra].join('\n') + '\n';
}

export interface Session { start: number; end: number; peakMove: number; peakStatic: number }

export function replay(bin: string, input: string, args: string[] = []): { sessions: Session[]; health?: { health: string; framesOk: number; framesBad: number } } {
  const out = execFileSync(bin, args, { input }).toString().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const health = out.find((o) => 'health' in o);
  return { sessions: out.filter((o) => 'start' in o) as Session[], health };
}
