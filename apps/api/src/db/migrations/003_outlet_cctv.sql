-- Pengaturan CCTV per outlet, dipakai dashboard untuk jendela rekaman dan sisa hari retensi.
alter table outlet
  add column cctv_retention_days   integer not null default 7 check (cctv_retention_days between 1 and 365),
  -- Selisih jam NVR terhadap jam sebenarnya (detik); positif jika jam NVR lebih cepat.
  add column cctv_clock_offset_sec integer not null default 0;
