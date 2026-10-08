-- Transfer stok antar-outlet (dapur pusat ke outlet): barang keluar dari outlet asal saat dikirim dan masuk ke outlet tujuan saat diterima.
-- Selisih jumlah (dikirim vs diterima) dan kiriman yang tak kunjung diterima menjadi temuan.
alter table stock_movement drop constraint stock_movement_kind_check;
alter table stock_movement add constraint stock_movement_kind_check check (kind in ('PURCHASE', 'WASTE', 'COUNT', 'TRANSFER_IN', 'TRANSFER_OUT'));

create table stock_transfer (
  id            bigserial primary key,
  tenant_id     text not null references tenant (id),
  from_outlet   text not null references outlet (id),
  to_outlet     text not null references outlet (id),
  status        text not null check (status in ('SENT', 'RECEIVED', 'CANCELED')),
  note          text,
  sent_by       text not null,
  sent_at_ms    float8 not null,
  received_by   text,
  received_at_ms float8,
  cancel_reason text,
  -- ada baris yang diterima kurang dari yang dikirim
  short         boolean not null default false,
  check (from_outlet <> to_outlet)
);
create index stock_transfer_outlets on stock_transfer (from_outlet, to_outlet, status);

create table stock_transfer_line (
  tenant_id     text not null,
  transfer_id   bigint not null references stock_transfer (id),
  line_no       integer not null,
  ingredient_id text not null,
  qty_sent      integer not null check (qty_sent > 0),
  qty_received  integer check (qty_received >= 0),
  -- harga pokok rata-rata bahan saat dikirim (per satuan terkecil), untuk menilai selisih
  unit_cost     numeric(14, 4) not null default 0,
  primary key (transfer_id, line_no),
  foreign key (tenant_id, ingredient_id) references ingredient (tenant_id, id)
);

alter table stock_transfer enable row level security;
alter table stock_transfer_line enable row level security;
create policy tenant_isolation on stock_transfer using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
create policy tenant_isolation on stock_transfer_line using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, update on stock_transfer to app_user;
grant select, insert, update on stock_transfer_line to app_user;
grant usage on all sequences in schema public to app_user;
