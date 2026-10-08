# Acuan desain POS Anatta (dari `sample_ui/`, diamati 8 Okt 2026)

Dua rekaman layar: **Majoo** (Android, "Cara Memproses Pesanan dan Menerima Pembayaran") dan **Moka** (iPad). Catatan ini bukan salinan: pola yang kita adopsi, dan padanannya.

## Pola yang dipakai kedua produk
| Pola | Majoo | Moka | Padanan di Anatta POS |
|---|---|---|---|
| Grid foto menu | 3 kolom, lencana stok di sudut (Hampir Habis kuning, Stok Habis merah, Varian, Grosir) | 4 kolom foto + nama | Grid foto (fallback inisial berwarna) + lencana stok dari modul stok |
| Kategori | Sidebar kiri bernama | Tab bawah Favourites/Library/Custom | Sidebar kategori di tablet, chip di ponsel |
| Keranjang | Panel yang meluncur dari kanan; baris `Pajak 10%`; tombol **Bayar Rp …** menempel | Panel tetap di kanan; **Save Bill / Print Bill / Charge** + ikon Split Bill | Panel kanan tetap; baris Subtotal, Diskon, **Service charge**, **PBJT**, **Pembulatan**, Total |
| Jenis penjualan | Dropdown "Jenis Order" | Dialog "Select Sales Type": Dine In, GoFood, GoStore, Take Away | Sumber order (Dine-in, Take-away, GoFood, GrabFood, ShopeeFood, Online) |
| Varian | Dialog | Dialog: Variation (pilih satu), Add on (pilih banyak), Quantity, Discount | Sudah ada (`ModifierDialog`) |
| Layar bayar | Halaman penuh: **Total Tagihan / Sisa Tagihan / Kembalian** di atas; aksi Pisah Bayar · Jadikan Invoice · Catatan; sidebar metode (Tunai, Nontunai, Transfer, QRIS, Komplimen, Deposit); ringkasan pesanan di kanan | Lembar: nominal tunai cepat, lalu grup EDC / E-Wallet (logo) / bank | Halaman bayar: tiga angka di atas, daftar pembayaran sebagian, sidebar metode dengan logo, ringkasan di kanan |
| Layar sukses | "Sukses!" + rincian metode + Kembalian; **Bagikan Struk · Cetak · Selesai** | Kembalian besar + centang; Email/SMS receipt; Print Receipt; New Sale | "Pembayaran berhasil": kembalian besar, QR struk digital, Cetak, Selesai |
| Warna | Hijau teal, latar putih | Biru tua, latar putih | Tetap palet krem + hijau kita (jangan menyalin merek) |

## Yang SENGAJA berbeda (nilai tambah anti-fraud)
- Tidak ada "Komplimen"/"Deposit" bebas: metode tanpa uang masuk harus lewat approval supervisor (kontrol CF5) dan tercatat.
- Tidak ada tombol "Custom Produk" harga bebas di kasir (celah manipulasi harga).
- Tiap pembayaran non-tunai menampilkan pengingat nama merchant resmi (pencegah QR pribadi).
