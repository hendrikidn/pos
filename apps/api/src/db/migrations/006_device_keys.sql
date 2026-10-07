-- Kunci publik perangkat (ECDSA P-256, SPKI DER base64) dan tanda tangan event.
-- Setelah kunci terdaftar, event perangkat itu wajib bertanda tangan sah; token saja tidak cukup untuk memalsukan event.
alter table device add column public_key text;
alter table event add column sig text;
