-- Loyalty dasar: member per tenant, buku besar poin (saldo = jumlah baris; terminal tidak pernah mengubah saldo sendiri), dan peringatan
-- yang menjadi temuan R33. Poin diperoleh dari pembayaran order yang dikaitkan ke member dan ditukar lewat diskon POINTS.
create table member (
  tenant_id  text not null references tenant (id),
  id         text not null,
  -- nomor HP dinormalisasi (digit, awalan 62); identitas member di kasir
  phone      text not null,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text,
  primary key (tenant_id, id),
  unique (tenant_id, phone)
);

create table member_ledger (
  tenant_id text not null references tenant (id),
  outlet_id text not null references outlet (id),
  member_id text not null,
  device_id text not null,
  seq       integer not null,
  kind      text not null check (kind in ('EARN', 'REDEEM', 'REVERSE')),
  order_id  text not null,
  -- bertanda: EARN positif, REDEEM negatif, REVERSE pembalik (void/refund)
  points    integer not null,
  at_ms     float8 not null,
  primary key (device_id, seq, kind)
);
create index member_ledger_member on member_ledger (tenant_id, member_id);
create index member_ledger_order on member_ledger (outlet_id, order_id);

create table loyalty_alert (
  tenant_id text not null references tenant (id),
  outlet_id text not null references outlet (id),
  device_id text not null,
  seq       integer not null,
  kind      text not null check (kind in ('UNKNOWN_MEMBER', 'OVER_REDEEM', 'MEMBER_MISMATCH')),
  order_id  text not null,
  member_id text not null,
  actor_id  text,
  detail    text not null,
  at_ms     float8 not null,
  primary key (device_id, seq, kind)
);
create index loyalty_alert_outlet on loyalty_alert (outlet_id, at_ms);

alter table outlet
  add column loyalty_rupiah_per_point integer not null default 0 check (loyalty_rupiah_per_point between 0 and 1000000),
  add column loyalty_point_value integer not null default 0 check (loyalty_point_value between 0 and 1000000),
  add column loyalty_max_redeem_percent integer not null default 50 check (loyalty_max_redeem_percent between 1 and 100);

create index event_member_link on event ((payload->>'orderId')) where type = 'order.member_linked';

alter table member enable row level security;
alter table member_ledger enable row level security;
alter table loyalty_alert enable row level security;
create policy tenant_isolation on member using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
create policy tenant_isolation on member_ledger using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
create policy tenant_isolation on loyalty_alert using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, update on member to app_user;
grant select, insert on member_ledger, loyalty_alert to app_user;
