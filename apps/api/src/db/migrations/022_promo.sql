-- Promo yang ditetapkan owner; kasir hanya memilih dari daftar ini (lihat packages/order/src/promo.ts). Tidak pernah dihapus: diskon
-- lama di event merujuk `id` promo, jadi promo yang dihentikan cukup dinonaktifkan.
create table promo (
  tenant_id    text not null references tenant (id),
  id           text not null,
  -- null = berlaku di semua outlet
  outlet_id    text references outlet (id),
  name         text not null,
  kind         text not null check (kind in ('PERCENT', 'AMOUNT')),
  value        integer not null check (value >= 1),
  min_subtotal integer,
  max_discount integer,
  days         jsonb,
  start_date   text,
  end_date     text,
  start_hour   integer,
  end_hour     integer,
  active       boolean not null default true,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, id)
);

alter table promo enable row level security;
create policy tenant_isolation on promo
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, update on promo to app_user;
