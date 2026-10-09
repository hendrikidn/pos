-- Keamanan: verifikasi 2 langkah (TOTP) untuk admin platform, sesi konsol admin yang kedaluwarsa dan bisa dicabut, kode pemulihan sekali pakai,
-- serta metadata sesi pengguna dashboard (kapan terakhir dipakai, dari alamat dan peramban mana) untuk daftar "Sesi aktif".
alter table platform_admin add column totp_secret text;
alter table platform_admin add column totp_pending text;
alter table platform_admin add column totp_enabled boolean not null default false;
-- Langkah waktu (30 dtk) terakhir yang diterima: kode yang sama tidak bisa dipakai dua kali.
alter table platform_admin add column totp_last_step bigint not null default 0;

create table admin_session (
  id         bigserial primary key,
  token_hash text not null unique,
  admin_id   text not null references platform_admin (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip         text,
  user_agent text,
  revoked_at timestamptz
);
create index admin_session_admin on admin_session (admin_id);

create table admin_recovery_code (
  admin_id  text not null references platform_admin (id),
  code_hash text not null,
  used_at   timestamptz,
  primary key (admin_id, code_hash)
);
-- Tanpa grant ke app_user, sama seperti platform_admin: kode yang berjalan atas nama tenant tidak bisa membacanya.

alter table api_token add column last_used_at timestamptz;
alter table api_token add column ip text;
alter table api_token add column user_agent text;
