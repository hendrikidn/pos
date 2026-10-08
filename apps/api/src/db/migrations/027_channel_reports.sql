-- Laporan pesanan dari platform pesan-antar (diunggah owner/ops dari CSV portal merchant) untuk rekonsiliasi dengan order online di POS.
create table channel_report (
  id          bigserial primary key,
  tenant_id   text not null references tenant (id),
  outlet_id   text not null references outlet (id),
  channel     text not null check (channel in ('GOFOOD', 'GRABFOOD', 'SHOPEEFOOD')),
  filename    text,
  date_from   text not null,
  date_to     text not null,
  rows        integer not null,
  imported_by text not null,
  imported_at timestamptz not null default now()
);
create index channel_report_outlet on channel_report (outlet_id, imported_at);

create table channel_order (
  tenant_id  text not null references tenant (id),
  outlet_id  text not null references outlet (id),
  channel    text not null check (channel in ('GOFOOD', 'GRABFOOD', 'SHOPEEFOOD')),
  -- nomor pesanan dicocokkan tanpa peduli huruf besar-kecil
  ref_key    text not null,
  ref        text not null,
  date       text not null,
  gross      integer not null check (gross >= 0),
  commission integer not null check (commission >= 0),
  net        integer not null check (net >= 0),
  report_id  bigint not null references channel_report (id),
  primary key (outlet_id, channel, ref_key)
);
create index channel_order_date on channel_order (outlet_id, date);

alter table channel_report enable row level security;
alter table channel_order enable row level security;
create policy tenant_isolation on channel_report using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
create policy tenant_isolation on channel_order using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert on channel_report to app_user;
grant select, insert, update on channel_order to app_user;
grant usage on sequence channel_report_id_seq to app_user;
