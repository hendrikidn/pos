-- Dasar aturan R16 (kertas) dan R52 (resep dikurangi): gulungan kertas dicatat manual (beli dan hitung sisa), dan perubahan resep atau BOM per bahan
-- dicatat dengan waktu layanan supaya bisa dibandingkan dengan selisih opname.
create table paper_roll_log (
  id        bigserial primary key,
  tenant_id text not null references tenant (id),
  outlet_id text not null references outlet (id),
  kind      text not null check (kind in ('PURCHASE', 'COUNT')),
  rolls     integer not null check (rolls >= 0 and rolls <= 10000),
  note      text,
  user_id   text not null,
  at_ms     float8 not null
);
create index paper_roll_outlet on paper_roll_log (outlet_id, at_ms);

create table recipe_change (
  id            bigserial primary key,
  tenant_id     text not null references tenant (id),
  kind          text not null check (kind in ('RECIPE', 'BOM')),
  target_id     text not null,
  option_id     text not null default '',
  ingredient_id text not null,
  before_qty    integer not null check (before_qty >= 0),
  after_qty     integer not null check (after_qty >= 0),
  user_id       text not null,
  at_ms         float8 not null
);
create index recipe_change_time on recipe_change (tenant_id, at_ms);
create index recipe_change_ingredient on recipe_change (tenant_id, ingredient_id, at_ms);

do $$
declare t text;
begin
  foreach t in array array['paper_roll_log', 'recipe_change'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)) '
      'with check (tenant_id = current_setting(''app.tenant_id'', true))', t);
  end loop;
end $$;

grant select, insert on paper_roll_log, recipe_change to app_user;
grant usage on all sequences in schema public to app_user;
