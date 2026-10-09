/**
 * Dokumen PPh 21 dalam format impor XML Coretax resmi DJP, dibangun dari penggajian:
 *  - BPMP (bukti pemotongan masa, bulanan): <MmPayrollBulk>, satu baris per pegawai per bulan dengan Gross dan Rate (TER).
 *  - BPA1 (bukti pemotongan A1, masa pajak terakhir): <A1Bulk>, satu baris per pegawai dengan penghasilan setahun.
 * Skema (XSD) dan contoh diambil dari templat resmi DJP (https://www.pajak.go.id/reformdjp/coretax/template-xml-dan-converter-excel-ke-xml);
 * salinannya ada di test/fixtures/coretax dan XML hasil dibangun divalidasi terhadap XSD itu di tes.
 * Berkas ini murni (tanpa basis data). Yang diunggah ke Coretax tetap pemilik/akuntan; di sana nomor bukti potong diterbitkan DJP.
 */

export interface EmployerTaxProfile { npwp: string; tkuSuffix: string; legalName: string; address: string | null; signerName: string | null; signerTitle: string | null; umkmFinal: boolean; taxpayerType: 'OP' | 'BADAN' }

/** NPWP 15 digit (lama) dijadikan 16 digit dengan awalan 0, seperti contoh DJP (0029482015507000). */
export const tin16 = (npwp: string): string => (npwp.length === 15 ? `0${npwp}` : npwp);
/** ID TKU (NITKU) pemotong: NPWP 16 digit + 6 digit tempat kegiatan usaha (000000 untuk pusat). */
export const nitku = (e: Pick<EmployerTaxProfile, 'npwp' | 'tkuSuffix'>): string => `${tin16(e.npwp)}${e.tkuSuffix}`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (name: string, value: string | number | null, indent: string) => (value === null ? `${indent}<${name} xsi:nil="true"/>` : `${indent}<${name}>${esc(String(value))}</${name}>`);

export interface BpmpRow {
  month: number; year: number; foreign: boolean; passport: string | null; tin: string; ptkp: string; position: string;
  taxObjectCode: string; gross: number; rate: number; withholdingDate: string;
}

const T = '\t';
export function bpmpXml(employer: Pick<EmployerTaxProfile, 'npwp' | 'tkuSuffix'>, rows: BpmpRow[]): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<MmPayrollBulk xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">', tag('TIN', tin16(employer.npwp), T), `${T}<ListOfMmPayroll>`];
  for (const r of rows) {
    const i = `${T}${T}${T}`;
    out.push(`${T}${T}<MmPayroll>`,
      tag('TaxPeriodMonth', r.month, i), tag('TaxPeriodYear', r.year, i), tag('CounterpartOpt', r.foreign ? 'Foreign' : 'Resident', i), tag('CounterpartPassport', r.foreign ? r.passport : null, i),
      tag('CounterpartTin', r.tin, i), tag('StatusTaxExemption', r.ptkp, i), tag('Position', r.position, i), tag('TaxCertificate', 'N/A', i), tag('TaxObjectCode', r.taxObjectCode, i),
      tag('Gross', r.gross, i), tag('Rate', r.rate, i), tag('IDPlaceOfBusinessActivity', nitku(employer), i), tag('WithholdingDate', r.withholdingDate, i), `${T}${T}</MmPayroll>`);
  }
  out.push(`${T}</ListOfMmPayroll>`, '</MmPayrollBulk>');
  return `${out.join('\n')}\n`;
}

export interface A1Row {
  monthStart: number; monthEnd: number; year: number; foreign: boolean; passport: string | null; tin: string; ptkp: string; status: 'FullYear' | 'PartialYear' | 'Annualized';
  position: string; taxObjectCode: string; numberOfMonths: number; salary: number; otherBenefit: number; insurance: number; pension: number; withholdingDate: string;
}

export function a1Xml(employer: Pick<EmployerTaxProfile, 'npwp' | 'tkuSuffix'>, rows: A1Row[]): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<A1Bulk xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">', tag('TIN', tin16(employer.npwp), T), `${T}<ListOfA1>`];
  for (const r of rows) {
    const i = `${T}${T}${T}`;
    out.push(`${T}${T}<A1>`,
      tag('WorkForSecondEmployer', 'No', i), tag('TaxPeriodMonthStart', r.monthStart, i), tag('TaxPeriodMonthEnd', r.monthEnd, i), tag('TaxPeriodYear', r.year, i),
      tag('CounterpartOpt', r.foreign ? 'Foreign' : 'Resident', i), tag('CounterpartPassport', r.foreign ? r.passport : null, i), tag('CounterpartTin', r.tin, i), tag('TaxExemptOpt', r.ptkp, i),
      tag('StatusOfWithholding', r.status, i), tag('CounterpartPosition', r.position, i), tag('TaxObjectCode', r.taxObjectCode, i), tag('NumberOfMonths', r.numberOfMonths, i),
      tag('SalaryPensionJhtTht', r.salary, i), tag('GrossUpOpt', 'No', i), tag('IncomeTaxBenefit', 0, i), tag('OtherBenefit', r.otherBenefit, i), tag('Honorarium', 0, i),
      tag('InsurancePaidByEmployer', r.insurance, i), tag('Natura', 0, i), tag('TantiemBonusThr', 0, i), tag('PensionContributionJhtThtFee', r.pension, i), tag('Zakat', 0, i),
      tag('PrevWhTaxSlip', null, i), tag('TaxCertificate', 'N/A', i),
      // Menurut templat DJP kolom ini diisi 0: Coretax sendiri mengambil PPh yang sudah dipotong dari BPMP bulanan.
      tag('Article21IncomeTax', 0, i), tag('IDPlaceOfBusinessActivity', nitku(employer), i), tag('WithholdingDate', r.withholdingDate, i), `${T}${T}</A1>`);
  }
  out.push(`${T}</ListOfA1>`, '</A1Bulk>');
  return `${out.join('\n')}\n`;
}

export const NIK_RE = /^[0-9]{15,16}$/;
export const NPWP_RE = /^[0-9]{15,16}$/;

/** Batas waktu umum (verifikasi ke ketentuan terbaru): PPh 21 disetor paling lambat tanggal 10 dan SPT Masa dilaporkan paling lambat tanggal 20 bulan berikutnya. */
export function pph21Deadlines(year: number, month: number): { pay: string; file: string } {
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const d = (day: number) => `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { pay: d(10), file: d(20) };
}
