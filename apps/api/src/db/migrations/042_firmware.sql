-- Distribusi firmware sensor (OTA). Rilis ditandatangani di luar server dengan kunci rilis (kunci publiknya ada di firmware dan di FIRMWARE_RELEASE_PUBKEY);
-- server menolak unggahan yang tanda tangannya tidak sah, jadi server yang dibobol tidak bisa mendorong firmware palsu ke sensor.
-- Tabel tingkat platform: tanpa RLS dan tanpa grant ke app_user (kode atas nama tenant tidak bisa membaca atau mengubahnya).
create table firmware_release (
  id             bigserial primary key,
  board          text not null check (board ~ '^[a-z0-9_.-]{2,24}$'),
  channel        text not null check (channel ~ '^[a-z0-9_.-]{2,16}$'),
  version        text not null check (version ~ '^[A-Za-z0-9_.-]{1,24}$'),
  -- Nomor build naik terus per papan dan kanal; perangkat hanya memasang build yang LEBIH BARU (anti-downgrade).
  build          integer not null check (build > 0),
  size           integer not null check (size between 65536 and 1966080),
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  signature      text not null,
  notes          text,
  data           bytea not null,
  created_by     text not null,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  revoked_reason text,
  unique (board, channel, build)
);

-- Versi firmware yang sedang berjalan, dilaporkan perangkat lewat header saat menyetor event.
alter table device add column firmware_build integer;
alter table device add column firmware_version text;
alter table device add column firmware_seen_at timestamptz;
