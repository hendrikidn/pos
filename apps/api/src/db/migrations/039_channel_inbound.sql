-- Pesanan GoFood, GrabFood, ShopeeFood yang masuk langsung ke POS lewat gerbang integrasi: kunci per outlet dan kanal, pemetaan menu platform ke menu
-- outlet, dan pesanan masuk yang menunggu diterima kasir (klaim atomik oleh satu terminal), lalu menjadi order online di kasir.
create table channel_integration (
  id           bigserial primary key,
  tenant_id    text not null references tenant (id),
  outlet_id    text not null references outlet (id),
  channel      text not null check (channel in ('GOFOOD', 'GRABFOOD', 'SHOPEEFOOD')),
  key_hash     text not null unique,
  key_prefix   text not null,
  -- true: terminal menerima pesanan yang menunya sudah terpetakan otomatis dan langsung mengirimnya ke dapur
  auto_accept  boolean not null default false,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);
create unique index channel_integration_live on channel_integration (outlet_id, channel) where revoked_at is null;

-- external_key: id menu di platform bila ada, kalau tidak nama menu dalam huruf kecil dan spasi dirapikan.
create table channel_item_map (
  tenant_id    text not null,
  channel      text not null check (channel in ('GOFOOD', 'GRABFOOD', 'SHOPEEFOOD')),
  external_key text not null,
  menu_id      text not null,
  created_by   text not null,
  primary key (tenant_id, channel, external_key),
  foreign key (tenant_id, menu_id) references menu_item (tenant_id, id)
);

create table channel_inbound (
  id              bigserial primary key,
  tenant_id       text not null references tenant (id),
  outlet_id       text not null references outlet (id),
  channel         text not null check (channel in ('GOFOOD', 'GRABFOOD', 'SHOPEEFOOD')),
  ref             text not null,
  customer_name   text,
  note            text,
  -- [{ externalId?, key, name, qty, unitPrice, note? }]
  items           jsonb not null,
  total           bigint not null check (total >= 0),
  placed_at_ms    float8,
  received_at_ms  float8 not null,
  status          text not null default 'NEW' check (status in ('NEW', 'ACCEPTED', 'REJECTED', 'CANCELED', 'EXPIRED')),
  decided_by      text,
  decided_at_ms   float8,
  decided_reason  text,
  platform_canceled_at_ms float8,
  unique (outlet_id, channel, ref)
);
create index channel_inbound_status on channel_inbound (outlet_id, status);

do $$
declare t text;
begin
  foreach t in array array['channel_integration', 'channel_item_map', 'channel_inbound'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)) '
      'with check (tenant_id = current_setting(''app.tenant_id'', true))', t);
  end loop;
end $$;

grant select, insert, update on channel_integration, channel_inbound to app_user;
grant select, insert, update, delete on channel_item_map to app_user;
grant usage on all sequences in schema public to app_user;
