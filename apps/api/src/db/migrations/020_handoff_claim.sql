-- Klaim serah-terima order antar-terminal: satu klaim per serah-terima (terminal asal + nomor urut event), supaya dua terminal yang
-- mengambil order yang sama bersamaan tidak sama-sama berhasil. Klaim yang tidak diselesaikan dilepas setelah beberapa menit (lihat HANDOFF_CLAIM_TTL_MS).
create table handoff_claim (
  tenant_id      text not null references tenant (id),
  outlet_id      text not null references outlet (id),
  from_device_id text not null,
  handoff_seq    integer not null,
  order_id       text not null,
  claimed_by     text not null,
  claimed_at_ms  float8 not null,
  primary key (outlet_id, from_device_id, handoff_seq)
);

alter table handoff_claim enable row level security;
create policy tenant_isolation on handoff_claim
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, update on handoff_claim to app_user;
