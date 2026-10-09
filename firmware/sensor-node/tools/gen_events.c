/* Membuat event sensor untuk diuji silang dengan verifikasi rantai hash TypeScript. */
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../core/chain.h"

int main(int argc, char **argv) {
    if (argc < 8) {
        fprintf(stderr, "pakai: gen_events <device> <outlet> <start_seq> <prev_hash|-> <n> <t0_ms> <offset_ms> [terminal]\n");
        return 2;
    }
    chain_t c;
    uint32_t seq = (uint32_t)strtoul(argv[3], NULL, 10);
    if (chain_init(&c, argv[1], argv[2], seq, strcmp(argv[4], "-") ? argv[4] : NULL) != 0) { fprintf(stderr, "id/hash tidak valid\n"); return 3; }
    int n = atoi(argv[5]);
    int64_t t = strtoll(argv[6], NULL, 10);
    c.clock_offset_ms = strtoll(argv[7], NULL, 10);
    const char *terminal = argc > 8 ? argv[8] : NULL;
    char line[CHAIN_LINE_MAX];
    for (int i = 0; i < n; i++) {
        int len;
        if (i % 3 == 2) {
            presence_session_t s = { t - 58000, t, (uint8_t)(40 + i % 50), (uint8_t)(30 + i % 60) };
            len = chain_presence(&c, t, &s, terminal, line, sizeof line);
        } else {
            len = chain_heartbeat(&c, t, i % 7 == 0 ? NULL : "ok", line, sizeof line);
        }
        if (len < 0) { fprintf(stderr, "gagal membuat event %d\n", i); return 4; }
        puts(line);
        t += 30000;
    }
    printf("STATE %" PRIu32 " %s\n", c.seq, c.prev_hash);
    return 0;
}
