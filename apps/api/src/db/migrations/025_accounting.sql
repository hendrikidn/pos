-- Akuntansi: bagan akun per tenant (diisi dari bawaan saat pertama dipakai) dan jurnal manual. Jurnal penjualan POS tidak disimpan: dihitung
-- ulang dari event setiap kali (apps/api/src/accounting.ts), jadi selalu sesuai data dan tidak bisa menyimpang dari laporan penjualan.
create table account (
  tenant_id text not null references tenant (id),
  code      text not null,
  name      text not null,
  type      text not null check (type in ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  normal    text not null check (normal in ('DEBIT', 'CREDIT')),
  active    boolean not null default true,
  primary key (tenant_id, code)
);

create table journal_entry (
  tenant_id   text not null references tenant (id),
  id          bigserial primary key,
  outlet_id   text not null references outlet (id),
  date        text not null,
  memo        text not null,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  -- jurnal tidak dihapus; yang salah dibatalkan dengan alasan dan tidak ikut laporan
  voided_at   timestamptz,
  void_reason text
);
create index journal_entry_outlet on journal_entry (outlet_id, date);

create table journal_line (
  tenant_id text not null references tenant (id),
  entry_id  bigint not null references journal_entry (id),
  line_no   integer not null,
  account   text not null,
  debit     bigint not null default 0 check (debit >= 0),
  credit    bigint not null default 0 check (credit >= 0),
  check ((debit > 0) <> (credit > 0)),
  primary key (entry_id, line_no)
);

alter table account enable row level security;
alter table journal_entry enable row level security;
alter table journal_line enable row level security;
create policy tenant_isolation on account using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
create policy tenant_isolation on journal_entry using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
create policy tenant_isolation on journal_line using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, update on account, journal_entry to app_user;
grant select, insert on journal_line to app_user;
grant usage on sequence journal_entry_id_seq to app_user;
