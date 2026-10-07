#include "chain.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "sha256.h"

static int safe_id(const char *s) {
    size_t n = strlen(s);
    if (n == 0 || n > 47) return 0;
    for (size_t i = 0; i < n; i++) {
        char ch = s[i];
        int ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' || ch == ':';
        if (!ok) return 0;
    }
    return 1;
}

static int is_hex64(const char *s) {
    if (strlen(s) != 64) return 0;
    for (int i = 0; i < 64; i++) {
        char ch = s[i];
        if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return 0;
    }
    return 1;
}

int chain_init(chain_t *c, const char *device_id, const char *outlet_id, uint32_t seq, const char *prev_hash) {
    if (!safe_id(device_id) || !safe_id(outlet_id)) return -1;
    const char *h = prev_hash ? prev_hash : CHAIN_GENESIS;
    if (!is_hex64(h)) return -1;
    memset(c, 0, sizeof *c);
    strcpy(c->device_id, device_id);
    strcpy(c->outlet_id, outlet_id);
    strcpy(c->prev_hash, h);
    c->seq = seq;
    return 0;
}

static int emit(chain_t *c, int64_t device_time_ms, const char *type, const char *payload, char *out, size_t cap) {
    uint32_t seq = c->seq + 1;
    char canon[CHAIN_EVENT_MAX];
    /* Kunci terurut: actorId, clockOffsetMs, deviceId, deviceTime, id, outletId, payload, prevHash, seq, type, v */
    int n = snprintf(canon, sizeof canon,
        "{\"actorId\":null,\"clockOffsetMs\":%" PRId64 ",\"deviceId\":\"%s\",\"deviceTime\":%" PRId64
        ",\"id\":\"%s:%" PRIu32 "\",\"outletId\":\"%s\",\"payload\":%s,\"prevHash\":\"%s\",\"seq\":%" PRIu32
        ",\"type\":\"%s\",\"v\":1}",
        c->clock_offset_ms, c->device_id, device_time_ms, c->device_id, seq, c->outlet_id, payload, c->prev_hash, seq, type);
    if (n < 0 || (size_t)n >= sizeof canon) return -1;

    sha256_ctx ctx;
    uint8_t digest[32];
    char hex[65];
    sha256_init(&ctx);
    sha256_update(&ctx, c->prev_hash, strlen(c->prev_hash));
    sha256_update(&ctx, canon, (size_t)n);
    sha256_final(&ctx, digest);
    sha256_hex(digest, hex);

    /* Hash disisipkan sebelum '}' penutup. Urutan kunci pada hasil akhir tidak memengaruhi verifikasi server. */
    int m = snprintf(out, cap, "%.*s,\"hash\":\"%s\"}", n - 1, canon, hex);
    if (m < 0 || (size_t)m >= cap) return -1;

    c->seq = seq;
    memcpy(c->prev_hash, hex, 65);
    return m;
}

int chain_presence(chain_t *c, int64_t device_time_ms, const presence_session_t *s, const char *terminal_id, char *out, size_t cap) {
    char payload[200];
    int n;
    if (terminal_id && terminal_id[0]) {
        if (!safe_id(terminal_id)) return -1;
        n = snprintf(payload, sizeof payload,
            "{\"end\":%" PRId64 ",\"peakMove\":%u,\"peakStatic\":%u,\"start\":%" PRId64 ",\"terminalId\":\"%s\"}",
            s->end_ms, (unsigned)s->peak_move, (unsigned)s->peak_static, s->start_ms, terminal_id);
    } else {
        n = snprintf(payload, sizeof payload,
            "{\"end\":%" PRId64 ",\"peakMove\":%u,\"peakStatic\":%u,\"start\":%" PRId64 "}",
            s->end_ms, (unsigned)s->peak_move, (unsigned)s->peak_static, s->start_ms);
    }
    if (n < 0 || (size_t)n >= sizeof payload) return -1;
    return emit(c, device_time_ms, "presence.session", payload, out, cap);
}

int chain_heartbeat(chain_t *c, int64_t device_time_ms, const char *status, char *out, size_t cap) {
    char payload[96];
    int n;
    if (status && status[0]) {
        if (strcmp(status, "ok") && strcmp(status, "no_radar") && strcmp(status, "blocked")) return -1;
        n = snprintf(payload, sizeof payload, "{\"kind\":\"sensor\",\"status\":\"%s\"}", status);
    } else {
        n = snprintf(payload, sizeof payload, "{\"kind\":\"sensor\"}");
    }
    if (n < 0 || (size_t)n >= sizeof payload) return -1;
    return emit(c, device_time_ms, "device.heartbeat", payload, out, cap);
}
