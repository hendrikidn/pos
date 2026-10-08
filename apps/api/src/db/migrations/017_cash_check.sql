-- Hitung ulang kas yang seharusnya saat tutup shift oleh server (lihat packages/order/src/cash.ts): `expected` kiriman terminal
-- tidak dipercaya begitu saja. Hanya hasil yang dapat diverifikasi disimpan (rantai utuh dan ada pembukaan shift).
create table cash_check (
  tenant_id       text not null references tenant (id),
  outlet_id       text not null references outlet (id),
  device_id       text not null,
  seq             integer not null,
  shift_id        text not null,
  claimed         float8 not null,
  server_expected float8 not null,
  status          text not null check (status in ('OK', 'MISMATCH')),
  opening_cash    float8 not null,
  cash_in         float8 not null,
  cash_out        float8 not null,
  checked_at      timestamptz not null default now(),
  primary key (device_id, seq)
);
create index cash_check_outlet on cash_check (outlet_id, status);

alter table cash_check enable row level security;
create policy tenant_isolation on cash_check
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert on cash_check to app_user;
