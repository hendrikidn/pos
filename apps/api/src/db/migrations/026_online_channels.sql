-- Kanal pesan-antar yang diaktifkan per outlet: [{channel, commissionPercent}]. Kosong = tidak ada pesanan online.
alter table outlet add column online_channels jsonb not null default '[]'::jsonb;
