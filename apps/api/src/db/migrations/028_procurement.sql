-- Pengadaan: supplier, pesanan pembelian (PO), penerimaan barang (menambah stok dan memperbarui harga pokok rata-rata), dan utang supplier.
alter table ingredient add column avg_cost numeric(14, 4) not null default 0 check (avg_cost >= 0);

create table supplier (
  tenant_id  text not null references tenant (id),
  id         text not null,
  name       text not null,
  phone      text,
  note       text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create table purchase_order (
  id            bigserial primary key,
  tenant_id     text not null references tenant (id),
  outlet_id     text not null references outlet (id),
  supplier_id   text not null,
  status        text not null check (status in ('DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELED')),
  expected_date text,
  note          text,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  ordered_at    timestamptz,
  canceled_at   timestamptz,
  cancel_reason text,
  foreign key (tenant_id, supplier_id) references supplier (tenant_id, id)
);
create index purchase_order_outlet on purchase_order (outlet_id, status);

create table purchase_line (
  tenant_id     text not null,
  po_id         bigint not null references purchase_order (id),
  line_no       integer not null,
  ingredient_id text not null,
  qty           integer not null check (qty > 0),
  -- rupiah per satuan terkecil (g, ml, pcs); boleh pecahan
  unit_cost     numeric(14, 4) not null check (unit_cost >= 0),
  received_qty  integer not null default 0 check (received_qty >= 0),
  primary key (po_id, line_no),
  foreign key (tenant_id, ingredient_id) references ingredient (tenant_id, id)
);

create table purchase_receipt (
  id             bigserial primary key,
  tenant_id      text not null references tenant (id),
  po_id          bigint not null references purchase_order (id),
  outlet_id      text not null references outlet (id),
  supplier_id    text not null,
  received_at_ms float8 not null,
  received_by    text not null,
  invoice_ref    text,
  amount         bigint not null check (amount >= 0),
  -- harga di faktur melebihi harga di PO lebih dari 5% pada setidaknya satu baris
  price_flag     boolean not null default false,
  note           text
);
create index purchase_receipt_outlet on purchase_receipt (outlet_id, received_at_ms);

create table purchase_receipt_line (
  tenant_id     text not null,
  receipt_id    bigint not null references purchase_receipt (id),
  line_no       integer not null,
  ingredient_id text not null,
  qty           integer not null check (qty > 0),
  unit_cost     numeric(14, 4) not null check (unit_cost >= 0),
  po_unit_cost  numeric(14, 4) not null,
  primary key (receipt_id, line_no)
);

create table supplier_payment (
  id          bigserial primary key,
  tenant_id   text not null references tenant (id),
  outlet_id   text not null references outlet (id),
  supplier_id text not null,
  amount      bigint not null check (amount > 0),
  paid_date   text not null,
  method      text not null check (method in ('TUNAI', 'TRANSFER')),
  ref         text,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, supplier_id) references supplier (tenant_id, id)
);
create index supplier_payment_outlet on supplier_payment (outlet_id, paid_date);

do $$
declare t text;
begin
  foreach t in array array['supplier', 'purchase_order', 'purchase_line', 'purchase_receipt', 'purchase_receipt_line', 'supplier_payment'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)) '
      'with check (tenant_id = current_setting(''app.tenant_id'', true))', t);
  end loop;
end $$;

grant select, insert, update on supplier, purchase_order to app_user;
grant select, insert, update, delete on purchase_line to app_user;
grant select, insert on purchase_receipt, purchase_receipt_line, supplier_payment to app_user;
grant update (avg_cost) on ingredient to app_user;
grant usage on all sequences in schema public to app_user;
