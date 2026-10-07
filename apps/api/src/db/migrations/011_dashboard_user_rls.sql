-- Owner mengelola pengguna dashboard tenantnya sendiri. Jalur login tetap memakai koneksi pemilik skema (melewati RLS);
-- jalur owner memakai app_user sehingga RLS memaksa tenant_id sama dengan tenant pemanggil.
alter table dashboard_user enable row level security;
create policy tenant_isolation on dashboard_user
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, update on dashboard_user to app_user;
grant usage on all sequences in schema public to app_user;
