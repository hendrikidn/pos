import { beforeAll, describe, expect, it } from 'vitest';
import { build, CUSTOMER, EMPTY, frame, hasCompiler, replay, script } from './helpers';

let bins: ReturnType<typeof build>;
beforeAll(() => {
  bins = hasCompiler ? build() : null;
});
const run = (input: string, args: string[] = []) => replay(bins!.replay, input, args);

describe.skipIf(!hasCompiler)('pembaca frame LD2410', () => {
  it('membaca frame yang valid dan menghitungnya', () => {
    const r = run(script([{ from: 0, to: 900, frame: CUSTOMER }], ['H 1000']));
    expect(r.health).toEqual({ health: 'ok', framesOk: 10, framesBad: 0 });
  });

  it('mode rekayasa (frame lebih panjang) tetap terbaca', () => {
    const r = run(script([{ from: 0, to: 400, frame: { ...CUSTOMER, engineering: true } }], ['H 500']));
    expect(r.health).toMatchObject({ framesOk: 5, framesBad: 0 });
  });

  it('byte sampah di antara frame dilewati tanpa merusak frame berikutnya', () => {
    const noisy = [0x00, 0xff, 0xf4, 0xf3, 0x12, ...frame(CUSTOMER), 0xf4, 0xf4, 0xf4, ...frame(CUSTOMER)];
    const r = run(script([{ from: 0, to: 0, raw: noisy }], ['H 100']));
    expect(r.health!.framesOk).toBe(2);
  });

  it('frame terbelah di dua pembacaan UART digabung dengan benar', () => {
    const f = frame(CUSTOMER);
    const input = [`F 0 ${f.slice(0, 7).map((b) => b.toString(16).padStart(2, '0')).join('')}`, `F 50 ${f.slice(7).map((b) => b.toString(16).padStart(2, '0')).join('')}`, 'H 100'].join('\n') + '\n';
    expect(run(input).health!.framesOk).toBe(1);
  });

  it('frame rusak (ekor salah, panjang tidak masuk akal, energi di luar 0-100) ditolak dan dihitung', () => {
    const badTail = frame(CUSTOMER);
    badTail[badTail.length - 1] = 0x00;
    const badLen = [0xf4, 0xf3, 0xf2, 0xf1, 0xff, 0x00, 0x01, 0x02];
    const badEnergy = frame({ ...CUSTOMER, moveEnergy: 200 });
    const r = run(script([{ from: 0, to: 0, raw: [...badTail, ...badLen, ...badEnergy, ...frame(CUSTOMER)] }], ['H 100']));
    expect(r.health!.framesOk).toBe(1);
    expect(r.health!.framesBad).toBeGreaterThanOrEqual(3);
  });

  it('frame respons perintah (FD FC FB FA) tidak dianggap data', () => {
    const ack = [0xfd, 0xfc, 0xfb, 0xfa, 0x04, 0x00, 0xff, 0x01, 0x00, 0x00, 0x04, 0x03, 0x02, 0x01];
    const r = run(script([{ from: 0, to: 0, raw: [...ack, ...frame(CUSTOMER)] }], ['H 100']));
    expect(r.health).toMatchObject({ framesOk: 1 });
  });
});

