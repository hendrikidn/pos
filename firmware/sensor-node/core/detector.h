#ifndef SN_DETECTOR_H
#define SN_DETECTOR_H
#include <stdint.h>
#include "ld2410.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Mengubah aliran frame radar menjadi sesi kehadiran customer.
 * Customer dianggap ada bila ada target di zona jarak [zone_min, zone_max] dengan energi di atas ambang,
 * baik bergerak maupun diam. Sesi dimulai setelah ada terus-menerus `start_ms` dan berakhir setelah
 * tidak ada selama `end_ms` (histeresis, agar kedipan sinyal tidak memecah satu kunjungan).
 * Zona jarak dipakai alih-alih konfigurasi gerbang di modul, sehingga tidak perlu perintah konfigurasi radar.
 */

typedef struct {
    uint16_t zone_min_cm;
    uint16_t zone_max_cm;
    uint8_t move_energy_min;
    uint8_t static_energy_min;
    uint32_t start_ms;
    uint32_t end_ms;
    uint32_t pending_gap_ms;
    uint32_t max_session_ms;
    uint32_t no_radar_ms;
    uint32_t blocked_ms;
} det_config_t;

typedef struct {
    int64_t start_ms;
    int64_t end_ms;
    uint8_t peak_move;
    uint8_t peak_static;
} presence_session_t;

typedef enum { DET_OK = 0, DET_NO_RADAR = 1, DET_BLOCKED = 2 } det_health_t;

typedef struct {
    det_config_t cfg;
    int pending;
    int active;
    int64_t pending_start;
    int64_t start;
    int64_t last_in_zone;
    int64_t last_frame;
    int64_t blocked_since;
    uint8_t peak_move;
    uint8_t peak_static;
} detector_t;

void det_default_config(det_config_t *c);
void det_init(detector_t *d, const det_config_t *cfg, int64_t now_ms);
int det_in_zone(const det_config_t *c, const ld2410_frame_t *f);
/*
 * Memajukan waktu ke `now_ms`. `f` boleh NULL (tidak ada frame pada saat ini).
 * Mengembalikan 1 bila sebuah sesi selesai dan terisi di *out.
 */
int det_update(detector_t *d, int64_t now_ms, const ld2410_frame_t *f, presence_session_t *out);
det_health_t det_health(const detector_t *d, int64_t now_ms);
const char *det_health_name(det_health_t h);

#ifdef __cplusplus
}
#endif

#endif
