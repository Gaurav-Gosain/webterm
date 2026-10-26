/* A streaming sixel decoder (DEC VT330/VT340 sixel graphics, as xterm and
 * foot accept it). Bytes arrive in any split; the image is RGBA.
 *
 * Supported: raster attributes ("), colour introducers in RGB and HLS (#),
 * repeat (!), carriage return ($), next band (-), the VT340 default
 * palette, P2 = 1 transparent background. Images are limited to
 * SIXEL_MAX_W x SIXEL_MAX_H pixels; anything past that is clipped. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SIXEL_MAX_W 4096
#define SIXEL_MAX_H 4096
#define SIXEL_MAX_PIXELS (4096u * 2048u)

typedef struct {
  uint32_t palette[256]; /* 0xAABBGGRR, little-endian RGBA bytes */
  uint32_t color;        /* current colour register */
  int32_t x, y;          /* x in pixels, y = top of the current band */
  int32_t w, h;          /* painted extent */
  int32_t raster_w, raster_h;
  uint32_t* px;          /* cap_w x cap_h, 0 = unset */
  uint8_t* set;          /* 1 where a pixel was painted */
  int32_t cap_w, cap_h;
  bool transparent;
  /* parameter collection for # " ! */
  char cmd;
  int32_t params[8];
  int32_t np;
  bool in_num;
  int32_t repeat;
  bool failed;
} Sixel;

/* Allocation hooks, provided by engine.c. */
static void* sx_alloc(size_t n);
static void sx_free(void* p, size_t n);

static uint32_t sx_rgb(int32_t r, int32_t g, int32_t b) {
  /* r, g, b in percent */
  if (r > 100) r = 100;
  if (g > 100) g = 100;
  if (b > 100) b = 100;
  return 0xFF000000u | ((uint32_t)(b * 255 / 100) << 16) | ((uint32_t)(g * 255 / 100) << 8) | (uint32_t)(r * 255 / 100);
}

/* DEC HLS: hue 0 is blue, 120 red, 240 green. */
static uint32_t sx_hls(int32_t h, int32_t l, int32_t s) {
  double hh = (double)((h + 240) % 360) / 60.0, ll = l / 100.0, ss = s / 100.0;
  double c = (1.0 - (2.0 * ll - 1.0 < 0 ? -(2.0 * ll - 1.0) : 2.0 * ll - 1.0)) * ss;
  double hm = hh - 2.0 * (double)(int)(hh / 2.0);
  double xx = c * (1.0 - (hm - 1.0 < 0 ? -(hm - 1.0) : hm - 1.0));
  double r = 0, g = 0, b = 0;
  if (hh < 1) { r = c; g = xx; } else if (hh < 2) { r = xx; g = c; } else if (hh < 3) { g = c; b = xx; }
  else if (hh < 4) { g = xx; b = c; } else if (hh < 5) { r = xx; b = c; } else { r = c; b = xx; }
  double m = ll - c / 2.0;
  return sx_rgb((int32_t)((r + m) * 100.0 + 0.5), (int32_t)((g + m) * 100.0 + 0.5), (int32_t)((b + m) * 100.0 + 0.5));
}

static const uint8_t VT340[16][3] = {
    {0, 0, 0}, {20, 20, 80}, {80, 13, 13}, {20, 80, 20}, {80, 20, 80}, {20, 80, 80}, {80, 80, 20}, {53, 53, 53},
    {26, 26, 26}, {33, 33, 60}, {60, 26, 26}, {33, 60, 33}, {60, 33, 60}, {33, 60, 60}, {60, 60, 33}, {80, 80, 80}};

static void sixel_init(Sixel* s, int32_t p2) {
  __builtin_memset(s, 0, sizeof(*s));
  for (int i = 0; i < 16; i++) s->palette[i] = sx_rgb(VT340[i][0], VT340[i][1], VT340[i][2]);
  for (int i = 16; i < 256; i++) s->palette[i] = 0xFF000000u;
  s->transparent = p2 == 1;
}

static void sixel_free(Sixel* s) {
  if (s->px) sx_free(s->px, (size_t)s->cap_w * s->cap_h * 4);
  if (s->set) sx_free(s->set, (size_t)s->cap_w * s->cap_h);
  s->px = NULL;
  s->set = NULL;
}

/* Make room for pixel (x, y). Returns false when the image would exceed
 * the limits; the pixel is then dropped. */
