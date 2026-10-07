#ifndef SN_LD2410_H
#define SN_LD2410_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Pembaca frame data HLK-LD2410 (mode keluaran dasar maupun rekayasa; hanya bagian dasarnya yang dibaca).
 * UART 256000 baud 8N1. Frame data: F4 F3 F2 F1 | panjang (2 byte LE) | isi | F8 F7 F6 F5.
 * Isi: [tipe 0x01/0x02] 0xAA [status] [jarak gerak 2 LE cm] [energi gerak] [jarak diam 2 LE cm]
 *      [energi diam] [jarak deteksi 2 LE cm] ... 0x55 0x00
 * Status: 0 tidak ada, 1 bergerak, 2 diam, 3 gerak+diam. Energi 0-100.
 * Frame respons perintah (FD FC FB FA) diabaikan.
 */

typedef struct {
    uint8_t state;
    uint16_t move_dist_cm;
    uint8_t move_energy;
    uint16_t static_dist_cm;
    uint8_t static_energy;
    uint16_t detect_dist_cm;
    uint8_t engineering;
} ld2410_frame_t;

typedef struct {
    uint8_t buf[80];
    size_t len;      /* byte isi terkumpul */
    size_t want;     /* panjang isi yang diharapkan */
    uint8_t stage;   /* 0..3 mencari header, 4..5 panjang, 6 isi, 7..10 ekor */
    uint8_t tail_i;
    uint32_t frames_ok;
    uint32_t frames_bad;
} ld2410_parser_t;

void ld2410_init(ld2410_parser_t *p);
/* Menyuapkan satu byte. Mengembalikan 1 bila satu frame lengkap dan valid selesai dibaca ke *out. */
int ld2410_feed(ld2410_parser_t *p, uint8_t b, ld2410_frame_t *out);

#ifdef __cplusplus
}
#endif

#endif