describe.skipIf(!hasCompiler)('deteksi sesi customer', () => {
  it('kunjungan 10 detik menjadi satu sesi: mulai dari awal kehadiran, berakhir pada kehadiran terakhir', () => {
    const r = run(script([
      { from: 0, to: 1000, frame: EMPTY },
      { from: 1100, to: 11000, frame: CUSTOMER },
      { from: 11100, to: 20000, frame: EMPTY },
    ]));
    expect(r.sessions).toEqual([{ start: 1100, end: 11000, peakMove: 60, peakStatic: 55 }]);
  });

  it('sesi baru dilaporkan setelah tidak ada selama 5 detik, bukan sebelumnya', () => {
    const before = run(script([{ from: 0, to: 5000, frame: CUSTOMER }, { from: 5100, to: 9000, frame: EMPTY }]));
    expect(before.sessions).toEqual([]); // baru 4 detik tanpa customer
    const after = run(script([{ from: 0, to: 5000, frame: CUSTOMER }, { from: 5100, to: 10100, frame: EMPTY }]));
    expect(after.sessions).toHaveLength(1);
  });

  it('kedipan sinyal pendek tidak memecah kunjungan', () => {
    const r = run(script([
      { from: 0, to: 4000, frame: CUSTOMER },
      { from: 4100, to: 6000, frame: EMPTY }, // 2 detik hilang
      { from: 6100, to: 10000, frame: CUSTOMER },
      { from: 10100, to: 20000, frame: EMPTY },
    ]));
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ start: 0, end: 10000 });
  });

  it('jeda panjang (6 detik) memisahkan dua kunjungan', () => {
    const r = run(script([
      { from: 0, to: 4000, frame: CUSTOMER },
      { from: 4100, to: 10100, frame: EMPTY },
      { from: 10200, to: 15000, frame: CUSTOMER },
      { from: 15100, to: 25000, frame: EMPTY },
    ]));
    expect(r.sessions.map((s) => [s.start, s.end])).toEqual([[0, 4000], [10200, 15000]]);
  });

  it('lewat sekilas (< 2 detik) bukan kunjungan', () => {
    const r = run(script([{ from: 0, to: 1500, frame: CUSTOMER }, { from: 1600, to: 15000, frame: EMPTY }]));
    expect(r.sessions).toEqual([]);
  });

  it('target di luar zona (terlalu dekat atau terlalu jauh) diabaikan', () => {
    const near = { ...CUSTOMER, moveDist: 15, staticDist: 15 };
    const far = { ...CUSTOMER, moveDist: 400, staticDist: 400 };
    const r = run(script([{ from: 0, to: 10000, frame: near }, { from: 10100, to: 20000, frame: far }, { from: 20100, to: 30000, frame: EMPTY }]));
    expect(r.sessions).toEqual([]);
  });

  it('orang yang berdiri diam (hanya energi diam) tetap terdeteksi', () => {
    const still = { state: 2, staticDist: 90, staticEnergy: 45, detectDist: 90 };
    const r = run(script([{ from: 0, to: 8000, frame: still }, { from: 8100, to: 20000, frame: EMPTY }]));
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ peakMove: 0, peakStatic: 45 });
  });

  it('energi di bawah ambang (derau) tidak membuat sesi', () => {
    const weak = { state: 3, moveDist: 80, moveEnergy: 8, staticDist: 80, staticEnergy: 10, detectDist: 80 };
    const r = run(script([{ from: 0, to: 10000, frame: weak }, { from: 10100, to: 20000, frame: EMPTY }]));
    expect(r.sessions).toEqual([]);
  });

  it('zona dan ambang dapat diatur', () => {
    const r = run(script([{ from: 0, to: 6000, frame: CUSTOMER }, { from: 6100, to: 15000, frame: EMPTY }]), ['zone_min=100', 'zone_max=200']);
    expect(r.sessions).toEqual([]); // customer di 80 cm, di luar zona 100-200
  });

  it('kunjungan yang sangat lama dipecah agar tetap terlapor', () => {
    const r = run(script([{ from: 0, to: 30000, frame: CUSTOMER }, { from: 30100, to: 40000, frame: EMPTY }]), ['max_session=10000']);
    expect(r.sessions.length).toBeGreaterThanOrEqual(3);
    expect(r.sessions[0]).toMatchObject({ start: 0, end: 10000 });
    expect(r.sessions[1]!.start).toBe(10000);
  });

  it('kabel radar putus di tengah kunjungan: sesi berakhir lewat jam, bukan tergantung selamanya', () => {
    const r = run(script([{ from: 0, to: 5000, frame: CUSTOMER }, { from: 5100, to: 15000 }])); // tanpa frame lagi
    expect(r.sessions).toEqual([expect.objectContaining({ start: 0, end: 5000 })]);
  });
});

describe.skipIf(!hasCompiler)('kesehatan radar', () => {
  it('ok selama frame datang', () => {
    expect(run(script([{ from: 0, to: 3000, frame: EMPTY }], ['H 3100'])).health!.health).toBe('ok');
  });

  it('no_radar bila tidak ada frame lebih dari 5 detik (kabel dicabut)', () => {
    expect(run(script([{ from: 0, to: 2000, frame: EMPTY }, { from: 2100, to: 9000 }], ['H 9000'])).health!.health).toBe('no_radar');
  });

  it('blocked bila target diam berenergi maksimum menempel di antena selama > 60 detik (sensor ditutup)', () => {
    const covered = { state: 2, staticDist: 3, staticEnergy: 100, detectDist: 3 };
    const input = script([{ from: 0, to: 61_000, frame: covered }], ['H 61100']);
    expect(run(input).health!.health).toBe('blocked');
    const brief = script([{ from: 0, to: 30_000, frame: covered }, { from: 30_100, to: 61_000, frame: EMPTY }], ['H 61100']);
    expect(run(brief).health!.health).toBe('ok');
  });
});