static bool sx_reserve(Sixel* s, int32_t x, int32_t y) {
  if (x < s->cap_w && y < s->cap_h) return true;
  if (x >= SIXEL_MAX_W || y >= SIXEL_MAX_H) return false;
  int32_t nw = s->cap_w ? s->cap_w : 256, nh = s->cap_h ? s->cap_h : 96;
  if (s->raster_w > nw && s->raster_w <= SIXEL_MAX_W) nw = s->raster_w;
  if (s->raster_h > nh && s->raster_h <= SIXEL_MAX_H) nh = s->raster_h;
  while (nw <= x) nw *= 2;
  while (nh <= y) nh *= 2;
  if (nw > SIXEL_MAX_W) nw = SIXEL_MAX_W;
  if (nh > SIXEL_MAX_H) nh = SIXEL_MAX_H;
  if ((uint64_t)nw * nh > SIXEL_MAX_PIXELS) return false;
  uint32_t* px = sx_alloc((size_t)nw * nh * 4);
  uint8_t* set = sx_alloc((size_t)nw * nh);
  if (!px || !set) { s->failed = true; return false; }
  __builtin_memset(px, 0, (size_t)nw * nh * 4);
  __builtin_memset(set, 0, (size_t)nw * nh);
  for (int32_t row = 0; row < s->cap_h; row++) {
    __builtin_memcpy(px + (size_t)row * nw, s->px + (size_t)row * s->cap_w, (size_t)s->cap_w * 4);
    __builtin_memcpy(set + (size_t)row * nw, s->set + (size_t)row * s->cap_w, (size_t)s->cap_w);
  }
  sixel_free(s);
  s->px = px;
  s->set = set;
  s->cap_w = nw;
  s->cap_h = nh;
  return true;
}

static void sx_paint(Sixel* s, int32_t bits, int32_t count) {
  if (count < 1) count = 1;
  uint32_t c = s->palette[s->color & 255];
  for (int32_t i = 0; i < 6; i++) {
    if (!(bits & (1 << i))) continue;
    int32_t y = s->y + i;
    if (!sx_reserve(s, s->x + count - 1, y)) {
      if (!sx_reserve(s, 0, y)) continue;
    }
    for (int32_t k = 0; k < count; k++) {
      int32_t x = s->x + k;
      if (x >= s->cap_w) break;
      s->px[(size_t)y * s->cap_w + x] = c;
      s->set[(size_t)y * s->cap_w + x] = 1;
    }
    if (y + 1 > s->h) s->h = y + 1;
  }
  if (s->x + count > s->w) s->w = s->x + count;
  s->x += count;
}

static void sx_finish_cmd(Sixel* s) {
  if (s->in_num || s->np) {
    if (s->np < 8) s->np++;
    s->in_num = false;
  }
  if (s->cmd == '#') {
    if (s->np >= 5) {
      int32_t pc = s->params[0] & 255, pu = s->params[1];
      s->palette[pc] = pu == 1 ? sx_hls(s->params[2], s->params[3], s->params[4])
                               : sx_rgb(s->params[2], s->params[3], s->params[4]);
      s->color = pc;
    } else if (s->np >= 1) {
      s->color = s->params[0] & 255;
    }
  } else if (s->cmd == '"') {
    if (s->np >= 4) {
      s->raster_w = s->params[2];
      s->raster_h = s->params[3];
    }
  } else if (s->cmd == '!') {
    s->repeat = s->np >= 1 ? s->params[0] : 1;
  }
  s->cmd = 0;
  s->np = 0;
  for (int i = 0; i < 8; i++) s->params[i] = 0;
}

static void sixel_feed(Sixel* s, const uint8_t* p, size_t n) {
  for (size_t i = 0; i < n; i++) {
    uint8_t c = p[i];
    if (s->cmd) {
      if (c >= '0' && c <= '9') {
        if (s->np < 8) {
          int32_t v = s->params[s->np] * 10 + (c - '0');
          s->params[s->np] = v > 100000 ? 100000 : v;
        }
        s->in_num = true;
        continue;
      }
      if (c == ';') {
        if (s->np < 8) s->np++;
        s->in_num = false;
        continue;
      }
      sx_finish_cmd(s);
    }
    if (c >= 0x3F && c <= 0x7E) {
      int32_t count = s->repeat ? s->repeat : 1;
      s->repeat = 0;
      sx_paint(s, c - 0x3F, count);
    } else if (c == '#' || c == '"' || c == '!') {
      s->cmd = (char)c;
    } else if (c == '$') {
      s->x = 0;
    } else if (c == '-') {
      s->x = 0;
      s->y += 6;
    }
    /* Anything else (newlines, spaces) is ignored. */
  }
}

/* Final size: the raster attributes when given, grown to what was
 * painted; the height is cropped to the raster height when one was set,
 * because encoders pad the last band to six rows. */
static void sixel_size(Sixel* s, int32_t* w, int32_t* h) {
  int32_t ww = s->w > s->raster_w ? s->w : s->raster_w;
  int32_t hh = s->raster_h > 0 ? s->raster_h : s->h;
  if (ww > s->cap_w) ww = s->cap_w;
  if (hh > s->cap_h) hh = s->cap_h;
  *w = ww;
  *h = hh;
}
