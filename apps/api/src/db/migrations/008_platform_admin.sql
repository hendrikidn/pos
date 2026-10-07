-- Konsol admin platform: admin yang membuat tenant dan menerbitkan token owner. Terpisah dari pengguna tenant.
create table platform_admin (
  id         text primary key,
  name       text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
-- Tanpa grant ke app_user: kode yang berjalan atas nama tenant tidak bisa membaca atau mengubah admin platform.

alter table tenant add column created_at timestamptz not null default now();

-- Token pengguna perlu bisa didaftar dan dicabut dari konsol admin tanpa menyimpan atau menampilkan token polosnya.
alter table api_token add column id bigserial;
alter table api_token add column created_at timestamptz not null default now();
alter table api_token add column revoked_at timestamptz;
create unique index api_token_id on api_token (id);
