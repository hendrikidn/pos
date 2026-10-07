/*
 * Memutar ulang rekaman frame radar ke pembaca dan detektor.
 * Masukan (stdin), satu perintah per baris:
 *   F <ts_ms> <hex>   byte mentah yang diterima pada waktu ts
 *   T <ts_ms>         waktu berjalan tanpa frame
 *   H <ts_ms>         cetak status kesehatan
 * Opsi baris perintah: kunci=nilai (zone_min, zone_max, move_min, static_min, start, end, pending_gap, max_session, no_radar, blocked)
 */
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../core/detector.h"
#include "../core/ld2410.h"

static int hexval(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void print_session(const presence_session_t *s) {
    printf("{\"start\":%" PRId64 ",\"end\":%" PRId64 ",\"peakMove\":%u,\"peakStatic\":%u}\n", s->start_ms, s->end_ms, s->peak_move, s->peak_static);
}

int main(int argc, char **argv) {
    det_config_t cfg;
    det_default_config(&cfg);
    for (int i = 1; i < argc; i++) {
        char *eq = strchr(argv[i], '=');
        if (!eq) continue;
        *eq = 0;
        uint32_t v = (uint32_t)strtoul(eq + 1, NULL, 10);
        if (!strcmp(argv[i], "zone_min")) cfg.zone_min_cm = (uint16_t)v;
        else if (!strcmp(argv[i], "zone_max")) cfg.zone_max_cm = (uint16_t)v;
        else if (!strcmp(argv[i], "move_min")) cfg.move_energy_min = (uint8_t)v;
        else if (!strcmp(argv[i], "static_min")) cfg.static_energy_min = (uint8_t)v;
        else if (!strcmp(argv[i], "start")) cfg.start_ms = v;
        else if (!strcmp(argv[i], "end")) cfg.end_ms = v;
        else if (!strcmp(argv[i], "pending_gap")) cfg.pending_gap_ms = v;
        else if (!strcmp(argv[i], "max_session")) cfg.max_session_ms = v;
        else if (!strcmp(argv[i], "no_radar")) cfg.no_radar_ms = v;
        else if (!strcmp(argv[i], "blocked")) cfg.blocked_ms = v;
    }
    detector_t d;
    ld2410_parser_t p;
    det_init(&d, &cfg, 0);
    ld2410_init(&p);

    static char line[4096];
    while (fgets(line, sizeof line, stdin)) {
        char kind = line[0];
        char *rest = line + 1;
        int64_t ts = strtoll(rest, &rest, 10);
        presence_session_t s;
        if (kind == 'F') {
            while (*rest == ' ') rest++;
            for (; hexval(rest[0]) >= 0 && hexval(rest[1]) >= 0; rest += 2) {
                ld2410_frame_t f;
                if (ld2410_feed(&p, (uint8_t)(hexval(rest[0]) * 16 + hexval(rest[1])), &f)) {
                    if (det_update(&d, ts, &f, &s)) print_session(&s);
                }
            }
        } else if (kind == 'T') {
            if (det_update(&d, ts, NULL, &s)) print_session(&s);
        } else if (kind == 'H') {
            printf("{\"health\":\"%s\",\"framesOk\":%u,\"framesBad\":%u}\n", det_health_name(det_health(&d, ts)), p.frames_ok, p.frames_bad);
        }
    }
    return 0;
}
