-- Denah meja per outlet: daftar {no, area, seats}. Kosong = outlet memakai nomor meja bebas (perilaku lama).
alter table outlet add column tables jsonb not null default '[]'::jsonb;
