-- Penangguhan tenant oleh admin platform; owner mengelola outlet sendiri; indeks untuk KPI.
alter table tenant add column suspended_at timestamptz;
alter table tenant add column suspended_reason text;

-- Owner membuat outlet baru atas nama tenantnya (RLS tenant_isolation tetap memaksa tenant_id sama).
grant insert on outlet to app_user;

-- KPI platform menghitung event per tenant, jenis, dan waktu.
create index event_tenant_type_time on event (tenant_id, type, device_time_ms);
