#include "ld2410.h"
#include <string.h>

static const uint8_t HEADER[4] = {0xF4, 0xF3, 0xF2, 0xF1};
static const uint8_t TAIL[4] = {0xF8, 0xF7, 0xF6, 0xF5};
#define MIN_PAYLOAD 13
#define MAX_PAYLOAD 64

void ld2410_init(ld2410_parser_t *p) { memset(p, 0, sizeof *p); }

static void resync(ld2410_parser_t *p) {
    p->stage = 0;
    p->len = 0;
    p->tail_i = 0;
}

static int decode(const uint8_t *d, size_t n, ld2410_frame_t *out) {
    if (n < MIN_PAYLOAD || d[1] != 0xAA) return 0;
    if (d[0] != 0x01 && d[0] != 0x02) return 0;
    if (d[n - 2] != 0x55 || d[n - 1] != 0x00) return 0;
    if (d[2] > 3) return 0;
    out->engineering = d[0] == 0x01;
    out->state = d[2];
    out->move_dist_cm = (uint16_t)(d[3] | (d[4] << 8));
    out->move_energy = d[5];
    out->static_dist_cm = (uint16_t)(d[6] | (d[7] << 8));
    out->static_energy = d[8];
    out->detect_dist_cm = (uint16_t)(d[9] | (d[10] << 8));
    if (out->move_energy > 100 || out->static_energy > 100) return 0;
    return 1;
}

int ld2410_feed(ld2410_parser_t *p, uint8_t b, ld2410_frame_t *out) {
    switch (p->stage) {
    case 0: case 1: case 2: case 3:
        if (b == HEADER[p->stage]) p->stage++;
        else p->stage = (b == HEADER[0]) ? 1 : 0; /* byte ini mungkin awal header baru */
        return 0;
    case 4:
        p->want = b;
        p->stage = 5;
        return 0;
    case 5:
        p->want |= (size_t)b << 8;
        if (p->want < MIN_PAYLOAD || p->want > MAX_PAYLOAD) {
            p->frames_bad++;
            resync(p);
        } else {
            p->len = 0;
            p->stage = 6;
        }
        return 0;
    case 6:
        p->buf[p->len++] = b;
        if (p->len == p->want) { p->stage = 7; p->tail_i = 0; }
        return 0;
    default: /* ekor */
        if (b != TAIL[p->tail_i]) {
            p->frames_bad++;
            resync(p);
            if (b == HEADER[0]) p->stage = 1;
            return 0;
        }
        if (++p->tail_i < 4) return 0;
        {
            int ok = decode(p->buf, p->len, out);
            if (ok) p->frames_ok++; else p->frames_bad++;
            resync(p);
            return ok;
        }
    }
}
