-- Inventori: bahan baku, resep per menu/opsi, dan pergerakan stok per outlet. Satuan terkecil (g, ml, pcs) bilangan bulat.

create table ingredient (
  tenant_id  text not null references tenant (id),
  id         text not null,
  name       text not null,
  unit       text not null check (unit in ('g', 'ml', 'pcs')),
  -- stok di bawah atau sama dengan ini ditandai menipis
  min_stock  integer not null default 0 check (min_stock >= 0),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

-- Bahan per porsi. option_id kosong = resep dasar menu; terisi = tambahan bila opsi itu dipilih.
create table recipe_line (
  tenant_id     text not null,
  menu_id       text not null,
  option_id     text not null default '',
  ingredient_id text not null,
  qty           integer not null check (qty > 0),
  primary key (tenant_id, menu_id, option_id, ingredient_id),
  foreign key (tenant_id, ingredient_id) references ingredient (tenant_id, id),
  foreign key (tenant_id, menu_id) references menu_item (tenant_id, id)
);

-- Append-only. COUNT = hasil hitung fisik (opname) dan menjadi dasar stok berikutnya; `expected` dan `variance` dicatat saat itu.
create table stock_movement (
  id            bigserial primary key,
  tenant_id     text not null references tenant (id),
  outlet_id     text not null references outlet (id),
  ingredient_id text not null,
  kind          text not null check (kind in ('PURCHASE', 'WASTE', 'COUNT')),
  qty           integer not null check (qty >= 0),
  -- hanya COUNT: perkiraan sistem saat dihitung, selisih (hitung − perkiraan), dan pemakaian teoretis sejak opname sebelumnya
  expected      integer,
  variance      integer,
  period_used   integer,
  note          text,
  user_id       text not null,
  at_ms         float8 not null,
  foreign key (tenant_id, ingredient_id) references ingredient (tenant_id, id)
);
create index stock_movement_lookup on stock_movement (outlet_id, ingredient_id, at_ms);

do $$
declare t text;
begin
  foreach t in array array['ingredient', 'recipe_line', 'stock_movement'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)) '
      'with check (tenant_id = current_setting(''app.tenant_id'', true))', t);
  end loop;
end $$;

grant select, insert, update on ingredient to app_user;
grant select, insert, delete on recipe_line to app_user;
grant select, insert on stock_movement to app_user;
grant usage on all sequences in schema public to app_user;
