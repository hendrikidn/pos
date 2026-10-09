import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ApiAuth } from './auth';
import { a1Xml, bpmpXml, NIK_RE, NPWP_RE, pph21Deadlines, tin16, type A1Row, type BpmpRow, type EmployerTaxProfile } from './coretax-pph21';
import { Database } from './db/database';
import type { Queryable } from './db/driver';
import { CLOCK, type Clock } from './pipeline.service';
import { DEFAULT_TAX_SETTINGS, mergeSettings, type TaxSettings } from './statutory';

const num = (v: unknown) => Number(v);
const ROLE_LABEL: Record<string, string> = { CASHIER: 'Kasir', SUPERVISOR: 'Supervisor', MANAGER: 'Manager', OWNER: 'Owner' };
const OBJECT_CODE = '21-100-01'; // penghasilan pegawai tetap (kode objek pajak resmi di templat DJP)

export interface EmployerInput { npwp?: unknown; tkuSuffix?: unknown; legalName?: unknown; address?: unknown; signerName?: unknown; signerTitle?: unknown; umkmFinal?: unknown; taxpayerType?: unknown }

interface StaffLine {
  staff_id: string; name: string; role: string; nik: string | null; position: string | null; ptkp: string; npwp: boolean; foreign_national: boolean; passport: string | null; annualize: boolean;
}

/**
 * Bukti potong PPh 21 untuk Coretax (BPMP bulanan dan BPA1 tahunan) dan rekap SPT Masa PPh 21, dari penggajian yang SUDAH DIBAYAR (status PAID).
 * Pratinjau JSON selalu tersedia dengan daftar masalah data (NIK kosong, profil pemberi kerja belum diisi); XML hanya dibuat bila tidak ada masalah.
 */
