#include "detector.h"

void det_default_config(det_config_t *c) {
    c->zone_min_cm = 30;
    c->zone_max_cm = 150;
    c->move_energy_min = 25;
    c->static_energy_min = 30;
    c->start_ms = 2000;
    c->end_ms = 5000;
    c->pending_gap_ms = 1000;
    c->max_session_ms = 15 * 60 * 1000;
    c->no_radar_ms = 5000;
    c->blocked_ms = 60 * 1000;
}

void det_init(detector_t *d, const det_config_t *cfg, int64_t now_ms) {
    d->cfg = *cfg;
    d->pending = 0;
    d->active = 0;
    d->pending_start = d->start = d->last_in_zone = 0;
    d->last_frame = now_ms;
    d->blocked_since = -1;
    d->peak_move = d->peak_static = 0;
}

int det_in_zone(const det_config_t *c, const ld2410_frame_t *f) {
    if (f->state == 0) return 0;
    int move = (f->state & 1) && f->move_energy >= c->move_energy_min && f->move_dist_cm >= c->zone_min_cm && f->move_dist_cm <= c->zone_max_cm;
    int still = (f->state & 2) && f->static_energy >= c->static_energy_min && f->static_dist_cm >= c->zone_min_cm && f->static_dist_cm <= c->zone_max_cm;
    return move || still;
}

static void track_peaks(detector_t *d, const ld2410_frame_t *f) {
    if (f->move_energy > d->peak_move) d->peak_move = f->move_energy;
    if (f->static_energy > d->peak_static) d->peak_static = f->static_energy;
}

static void emit(detector_t *d, int64_t end, presence_session_t *out) {
    out->start_ms = d->start;
    out->end_ms = end;
    out->peak_move = d->peak_move;
    out->peak_static = d->peak_static;
}

int det_update(detector_t *d, int64_t now, const ld2410_frame_t *f, presence_session_t *out) {
    int in = 0;
    if (f) {
        d->last_frame = now;
        in = det_in_zone(&d->cfg, f);
        /* Sensor tertutup benda: target diam berenergi maksimum tepat di depan antena. */
        if ((f->state & 2) && f->static_dist_cm <= 5 && f->static_energy >= 95) {
            if (d->blocked_since < 0) d->blocked_since = now;
        } else {
            d->blocked_since = -1;
        }
    }

    if (in) {
        d->last_in_zone = now;
        if (!d->pending && !d->active) {
            d->pending = 1;
            d->pending_start = now;
            d->peak_move = d->peak_static = 0;
        }
        track_peaks(d, f);
        if (d->pending && !d->active && now - d->pending_start >= (int64_t)d->cfg.start_ms) {
            d->active = 1;
            d->start = d->pending_start;
        }
        if (d->active && now - d->start >= (int64_t)d->cfg.max_session_ms) {
            /* Kunjungan sangat lama (mis. benda diam di zona): dipecah agar tetap terlapor. */
            emit(d, now, out);
            d->start = now;
            d->peak_move = d->peak_static = 0;
            track_peaks(d, f);
            return 1;
        }
        return 0;
    }

    if (d->pending && !d->active && now - d->last_in_zone >= (int64_t)d->cfg.pending_gap_ms) d->pending = 0;
    if (d->active && now - d->last_in_zone >= (int64_t)d->cfg.end_ms) {
        emit(d, d->last_in_zone, out);
        d->active = 0;
        d->pending = 0;
        return 1;
    }
    return 0;
}

det_health_t det_health(const detector_t *d, int64_t now) {
    if (now - d->last_frame > (int64_t)d->cfg.no_radar_ms) return DET_NO_RADAR;
    if (d->blocked_since >= 0 && now - d->blocked_since >= (int64_t)d->cfg.blocked_ms) return DET_BLOCKED;
    return DET_OK;
}

const char *det_health_name(det_health_t h) {
    return h == DET_OK ? "ok" : h == DET_NO_RADAR ? "no_radar" : "blocked";
}
