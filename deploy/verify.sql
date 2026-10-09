-- Pemeriksaan keutuhan hasil pulih (dijalankan restore-test.sh pada database sementara). Satu baris per pemeriksaan: nama|nilai|OK atau GAGAL.
-- :expected_migrations diberikan oleh skrip (jumlah berkas migrasi di repo).
select 'migrasi_terpasang', count(*), case when count(*) >= :expected_migrations then 'OK' else 'GAGAL' end from schema_migration;
select 'tenant', count(*), case when count(*) > 0 then 'OK' else 'GAGAL' end from tenant;
select 'outlet', count(*), case when count(*) > 0 then 'OK' else 'GAGAL' end from outlet;
-- Rantai event per perangkat harus utuh: nomor urut berurutan tanpa lubang, dan setiap event menunjuk hash event sebelumnya.
select 'perangkat_dengan_lubang_seq', count(*), case when count(*) = 0 then 'OK' else 'GAGAL' end
  from (select device_id from event group by device_id having max(seq) <> count(*) or min(seq) <> 1) x;
select 'event_putus_rantai', count(*), case when count(*) = 0 then 'OK' else 'GAGAL' end
  from (select prev_hash, lag(hash) over (partition by device_id order by seq) as before, seq from event) e
  where seq > 1 and prev_hash <> before;
select 'event_total', count(*), 'INFO' from event;
select 'event_terakhir_umur_menit', coalesce(round(extract(epoch from now() - max(server_time)) / 60), -1), 'INFO' from event;
select 'tabel_rls_tanpa_kebijakan', count(*), case when count(*) = 0 then 'OK' else 'GAGAL' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