@Injectable()
export class TaxFilingService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private audit(q: Queryable, auth: ApiAuth, action: string, detail: object) {
    return q.query('insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)', [auth.tenantId, auth.userId, action, JSON.stringify(detail)]);
  }

  private async employer(q: Queryable): Promise<EmployerTaxProfile | null> {
    const r = (await q.query<{ npwp: string; tku_suffix: string; legal_name: string; address: string | null; signer_name: string | null; signer_title: string | null; umkm_final: boolean; taxpayer_type: 'OP' | 'BADAN' }>(
      'select npwp, tku_suffix, legal_name, address, signer_name, signer_title, umkm_final, taxpayer_type from employer_tax_profile limit 1',
    )).rows[0];
    return r ? { npwp: r.npwp, tkuSuffix: r.tku_suffix, legalName: r.legal_name, address: r.address, signerName: r.signer_name, signerTitle: r.signer_title, umkmFinal: r.umkm_final, taxpayerType: r.taxpayer_type } : null;
  }

  async getEmployer(auth: ApiAuth) {
    return this.db.tenantTx(auth.tenantId, async (q) => ({ profile: await this.employer(q) }));
  }

  async setEmployer(auth: ApiAuth, input: EmployerInput): Promise<void> {
    const need = (ok: unknown, m: string) => { if (!ok) throw new BadRequestException(m); };
    const npwp = typeof input.npwp === 'string' ? input.npwp.replace(/[\s.\-]/g, '') : '';
    need(NPWP_RE.test(npwp), 'NPWP pemotong harus 15 atau 16 digit');
    const tku = input.tkuSuffix === undefined || input.tkuSuffix === '' ? '000000' : input.tkuSuffix;
    need(typeof tku === 'string' && /^[0-9]{6}$/.test(tku), 'kode tempat kegiatan usaha harus 6 digit (000000 untuk pusat)');
    const name = typeof input.legalName === 'string' ? input.legalName.trim() : '';
    need(name.length >= 2 && name.length <= 120, 'nama pemotong wajib (2–120 karakter)');
    const text = (v: unknown, max: number) => (v === undefined || v === null || v === '' ? null : typeof v === 'string' && v.trim().length <= max ? v.trim() : undefined);
    const address = text(input.address, 200); const signerName = text(input.signerName, 80); const signerTitle = text(input.signerTitle, 80);
    need(address !== undefined && signerName !== undefined && signerTitle !== undefined, 'alamat, nama penandatangan, atau jabatan terlalu panjang');
    need(input.umkmFinal === undefined || typeof input.umkmFinal === 'boolean', 'umkmFinal harus true atau false');
    need(input.taxpayerType === undefined || input.taxpayerType === 'OP' || input.taxpayerType === 'BADAN', 'taxpayerType harus OP atau BADAN');
    await this.db.tenantTx(auth.tenantId, async (q) => {
      await q.query(
        `insert into employer_tax_profile (tenant_id, npwp, tku_suffix, legal_name, address, signer_name, signer_title, umkm_final, taxpayer_type, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (tenant_id) do update set npwp = excluded.npwp, tku_suffix = excluded.tku_suffix, legal_name = excluded.legal_name, address = excluded.address, signer_name = excluded.signer_name,
           signer_title = excluded.signer_title, umkm_final = excluded.umkm_final, taxpayer_type = excluded.taxpayer_type, updated_by = excluded.updated_by, updated_at = now()`,
        [auth.tenantId, npwp, tku, name, address, signerName, signerTitle, input.umkmFinal ?? false, input.taxpayerType ?? 'OP', auth.userId],
      );
      await this.audit(q, auth, 'tax.employer_profile', { npwp: `${npwp.slice(0, 4)}…`, legalName: name });
    });
  }

  private async settings(q: Queryable): Promise<TaxSettings> {
    const r = (await q.query<{ params: Partial<TaxSettings> }>('select params from payroll_tax_setting limit 1')).rows[0];
    if (!r) return DEFAULT_TAX_SETTINGS;
    const m = mergeSettings(DEFAULT_TAX_SETTINGS, r.params);
    return m.ok ? m.value : DEFAULT_TAX_SETTINGS;
  }

  private identityProblems(s: StaffLine): string[] {
    const p: string[] = [];
    if (!s.nik || !NIK_RE.test(s.nik)) p.push(`${s.name}: NIK/NPWP belum diisi atau tidak 15–16 digit`);
    if (s.foreign_national && !s.passport) p.push(`${s.name}: pegawai asing wajib nomor paspor`);
    return p;
  }

  private parseYear(year: unknown): number {
    const y = typeof year === 'string' && /^\d{4}$/.test(year) ? Number(year) : NaN;
    if (!Number.isInteger(y) || y < 2024 || y > new Date(this.clock()).getUTCFullYear() + 1) throw new BadRequestException('year harus tahun 2024 atau sesudahnya (YYYY)');
    return y;
  }

  /** Bukti pemotongan masa (BPMP) satu bulan: satu baris per pegawai dengan bruto sebulan dan tarif TER. Pegawai yang masa pajak terakhirnya jatuh di bulan itu memakai BPA1. */
  async bpmp(auth: ApiAuth, yearRaw: unknown, monthRaw: unknown) {
    const month = typeof monthRaw === 'string' && /^(0?[1-9]|1[0-2])$/.test(monthRaw) ? Number(monthRaw) : NaN;
    if (!Number.isInteger(month)) throw new BadRequestException('month harus 1–12');
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const year = this.parseYear(yearRaw);
      const employer = await this.employer(q);
      const ym = `${year}-${String(month).padStart(2, '0')}`;
      const rows = (await q.query<StaffLine & { gross: string; tax: string; rate: string | null; paid: string; has_final: boolean }>(
        `select l.staff_id, s.name, s.role, t.nik, t.position, t.ptkp, t.npwp, t.foreign_national, t.passport, t.annualize,
                sum(l.taxable_gross) as gross, sum(l.pph21) as tax, max(l.ter_rate) as rate, max(r.paid_date) as paid, bool_or(l.final_period) as has_final
         from payroll_line l join payroll_run r on r.id = l.run_id join staff s on s.tenant_id = l.tenant_id and s.id = l.staff_id
           join staff_tax t on t.tenant_id = l.tenant_id and t.staff_id = l.staff_id and t.tax_enabled
         where r.status = 'PAID' and substr(r.period_end, 1, 7) = $1
         group by l.staff_id, s.name, s.role, t.nik, t.position, t.ptkp, t.npwp, t.foreign_national, t.passport, t.annualize order by s.name`, [ym],
      )).rows;
      const problems: string[] = [];
      const warnings: string[] = [];
      const excluded: { staffId: string; name: string; reason: string }[] = [];
      const noNpwpMultiplier = (await this.settings(q)).noNpwpMultiplier;
      const out: (BpmpRow & { staffId: string; name: string; tax: number })[] = [];
      if (!employer) problems.push('Profil pemberi kerja (NPWP pemotong, nama) belum diisi');
      for (const r of rows) {
        if (r.has_final) { excluded.push({ staffId: r.staff_id, name: r.name, reason: 'masa pajak terakhir: gunakan BPA1' }); continue; }
        problems.push(...this.identityProblems(r));
        const rate = Math.round(num(r.rate ?? 0) * (r.npwp ? 1 : noNpwpMultiplier) * 10000) / 10000;
        const gross = num(r.gross);
        const tax = num(r.tax);
        if (Math.floor((gross * rate) / 100 + 1e-9) !== tax) warnings.push(`${r.name}: gross x tarif (${Math.floor((gross * rate) / 100)}) berbeda dari PPh yang dipotong di penggajian (${tax}); periksa penggajian bulan ini`);
        out.push({
          staffId: r.staff_id, name: r.name, tax, month, year, foreign: r.foreign_national, passport: r.passport, tin: r.nik ?? '', ptkp: r.ptkp,
          position: r.position?.trim() || ROLE_LABEL[r.role] || 'Pegawai', taxObjectCode: OBJECT_CODE, gross, rate, withholdingDate: r.paid,
        });
      }
      if (rows.length === 0) warnings.push(`Belum ada penggajian DIBAYAR dengan PPh 21 aktif untuk ${ym}.`);
      const ok = problems.length === 0 && out.length > 0 && employer !== null;
      const dl = pph21Deadlines(year, month);
      const sum = out.reduce((a, r) => ({ gross: a.gross + r.gross, tax: a.tax + r.tax }), { gross: 0, tax: 0 });
      return {
        year, month, employer, rows: out, excluded, problems: [...new Set(problems)], warnings, totals: sum, deadlines: dl, ready: ok,
        xml: ok ? bpmpXml(employer, out) : null,
        notes: ['Penyetoran PPh 21 umumnya paling lambat tanggal 10 dan pelaporan SPT Masa tanggal 20 bulan berikutnya; periksa ketentuan terbaru. Unggah XML ini di Coretax (e-Bupot > BPMP > Impor Data).'],
      };
    });
  }

  /** Bukti pemotongan A1 tahunan untuk pegawai yang masa pajak terakhirnya (Desember atau berhenti bekerja) ada di tahun itu. */
  async a1(auth: ApiAuth, yearRaw: unknown) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const year = this.parseYear(yearRaw);
      const employer = await this.employer(q);
      const settings = await this.settings(q);
      const rows = (await q.query<StaffLine & { salary: string; other: string; insurance: string; pension: string; m0: string; m1: string; months: string; paid: string; has_final: boolean; tax: string }>(
        `select l.staff_id, s.name, s.role, t.nik, t.position, t.ptkp, t.npwp, t.foreign_national, t.passport, t.annualize,
                sum(l.base) as salary, sum(l.overtime_pay + l.allowance) as other, sum(l.bpjs_jkk_employer + l.bpjs_jkm_employer + l.bpjs_kes_employer) as insurance,
                sum(l.bpjs_jht_employee + l.bpjs_jp_employee) as pension, min(substr(r.period_end, 6, 2)) as m0, max(substr(r.period_end, 6, 2)) as m1,
                count(distinct substr(r.period_end, 1, 7)) as months, max(case when l.final_period then r.paid_date end) as paid, bool_or(l.final_period) as has_final, sum(l.pph21) as tax
         from payroll_line l join payroll_run r on r.id = l.run_id join staff s on s.tenant_id = l.tenant_id and s.id = l.staff_id
           join staff_tax t on t.tenant_id = l.tenant_id and t.staff_id = l.staff_id and t.tax_enabled
         where r.status = 'PAID' and substr(r.period_end, 1, 4) = $1
         group by l.staff_id, s.name, s.role, t.nik, t.position, t.ptkp, t.npwp, t.foreign_national, t.passport, t.annualize order by s.name`, [String(year)],
      )).rows;
      const problems: string[] = [];
      const pending: { staffId: string; name: string }[] = [];
      const out: (A1Row & { staffId: string; name: string; withheld: number })[] = [];
      if (!employer) problems.push('Profil pemberi kerja (NPWP pemotong, nama) belum diisi');
      for (const r of rows) {
        if (!r.has_final) { pending.push({ staffId: r.staff_id, name: r.name }); continue; }
        problems.push(...this.identityProblems(r));
        const months = num(r.months);
        const status = r.annualize ? 'Annualized' : months === 12 ? 'FullYear' : 'PartialYear';
        out.push({
          staffId: r.staff_id, name: r.name, withheld: num(r.tax), monthStart: num(r.m0), monthEnd: num(r.m1), year, foreign: r.foreign_national, passport: r.passport, tin: r.nik ?? '', ptkp: r.ptkp, status,
          position: r.position?.trim() || ROLE_LABEL[r.role] || 'Pegawai', taxObjectCode: OBJECT_CODE, numberOfMonths: status === 'Annualized' ? months : 0,
          salary: num(r.salary), otherBenefit: num(r.other), insurance: settings.employerPremiumsTaxable ? num(r.insurance) : 0, pension: num(r.pension), withholdingDate: r.paid,
        });
      }
      const ok = problems.length === 0 && out.length > 0 && employer !== null;
      return {
        year, employer, rows: out, pending, problems: [...new Set(problems)], ready: ok, xml: ok ? a1Xml(employer, out) : null,
        warnings: [
          ...(pending.length ? [`${pending.length} pegawai belum punya penggajian masa pajak terakhir di ${year} (tandai "masa pajak terakhir" atau buat penggajian Desember): ${pending.map((p) => p.name).join(', ')}`] : []),
          'Komponen bonus/THR, honorarium, natura, dan tunjangan PPh tidak dipisahkan di penggajian: semua tunjangan masuk "Tunjangan lainnya/lembur". Zakat tidak didukung. Pindahkan manual di Coretax bila perlu.',
        ],
        notes: ['Unggah XML ini di Coretax (e-Bupot > BPA1 > Impor Data). Nomor bukti potong diterbitkan DJP. PPh yang sudah dipotong diambil Coretax dari BPMP bulanan, jadi kolomnya diisi 0 sesuai templat DJP.'],
      };
    });
  }

  /** Rekap SPT Masa PPh 21 per bulan di satu tahun: jumlah pegawai, bruto, PPh yang dipotong, dan batas waktu. */
  async summary(auth: ApiAuth, yearRaw: unknown) {
    return this.db.tenantTx(auth.tenantId, async (q) => {
      const year = this.parseYear(yearRaw);
      const rows = (await q.query<{ ym: string; staff: string; gross: string; tax: string; final_tax: string }>(
        `select substr(r.period_end, 1, 7) as ym, count(distinct l.staff_id) as staff, sum(l.taxable_gross) as gross, sum(l.pph21) as tax, sum(case when l.final_period then l.pph21 else 0 end) as final_tax
         from payroll_line l join payroll_run r on r.id = l.run_id join staff_tax t on t.tenant_id = l.tenant_id and t.staff_id = l.staff_id and t.tax_enabled
         where r.status = 'PAID' and substr(r.period_end, 1, 4) = $1 group by 1 order by 1`, [String(year)],
      )).rows;
      const by = new Map(rows.map((r) => [r.ym, r]));
      const months = Array.from({ length: 12 }, (_, i) => {
        const ym = `${year}-${String(i + 1).padStart(2, '0')}`;
        const r = by.get(ym);
        return { month: i + 1, staff: r ? num(r.staff) : 0, gross: r ? num(r.gross) : 0, pph21: r ? num(r.tax) : 0, ofWhichFinalPeriod: r ? num(r.final_tax) : 0, deadlines: pph21Deadlines(year, i + 1) };
      });
      const total = months.reduce((s, m) => s + m.pph21, 0);
      await this.audit(q, auth, 'tax.pph21_summary', { year });
      return { year, months, totalPph21: total, notes: ['Batas waktu umum: setor tanggal 10, lapor tanggal 20 bulan berikutnya (periksa ketentuan terbaru).'] };
    });
  }

  /** Mencatat unduhan XML di audit (memuat NIK pegawai). */
  async logExport(auth: ApiAuth, kind: 'bpmp' | 'a1', detail: object): Promise<void> {
    await this.db.tenantTx(auth.tenantId, (q) => this.audit(q, auth, `export.coretax.${kind}`, detail));
  }
}


