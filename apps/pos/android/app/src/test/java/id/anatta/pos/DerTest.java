package id.anatta.pos;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class DerTest {
    private static byte[] hex(String s) {
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return b;
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    @Test
    public void bilanganPendekDiisiNolDiKiri() {
        // SEQUENCE { INTEGER 0x0102, INTEGER 0x03 }
        byte[] raw = Der.toRaw(hex("3007020201020201" + "03"), 4);
        assertEquals("0000010200000003", hex(raw));
    }

    @Test
    public void nolPengisiTandaDibuang() {
        // r = 0x00 FF 80 (positif, bit atas menyala) dan s = 0x7F
        byte[] raw = Der.toRaw(hex("300802030" + "0ff80" + "02017f"), 4);
        assertEquals("0000ff800000007f", hex(raw));
    }

    @Test
    public void panjangPenuh32Byte() {
        String r = "00" + "ab".repeat(32); // 33 byte: nol pengisi + 32 byte
        String s = "11".repeat(32);
        String body = "0221" + r + "0220" + s;
        byte[] der = hex("3045" + body);
        byte[] raw = Der.toRaw(der, 32);
        assertEquals(64, raw.length);
        assertEquals("ab".repeat(32) + "11".repeat(32), hex(raw));
    }

    @Test
    public void masukanRusakDitolak() {
        assertThrows(IllegalArgumentException.class, () -> Der.toRaw(hex("0000"), 32));
        assertThrows(IllegalArgumentException.class, () -> Der.toRaw(hex("3006020501"), 32)); // terpotong
        assertThrows(IllegalArgumentException.class, () -> Der.toRaw(new byte[0], 32));
        // bilangan 33 byte tanpa nol pengisi tidak muat di 32 byte
        assertThrows(IllegalArgumentException.class, () -> Der.toRaw(hex("3025" + "0221" + "01".repeat(33) + "020101"), 32));
    }

    @Test
    public void hasilBerukuranTetap() {
        assertArrayEquals(new byte[8], Der.toRaw(hex("3006020100020100"), 4));
    }
}
