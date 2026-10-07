-- Login owner dengan email dan kode sekali pakai (menggantikan token sebagai jalur utama).
-- Tabel ini hanya diakses lewat koneksi pemilik skema (jalur autentikasi sebelum tenant diketahui); tanpa grant ke app_user.

create table dashboard_user (
  id            bigserial primary key,
  tenant_id     text not null references tenant (id),
  -- Sama dengan api_token.user_id: dipakai untuk audit dan untuk menyaring insiden milik pengguna itu sendiri.
  user_id       text not null,
  email         text not null,
  role          text not null check (role in ('OWNER', 'OPS', 'MANAGER', 'SUPERVISOR')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz,
  unique (tenant_id, user_id)
);
-- Satu email milik satu pengguna di seluruh platform (login tidak menanyakan tenant).
create unique index dashboard_user_email on dashboard_user (lower(email));

create table login_code (
  id         bigserial primary key,
  user_ref   bigint not null references dashboard_user (id),
  code_hash  text not null,
  salt       text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts   integer not null default 0,
  used_at    timestamptz
);
create index login_code_user on login_code (user_ref, created_at);

-- Sesi hasil login email adalah baris api_token yang kedaluwarsa; `session` memisahkannya dari token tetap yang diterbitkan admin.
alter table api_token add column expires_at timestamptz;
alter table api_token add column session boolean not null default false;
