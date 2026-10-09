-- Pelaporan pajak: identitas pemberi kerja dan pegawai yang dibutuhkan bukti potong PPh 21 (BPMP bulanan dan BPA1 tahunan, format impor XML Coretax).
create table employer_tax_profile (
  tenant_id     text primary key references tenant (id),
  -- NPWP pemotong: 15 atau 16 digit. ID TKU (NITKU) = NPWP 16 digit + 6 digit tempat kegiatan usaha (000000 untuk pusat).
  npwp          text not null check (npwp ~ '^[0-9]{15,16}$'),
  tku_suffix    text not null default '000000' check (tku_suffix ~ '^[0-9]{6}$'),
  legal_name    text not null,
  address       text,
  signer_name   text,
  signer_title  text,
  -- PPh Final UMKM (PP 55/2022): tarif 0,5% atas omzet; WP orang pribadi tidak dikenai atas Rp500 juta pertama setahun.
  umkm_final    boolean not null default false,
  taxpayer_type text not null default 'OP' check (taxpayer_type in ('OP', 'BADAN')),
  updated_by    text not null,
  updated_at    timestamptz not null default now()
);
alter table employer_tax_profile enable row level security;
create policy tenant_isolation on employer_tax_profile using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, update on employer_tax_profile to app_user;

-- NIK/NPWP pegawai (15 atau 16 digit), jabatan, kewarganegaraan, dan metode penghitungan setahun.
alter table staff_tax add column nik text check (nik is null or nik ~ '^[0-9]{15,16}$');
alter table staff_tax add column position text check (position is null or char_length(position) <= 50);
alter table staff_tax add column foreign_national boolean not null default false;
alter table staff_tax add column passport text check (passport is null or char_length(passport) <= 30);
-- Kewajiban pajak subjektif parsial (mis. pegawai asing baru menjadi subjek pajak dalam negeri di tengah tahun): penghasilan neto disetahunkan.
alter table staff_tax add column annualize boolean not null default false;
