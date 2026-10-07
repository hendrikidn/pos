-- Pairing perangkat: owner/ops membuat kode sekali pakai, perangkat menukarnya dengan token.
-- Token dibuat server saat penukaran dan tidak pernah ditanam di firmware.
alter table device add column terminal_id text;
alter table device add column revoked_at timestamptz;

create table pairing_code (
  code_hash   text primary key,
  tenant_id   text not null references tenant (id),
  outlet_id   text not null references outlet (id),
  device_id   text not null,
  kind        text not null check (kind in ('terminal', 'sensor', 'kds')),
  terminal_id text,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index pairing_code_tenant on pairing_code (tenant_id, expires_at);

alter table pairing_code enable row level security;
create policy tenant_isolation on pairing_code
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, delete on pairing_code to app_user;
