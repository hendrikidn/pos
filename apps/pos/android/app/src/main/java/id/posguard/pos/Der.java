package id.posguard.pos;

import java.util.Arrays;

/** Konversi tanda tangan ECDSA dari DER (keluaran Android Keystore) ke r||s tetap (format IEEE P1363 yang dipakai server). */
final class Der {
    private Der() {}

    /** @param size panjang tiap bilangan dalam byte (32 untuk P-256) */
    static byte[] toRaw(byte[] der, int size) {
        int[] pos = {0};
        expect(der, pos, 0x30);
        readLength(der, pos); // panjang SEQUENCE; isi diperiksa lewat batas array
        byte[] r = readInteger(der, pos);
        byte[] s = readInteger(der, pos);
        byte[] out = new byte[size * 2];
        copyRight(r, out, 0, size);
        copyRight(s, out, size, size);
        return out;
    }

    private static void expect(byte[] d, int[] pos, int tag) {
        if (pos[0] >= d.length || (d[pos[0]++] & 0xff) != tag) throw new IllegalArgumentException("DER tidak valid");
    }

    private static int readLength(byte[] d, int[] pos) {
        if (pos[0] >= d.length) throw new IllegalArgumentException("DER terpotong");
        int b = d[pos[0]++] & 0xff;
        if (b < 0x80) return b;
        int n = b & 0x7f;
        if (n < 1 || n > 2 || pos[0] + n > d.length) throw new IllegalArgumentException("panjang DER tidak didukung");
        int len = 0;
        for (int i = 0; i < n; i++) len = (len << 8) | (d[pos[0]++] & 0xff);
        return len;
    }

    private static byte[] readInteger(byte[] d, int[] pos) {
        expect(d, pos, 0x02);
        int len = readLength(d, pos);
        if (len < 1 || pos[0] + len > d.length) throw new IllegalArgumentException("DER terpotong");
        byte[] v = Arrays.copyOfRange(d, pos[0], pos[0] + len);
        pos[0] += len;
        return v;
    }

    private static void copyRight(byte[] v, byte[] out, int offset, int size) {
        int start = 0;
        while (start < v.length - 1 && v[start] == 0) start++; // buang nol pengisi tanda
        int len = v.length - start;
        if (len > size) throw new IllegalArgumentException("bilangan terlalu besar");
        System.arraycopy(v, start, out, offset + size - len, len);
    }
}
