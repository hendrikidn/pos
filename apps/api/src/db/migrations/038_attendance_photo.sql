-- Foto saat absen: terminal memotret saat staf menekan Absen, event absen memuat sidik jari (sha256) foto itu, dan fotonya diunggah terpisah.
-- Foto hanya bukti untuk ditinjau manusia; tidak ada pencocokan wajah otomatis.
alter table outlet add column attendance_photo boolean not null default false;

create table attendance_photo (
  tenant_id text not null references tenant (id),
  outlet_id text not null references outlet (id),
  hash      text not null,
  device_id text not null,
  mime      text not null default 'image/jpeg',
  size      integer not null check (size > 0),
  data      bytea not null,
  at_ms     float8 not null,
  primary key (outlet_id, hash)
);

alter table attendance_photo enable row level security;
create policy tenant_isolation on attendance_photo using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert on attendance_photo to app_user;
