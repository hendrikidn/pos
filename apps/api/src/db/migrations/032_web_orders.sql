-- Toko web: pelanggan memesan lewat halaman publik outlet dan membayar di kasir. Pesanan menunggu di sini sampai kasir menerimanya di POS
-- (klaim atomik oleh satu terminal), lalu menjadi order kasir yang dikaitkan lewat event `order.web_linked`.
alter table outlet add column web_slug text;
alter table outlet add column web_enabled boolean not null default false;
create unique index outlet_web_slug on outlet (web_slug) where web_slug is not null;

create table web_order (
  id              bigserial primary key,
  tenant_id       text not null references tenant (id),
  outlet_id       text not null references outlet (id),
  token           text not null unique,
  customer_name   text not null,
  phone           text not null,
  order_type      text not null check (order_type in ('TAKE_AWAY', 'DINE_IN')),
  table_no        text,
  -- salinan baris pesanan saat dipesan: [{ itemId, name, qty, unitPrice, options: [{ id, name, price }], note }]
  items           jsonb not null,
  estimated_total bigint not null check (estimated_total >= 0),
  note            text,
  status          text not null default 'NEW' check (status in ('NEW', 'ACCEPTED', 'REJECTED', 'EXPIRED')),
  created_at_ms   float8 not null,
  caller_hash     text not null,
  decided_by      text,
  decided_at_ms   float8,
  decided_reason  text
);
create index web_order_outlet on web_order (outlet_id, created_at_ms);
create index web_order_status on web_order (outlet_id, status);

alter table web_order enable row level security;
create policy tenant_isolation on web_order using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, update on web_order to app_user;
grant usage on all sequences in schema public to app_user;
