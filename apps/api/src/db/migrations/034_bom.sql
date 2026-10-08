-- Bill of material bertingkat. Bahan bisa RAW (dibeli, dihitung stoknya) atau SEMI (bahan setengah jadi: sirup, saus, adonan; dibuat dari bahan lain,
-- tidak punya stok sendiri dan "terurai" ke bahan baku saat resep dihitung). `yield_percent` = bagian bahan baku yang terpakai setelah susut
-- (kupas, buang tulang); `batch_yield` = hasil satu batch bahan setengah jadi dalam satuannya.
alter table ingredient add column kind text not null default 'RAW' check (kind in ('RAW', 'SEMI'));
alter table ingredient add column yield_percent integer not null default 100 check (yield_percent between 1 and 100);
alter table ingredient add column batch_yield integer check (batch_yield is null or batch_yield > 0);
alter table ingredient add constraint ingredient_semi_yield check (kind = 'RAW' or batch_yield is not null);

-- Bahan per BATCH untuk bahan setengah jadi (parent_id).
create table bom_line (
  tenant_id text not null,
  parent_id text not null,
  child_id  text not null,
  qty       integer not null check (qty > 0),
  primary key (tenant_id, parent_id, child_id),
  foreign key (tenant_id, parent_id) references ingredient (tenant_id, id),
  foreign key (tenant_id, child_id) references ingredient (tenant_id, id),
  check (parent_id <> child_id)
);

alter table bom_line enable row level security;
create policy tenant_isolation on bom_line using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, delete on bom_line to app_user;
grant update (kind, yield_percent, batch_yield) on ingredient to app_user;
