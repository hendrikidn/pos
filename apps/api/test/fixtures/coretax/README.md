# Skema dan contoh Coretax (sumber: DJP)

Berkas di sini diambil dari templat resmi DJP (https://www.pajak.go.id/reformdjp/coretax/template-xml-dan-converter-excel-ke-xml):
- `bpa1.xsd`, `bpmp.xsd`: skema XML yang tertanam di berkas konverter resmi (`BPA1 Excel to XML.xlsx`, `BPMP Excel to XML v.3.xlsx`), diekstrak tanpa diubah.
- `bpa1-contoh-djp.xml`, `bpmp-contoh-djp.xml`: XML contoh dari `bpa1.zip` dan `bpmp.zip` milik DJP.
Dipakai tes untuk memvalidasi XML buatan kita dengan `xmllint --schema`. Catatan: XSD BPMP v.3 mencantumkan nilai `ECT` sedangkan contoh DJP memakai `ETC` (ketidakkonsistenan di sisi DJP); kita hanya menulis `N/A`.
Periksa ulang templat di situs DJP bila format Coretax berubah.
