-- Foto menu: satu gambar kecil per menu (sudah dikecilkan di dashboard). `image_version` = sidik jari isi, ikut dikirim di konfigurasi
-- terminal agar terminal tahu kapan harus mengunduh ulang tanpa ikut mengunduh gambarnya di setiap pembaruan konfigurasi.
alter table menu_item
  add column image bytea,
  add column image_type text check (image_type in ('image/jpeg', 'image/png', 'image/webp')),
  add column image_version text,
  add constraint menu_image_all_or_none check ((image is null) = (image_type is null) and (image is null) = (image_version is null));
