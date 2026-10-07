-- Login dengan email + password. Kode email tetap ada untuk lupa password dan sebagai jalur alternatif.
alter table dashboard_user add column password_hash text;
alter table dashboard_user add column password_set_at timestamptz;
alter table dashboard_user add column failed_logins integer not null default 0;
alter table dashboard_user add column locked_until timestamptz;

-- Kode untuk masuk dan kode untuk mengatur ulang password tidak boleh saling menggantikan.
alter table login_code add column purpose text not null default 'login' check (purpose in ('login', 'reset'));

-- Jalur tenant (app_user) tidak boleh membaca hash password atau status penguncian, meskipun ada bug di kode: hak akses diberikan
-- per kolom. Hanya jalur autentikasi (pemilik skema) yang menyentuh kolom password.
revoke select, insert, update on dashboard_user from app_user;
grant select (id, tenant_id, user_id, email, role, active, created_at, last_login_at) on dashboard_user to app_user;
grant insert (tenant_id, user_id, email, role) on dashboard_user to app_user;
grant update (email, role, active) on dashboard_user to app_user;
