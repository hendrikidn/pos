-- Potongan wajib penggajian: profil pajak dan BPJS per staf, pengaturan tarif per tenant, dan hasil hitungan per baris gaji (PPh 21 TER, iuran BPJS).
create table staff_tax (
  tenant_id   text not null,
  staff_id    text not null,
  -- Hitung PPh 21 untuk staf ini? Mati bawaan: penggajian lama tidak berubah sampai owner mengaktifkannya.
  tax_enabled boolean not null default false,
  ptkp        text not null default 'TK/0' check (ptkp in ('TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3')),
  npwp        boolean not null default true,
  bpjs_tk     boolean not null default false,
  bpjs_kes    boolean not null default false,
  primary key (tenant_id, staff_id),
  foreign key (tenant_id, staff_id) references staff (tenant_id, id)
);

-- Tarif dan batas yang berubah tiap tahun (mis. batas upah JP) disimpan per tenant; kosong = nilai baku dari kode.
create table payroll_tax_setting (
  tenant_id  text primary key references tenant (id),
  params     jsonb not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
);

alter table payroll_line add column bpjs_jht_employee bigint not null default 0;
alter table payroll_line add column bpjs_jp_employee  bigint not null default 0;
alter table payroll_line add column bpjs_kes_employee bigint not null default 0;
alter table payroll_line add column bpjs_jht_employer bigint not null default 0;
alter table payroll_line add column bpjs_jp_employer  bigint not null default 0;
alter table payroll_line add column bpjs_jkk_employer bigint not null default 0;
alter table payroll_line add column bpjs_jkm_employer bigint not null default 0;
alter table payroll_line add column bpjs_kes_employer bigint not null default 0;
-- Penghasilan bruto untuk PPh 21 (gaji + lembur + tunjangan + premi pemberi kerja) dan hasilnya.
alter table payroll_line add column taxable_gross bigint not null default 0;
alter table payroll_line add column pph21 bigint not null default 0;
alter table payroll_line add column ter_category text;
alter table payroll_line add column ter_rate numeric(5, 2);
-- Masa pajak terakhir (Desember atau bulan berhenti bekerja): PPh 21 dihitung setahun dengan tarif Pasal 17.
alter table payroll_line add column final_period boolean not null default false;
-- Catatan hitungan (mis. lebih potong) untuk ditampilkan ke pemilik.
alter table payroll_line add column tax_note text;

alter table staff_tax enable row level security;
create policy tenant_isolation on staff_tax using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
alter table payroll_tax_setting enable row level security;
create policy tenant_isolation on payroll_tax_setting using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, update on staff_tax, payroll_tax_setting to app_user;
