-- Pembatas laju bersama untuk endpoint publik, login, pairing, dan pendaftaran. Sebelumnya di memori proses: hilang saat restart, tidak
-- berlaku antar-instance, dan direset total bila terlalu banyak alamat. Hanya diakses lewat koneksi pemilik skema (bukan jalur tenant).
create table rate_limit (
  key         text primary key,
  count       integer not null,
  reset_at_ms float8 not null
);
create index rate_limit_reset on rate_limit (reset_at_ms);
