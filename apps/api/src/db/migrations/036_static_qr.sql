-- QR statis cetak sebagai metode bayar: mati bawaan, hanya bila owner mengaktifkannya per outlet. Setiap pemakaiannya ditandai (R19) bila EDC atau QR dinamis tersedia.
alter table outlet add column static_qr_enabled boolean not null default false;
