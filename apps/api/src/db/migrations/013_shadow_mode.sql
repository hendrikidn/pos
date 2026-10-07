-- Mode shadow (SPEC 8): outlet baru menghitung insiden tetapi tidak mengirimnya selama N hari sejak aktivitas pertama.
-- shadow_days = 0: langsung aktif (semua outlet yang sudah ada). shadow_started_ms diisi saat event pertama yang bermakna masuk.
alter table outlet
  add column shadow_days       integer not null default 0 check (shadow_days between 0 and 60),
  add column shadow_started_ms float8;

-- Insiden yang tercipta selama shadow ditandai dan tidak masuk antrean review maupun notifikasi.
alter table incident add column shadow boolean not null default false;
create index incident_outlet_shadow on incident (outlet_id, shadow, start_ms);
