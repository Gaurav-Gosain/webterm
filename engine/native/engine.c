/* fast-webterm engine: libghostty-vt plus a frame builder in one module.
 *
 * The VT and the instance builder share linear memory, so a cell is read
 * from Ghostty's page and written into the GPU instance buffer without ever
 * becoming a JS value. JS sees three things per frame: a row-dirty byte
 * array, the instance buffer (12 bytes per cell) to upload by row range,
 * and a short list of glyphs it has to rasterize into the atlas.
 *
 * The same file builds natively (for the accuracy reference) and for
 * wasm32-freestanding (for the browser). */
#include <ghostty/vt.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "diacritics.h"
#ifdef ENGINE_PNG
/* Declarations only: libghostty-vt already links the Wuffs PNG decoder. */
#include "wuffs-v0.4.c"
#endif

#ifdef __wasm__
#define EXPORT(name) __attribute__((export_name(#name)))
#else
#define EXPORT(name)
#endif

#define MEMCPY __builtin_memcpy
#define MEMSET __builtin_memset

/* Instance word 0 layout. Slot 0 is the empty glyph. */
#define I_SLOT_MASK 0xFFFFFu
#define I_WIDE (1u << 20)
#define I_TAIL (1u << 21)
#define I_UL_SHIFT 22 /* 3 bits: GhosttySgrUnderline */
#define I_STRIKE (1u << 25)
#define I_OVERLINE (1u << 26)
#define I_FAINT (1u << 27)
#define I_BLINK (1u << 28)
#define I_CURSOR_OK (1u << 29) /* reserved */

/* Packed GhosttyCell layout for the pinned commit (src/terminal/page.zig).
 * eng_selftest() checks it against ghostty_cell_get() at startup. */
#define C_TAG(r) ((uint32_t)((r)&3u))
#define C_CP(r) ((uint32_t)(((r) >> 2) & 0x1FFFFFu))
#define C_STYLE(r) ((uint32_t)(((r) >> 26) & 0xFFFFu))
#define C_WIDE(r) ((uint32_t)(((r) >> 42) & 3u))

#define PLACEHOLDER_CP 0x10EEEEu /* kitty graphics unicode placeholder */
#define GT_CAP 32768u /* glyph table limit, power of two */
#define RUNS_PER_ROW 16u
#define RUN_WORDS 5u
#define RUN_MAX 64u /* cells in one shaped run */
#define GT_START 2048u /* initial glyph table, grows by doubling */
#define ARENA_CAP (1u << 20) /* text arena limit */
#define ARENA_START (32u << 10)
#define MISS_CAP 4096u
#define IN_CAP (256u << 10) /* JS writes in slices of this size */

#include "sixel.c"

typedef struct {
  uint64_t key;
  uint32_t slot;
  uint32_t text;
  uint16_t len;
  uint8_t used;
  uint8_t width;
} GEnt;

typedef struct {
  uint32_t slot;
  uint32_t text;
  uint32_t meta; /* len | width << 16 | style << 24 */
} Miss;

typedef struct Eng {
  GhosttyTerminal t;
  GhosttyRenderState rs;
  GhosttyRenderStateRowIterator it;
  GhosttyRenderStateRowCells cells;
  uint16_t cols, rows;
  uint32_t cw, ch;
  bool held;
  bool need_capture; /* a draw happened since the last hold capture */
  /* frame outputs */
  uint32_t* inst;    /* cols*rows*3 */
  uint8_t* row_dirty; /* rows */
  uint32_t cursor[6]; /* x, y, visible, style, blink, color */
  uint32_t colors[3]; /* fg, bg, cursor */
  /* glyph cache */
  GEnt* table;
  uint32_t* slot_text; /* slot -> arena offset */
  uint16_t* slot_len;
  uint8_t* arena;
  uint32_t arena_len;
  uint32_t next_slot, max_slots, slots_per_row;
  uint32_t gt_cap, arena_cap, gt_used;
  /* shaped runs (Arabic, Hebrew, Indic): per row up to RUNS_PER_ROW entries of
   * x, n, slot, fg, flags; drawn over the cells as one glyph each */
  uint32_t* runs;
  uint8_t* run_n;
  uint8_t* cls;
  uint32_t atlas_gen;
  Miss* miss;
  uint32_t miss_n;
  uint8_t* in; /* input staging for JS */
  uint8_t* dump;
  uint32_t dump_len;
  uint32_t stats[8];
  /* bytes headed to the PTY: encoded keys, mouse, paste, focus, and the
   * terminal's own replies (DA, DSR, ...) */
  uint8_t* out;
  uint32_t out_len, out_cap;
  GhosttyKeyEncoder kenc;
  GhosttyKeyEvent kev;
  GhosttyMouseEncoder menc;
  GhosttyMouseEvent mev;
  /* events for the page: [kind u32][len u32][bytes, padded to 4] ... */
  uint8_t* ev;
  uint32_t ev_len, ev_cap;
  GhosttySelectionGesture gesture;
  GhosttySelectionGestureEvent gpress, gdrag, grelease, gtick;
  uint8_t* sel_text;
  size_t sel_len;
  /* sixel: a pre-scan finds DCS q sequences before Ghostty sees them */
  uint8_t sx_state;
  uint8_t sx_hdr[40];
  uint32_t sx_hdr_len;
  Sixel* sx;
  uint32_t next_sixel_id;
  uint32_t bg_rgb;
  /* graphics: placements and placeholder cells for the frame */
  GhosttyKittyGraphicsPlacementIterator pit;
  float* gfx;       /* per entry: id, layer, dst x y w h, src x y w h (floats) */
  uint32_t gfx_n, gfx_cap;
  uint32_t* ph;     /* placeholder cells: x, y, image id, placement id, row, col */
  uint32_t ph_n, ph_cap;
  uint64_t gfx_gen;
  /* search */
  GhosttySearch search;
  bool searching, searching_changed;
  GhosttySelection* matches;
  size_t matches_cap;
  uint32_t hl_fg, hl_bg, hl_sel_fg, hl_sel_bg;
} Eng;

static void* xalloc(size_t n) {
  uint8_t* p = ghostty_alloc(NULL, n);
  if (p) MEMSET(p, 0, n);
  return p;
}

static void* sx_alloc(size_t n) { return ghostty_alloc(NULL, n); }
static void sx_free(void* p, size_t n) { ghostty_free(NULL, p, n); }

static uint32_t rgb(GhosttyColorRgb c) {
  return (uint32_t)c.r | ((uint32_t)c.g << 8) | ((uint32_t)c.b << 16);
}

static void out_put(Eng* e, const uint8_t* p, size_t n) {
  if (!n) return;
  if (e->out_len + n > e->out_cap) {
    uint32_t cap = e->out_cap ? e->out_cap : 4096;
    while (cap < e->out_len + n) cap *= 2;
    uint8_t* next = ghostty_alloc(NULL, cap);
    if (!next) return;
    if (e->out_len) MEMCPY(next, e->out, e->out_len);
    if (e->out) ghostty_free(NULL, e->out, e->out_cap);
    e->out = next;
    e->out_cap = cap;
  }
  MEMCPY(e->out + e->out_len, p, n);
  e->out_len += (uint32_t)n;
}

/* Event kinds posted to the page. */
#define EV_TITLE 1
#define EV_BELL 2
#define EV_CLIPBOARD 3

static void ev_put(Eng* e, uint32_t kind, const uint8_t* p, size_t n, uint8_t prefix, bool has_prefix) {
  size_t body = n + (has_prefix ? 1 : 0);
  size_t need = 8 + ((body + 3) & ~(size_t)3);
  if (e->ev_len + need > e->ev_cap) {
    uint32_t cap = e->ev_cap ? e->ev_cap : 4096;
    while (cap < e->ev_len + need) cap *= 2;
    uint8_t* next = ghostty_alloc(NULL, cap);
    if (!next) return;
    if (e->ev_len) MEMCPY(next, e->ev, e->ev_len);
    if (e->ev) ghostty_free(NULL, e->ev, e->ev_cap);
    e->ev = next;
    e->ev_cap = cap;
  }
  uint32_t hdr[2] = {kind, (uint32_t)body};
  MEMCPY(e->ev + e->ev_len, hdr, 8);
  uint8_t* d = e->ev + e->ev_len + 8;
  if (has_prefix) *d++ = prefix;
  if (n) MEMCPY(d, p, n);
  e->ev_len += (uint32_t)need;
}

static void on_bell(GhosttyTerminal t, void* user) { (void)t; ev_put(user, EV_BELL, NULL, 0, 0, false); }

static void on_title(GhosttyTerminal t, void* user) {
  GhosttyString title = {0};
  if (ghostty_terminal_get(t, GHOSTTY_TERMINAL_DATA_TITLE, &title) == GHOSTTY_SUCCESS)
    ev_put(user, EV_TITLE, title.ptr, title.len, 0, false);
}

/* OSC 52 (and OSC 5522, OSC 1337 Copy) writes: the text goes to the page,
 * which owns the clipboard. sip's osc52gate has already filtered the stream
 * on the server when the deployment denies it. Reads are not supported. */
static void on_clipboard(GhosttyTerminal t, void* user, const GhosttyClipboardWrite* w) {
  (void)t;
  Eng* e = user;
  const GhosttyClipboardContent* text = NULL;
  for (size_t i = 0; i < w->contents_len; i++) {
    const GhosttyString m = w->contents[i].mime;
    if (m.len >= 5 && __builtin_memcmp(m.ptr, "text/", 5) == 0) { text = &w->contents[i]; break; }
  }
  GhosttyClipboardWriteReply reply = {.size = sizeof(reply)};
  if (w->contents_len == 0) {
    ev_put(e, EV_CLIPBOARD, NULL, 0, (uint8_t)w->location, true);
  } else if (text) {
    ev_put(e, EV_CLIPBOARD, text->data.ptr, text->data.len, (uint8_t)w->location, true);
  } else {
    reply.result = GHOSTTY_CLIPBOARD_WRITE_RESULT_UNSUPPORTED;
  }
  w->reply(w, &reply);
}

static bool on_size(GhosttyTerminal t, void* user, GhosttySizeReportSize* out) {
  (void)t;
  Eng* e = user;
  *out = (GhosttySizeReportSize){.rows = e->rows, .columns = e->cols, .cell_width = e->cw, .cell_height = e->ch};
  return true;
}

static bool on_attributes(GhosttyTerminal t, void* user, GhosttyDeviceAttributes* a) {
  (void)t; (void)user;
  /* VT220 class, with sixel (4) and ANSI colour (22). */
  *a = (GhosttyDeviceAttributes){
      .primary = {.conformance_level = 62, .features = {4, 22}, .num_features = 2},
      .secondary = {.device_type = 1, .firmware_version = 10, .rom_cartridge = 0},
      .tertiary = {.unit_id = 0},
  };
  return true;
}

static GhosttyString on_xtversion(GhosttyTerminal t, void* user) {
  (void)t; (void)user;
  static const char v[] = "webterm-engine(0.1)";
  return (GhosttyString){.ptr = (const uint8_t*)v, .len = sizeof(v) - 1};
}

static bool on_scheme(GhosttyTerminal t, void* user, GhosttyColorScheme* out) {
  (void)user;
  GhosttyColorRgb bg = {0};
  ghostty_terminal_get(t, GHOSTTY_TERMINAL_DATA_COLOR_BACKGROUND, &bg);
  *out = (2126u * bg.r + 7152u * bg.g + 722u * bg.b) >= 1280000u ? GHOSTTY_COLOR_SCHEME_LIGHT
                                                                  : GHOSTTY_COLOR_SCHEME_DARK;
  return true;
}

static void on_pty(GhosttyTerminal t, void* user, const uint8_t* p, size_t n) {
  (void)t;
  out_put(user, p, n);
}

static void on_hold(GhosttyTerminal t, void* user, bool held) {
  Eng* e = user;
  /* Capture the frame the program wants left on screen, then stop
   * updating until the hold ends (see render.h, Render Holds). A TUI in a
   * flood starts hundreds of holds between two draws; only the first one
   * after a draw needs the capture, because only one frame can be shown.
   * Every later capture in the same interval would be overwritten unseen,
   * and each costs a full render-state copy. */
  if (held && e->need_capture) {
    ghostty_render_state_update(e->rs, t);
    e->need_capture = false;
  }
  e->held = held;
}

/* ---- PNG for kitty graphics (f=100) -------------------------------- */
#ifdef ENGINE_PNG
#define PNG_MAX_SIDE 16384u
static bool decode_png(void* user, const GhosttyAllocator* a, const uint8_t* data, size_t len,
                       GhosttySysImage* out) {
  (void)user;
  size_t dlen = sizeof__wuffs_png__decoder(), work_len = 0, bytes = 0;
  wuffs_png__decoder* dec = (wuffs_png__decoder*)ghostty_alloc(NULL, dlen);
  uint8_t *work = NULL, *pixels = NULL;
  bool ok = false;
  if (!dec) return false;
  wuffs_base__io_buffer src = wuffs_base__ptr_u8__reader((uint8_t*)data, len, true);
  wuffs_base__image_config cfg;
  wuffs_base__pixel_buffer pb;
  if (wuffs_png__decoder__initialize(dec, dlen, WUFFS_VERSION, 0).repr ||
      wuffs_png__decoder__decode_image_config(dec, &cfg, &src).repr)
    goto done;
  uint32_t w = wuffs_base__pixel_config__width(&cfg.pixcfg), h = wuffs_base__pixel_config__height(&cfg.pixcfg);
  uint64_t wmax = wuffs_png__decoder__workbuf_len(dec).max_incl;
  if (!w || !h || w > PNG_MAX_SIDE || h > PNG_MAX_SIDE || wmax > (64u << 20)) goto done;
  wuffs_base__pixel_config__set(&cfg.pixcfg, WUFFS_BASE__PIXEL_FORMAT__RGBA_NONPREMUL,
                                WUFFS_BASE__PIXEL_SUBSAMPLING__NONE, w, h);
  bytes = (size_t)w * h * 4;
  work_len = (size_t)wmax;
  if (work_len && !(work = ghostty_alloc(NULL, work_len))) goto done;
  if (!(pixels = ghostty_alloc(a, bytes))) goto done;
  if (wuffs_base__pixel_buffer__set_from_slice(&pb, &cfg.pixcfg, wuffs_base__make_slice_u8(pixels, bytes)).repr ||
      wuffs_png__decoder__decode_frame(dec, &pb, &src, WUFFS_BASE__PIXEL_BLEND__SRC,
                                       wuffs_base__make_slice_u8(work, work_len), NULL).repr)
    goto done;
  *out = (GhosttySysImage){.width = w, .height = h, .data = pixels, .data_len = bytes};
  ok = true;
done:
  if (!ok && pixels) ghostty_free(a, pixels, bytes);
  if (work) ghostty_free(NULL, work, work_len);
  ghostty_free(NULL, (uint8_t*)dec, dlen);
  return ok;
}
#endif

/* ---- sixel ----------------------------------------------------------- */
/* libghostty-vt has no sixel. A pre-scan finds "ESC P <digits;> q" before
 * Ghostty sees it, decodes the image here, and hands it to Ghostty as a
 * kitty graphics image placed at the cursor, so it scrolls, clears and
 * prunes with the text. */
enum { SX_GROUND, SX_ESC, SX_HDR, SX_DATA, SX_DATA_ESC };

typedef uint8_t v16u8 __attribute__((vector_size(16)));

/* First index of "ESC P" in p[0..n), or n. An ESC as the last byte is
 * reported at n-1 so the caller can hold it until the next write. */
static size_t find_dcs(const uint8_t* p, size_t n) {
  size_t i = 0;
#ifdef __wasm_simd128__
  const v16u8 esc = {27, 27, 27, 27, 27, 27, 27, 27, 27, 27, 27, 27, 27, 27, 27, 27};
  const v16u8 pp = {'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'};
  for (; i + 17 <= n; i += 16) {
    v16u8 a, b;
    MEMCPY(&a, p + i, 16);
    MEMCPY(&b, p + i + 1, 16);
    v16u8 m = (v16u8)((a == esc) & (b == pp));
    if (__builtin_reduce_or(m)) break;
  }
#endif
  for (; i < n; i++) {
    if (p[i] != 27) continue;
    if (i + 1 == n || p[i + 1] == 'P') return i;
  }
  return n;
}

static void put_num(uint8_t* buf, size_t* o, uint32_t v) {
  char t[12]; int k = 12;
  do { t[--k] = '0' + v % 10; v /= 10; } while (v);
  while (k < 12) buf[(*o)++] = t[k++];
}

static void sixel_emit(Eng* e) {
  Sixel* s = e->sx;
  int32_t w = 0, h = 0;
  sixel_size(s, &w, &h);
  if (s->failed || w <= 0 || h <= 0) return;
  size_t raw = (size_t)w * h * 4;
  uint8_t* rgba = ghostty_alloc(NULL, raw);
  if (!rgba) return;
  uint32_t bg = 0xFF000000u | e->bg_rgb;
  for (int32_t y = 0; y < h; y++)
    for (int32_t x = 0; x < w; x++) {
      size_t k = (size_t)y * s->cap_w + x;
      uint32_t v = s->set[k] ? s->px[k] : (s->transparent ? 0 : bg);
      MEMCPY(rgba + ((size_t)y * w + x) * 4, &v, 4);
    }
  static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  uint8_t buf[4200];
  uint32_t id = e->next_sixel_id++;
  const size_t CHUNK = 3072; /* raw bytes per APC chunk: 4096 base64 */
  for (size_t off = 0; off < raw; off += CHUNK) {
    size_t n = raw - off < CHUNK ? raw - off : CHUNK, o = 0;
    bool last = off + n >= raw;
    buf[o++] = 27; buf[o++] = '_'; buf[o++] = 'G';
    if (off == 0) {
      /* z=-1: under the text, as xterm draws text written over a sixel. */
      static const char a[] = "a=T,f=32,q=2,C=1,z=-1,s=";
      MEMCPY(buf + o, a, sizeof(a) - 1); o += sizeof(a) - 1;
      put_num(buf, &o, (uint32_t)w);
      buf[o++] = ','; buf[o++] = 'v'; buf[o++] = '='; put_num(buf, &o, (uint32_t)h);
      buf[o++] = ','; buf[o++] = 'i'; buf[o++] = '='; put_num(buf, &o, id);
      buf[o++] = ',';
    }
    buf[o++] = 'm'; buf[o++] = '='; buf[o++] = last ? '0' : '1'; buf[o++] = ';';
    const uint8_t* q = rgba + off;
    size_t k = 0;
    for (; k + 3 <= n; k += 3) {
      uint32_t v = (uint32_t)q[k] << 16 | (uint32_t)q[k + 1] << 8 | q[k + 2];
      buf[o++] = B64[v >> 18]; buf[o++] = B64[(v >> 12) & 63]; buf[o++] = B64[(v >> 6) & 63]; buf[o++] = B64[v & 63];
    }
    if (k < n) {
      uint32_t v = (uint32_t)q[k] << 16 | (k + 1 < n ? (uint32_t)q[k + 1] << 8 : 0);
      buf[o++] = B64[v >> 18]; buf[o++] = B64[(v >> 12) & 63];
      buf[o++] = k + 1 < n ? B64[(v >> 6) & 63] : '='; buf[o++] = '=';
    }
    buf[o++] = 27; buf[o++] = '\\';
    ghostty_terminal_vt_write(e->t, buf, o);
  }
  ghostty_free(NULL, rgba, raw);
  /* Cursor as xterm leaves it after a sixel (VT340 mode): on the last text
   * row the image covers, in the column it started in. A line feed scrolls
   * when needed and keeps the column. */
  uint32_t rows = ((uint32_t)h + e->ch - 1) / e->ch;
  uint8_t nl = '\n';
  for (uint32_t r = 1; r < rows; r++) ghostty_terminal_vt_write(e->t, &nl, 1);
}

static void sixel_end(Eng* e, bool emit) {
  if (!e->sx) return;
  if (emit) sixel_emit(e);
  sixel_free(e->sx);
  ghostty_free(NULL, (uint8_t*)e->sx, sizeof(Sixel));
  e->sx = NULL;
}

static void sixel_begin(Eng* e) {
  int32_t prm[3] = {0, 0, 0}, np = 0;
  for (uint32_t i = 2; i < e->sx_hdr_len; i++) {
    uint8_t c = e->sx_hdr[i];
    if (c == ';') { if (np < 2) np++; }
    else if (c >= '0' && c <= '9') prm[np] = prm[np] * 10 + (c - '0');
  }
  e->sx = (Sixel*)ghostty_alloc(NULL, sizeof(Sixel));
  if (e->sx) sixel_init(e->sx, prm[1]);
}

/* Everything written to the terminal goes through here. */
static void vt_feed(Eng* e, const uint8_t* p, size_t n) {
#ifdef ENGINE_NO_SIXEL
  ghostty_terminal_vt_write(e->t, p, n);
  return;
#endif
  size_t i = 0;
  while (i < n) {
    switch (e->sx_state) {
      case SX_GROUND: {
        size_t k = i + find_dcs(p + i, n - i);
        if (k > i) ghostty_terminal_vt_write(e->t, p + i, k - i);
        if (k >= n) return;
        /* An ESC that may start a sixel: hold it. */
        e->sx_hdr[0] = 27;
        e->sx_hdr_len = 1;
        e->sx_state = SX_ESC;
        i = k + 1;
        break;
      }
      case SX_ESC:
        if (p[i] == 'P') {
          e->sx_hdr[e->sx_hdr_len++] = 'P';
          e->sx_state = SX_HDR;
          i++;
        } else {
          ghostty_terminal_vt_write(e->t, e->sx_hdr, e->sx_hdr_len);
          e->sx_state = SX_GROUND;
        }
        break;
      case SX_HDR: {
        uint8_t c = p[i];
        if (((c >= '0' && c <= '9') || c == ';') && e->sx_hdr_len < sizeof(e->sx_hdr)) {
          e->sx_hdr[e->sx_hdr_len++] = c;
          i++;
        } else if (c == 'q') {
          sixel_begin(e);
          e->sx_state = SX_DATA;
          i++;
        } else {
          /* Another DCS (DECRQSS, tmux, XTGETTCAP): Ghostty's. */
          ghostty_terminal_vt_write(e->t, e->sx_hdr, e->sx_hdr_len);
          e->sx_state = SX_GROUND;
        }
        break;
      }
      case SX_DATA: {
        size_t k = i;
        while (k < n && p[k] != 27 && p[k] != 0x18 && p[k] != 0x1A) k++;
        if (e->sx && k > i) sixel_feed(e->sx, p + i, k - i);
        if (k >= n) return;
        if (p[k] == 27) { e->sx_state = SX_DATA_ESC; i = k + 1; }
        else { sixel_end(e, false); e->sx_state = SX_GROUND; i = k + 1; } /* CAN or SUB */
        break;
      }
      case SX_DATA_ESC:
        sixel_end(e, true);
        if (p[i] == '\\') { e->sx_state = SX_GROUND; i++; }
        else { e->sx_hdr[0] = 27; e->sx_hdr_len = 1; e->sx_state = SX_ESC; }
        break;
    }
  }
}

EXPORT(eng_input_cap) uint32_t eng_input_cap(void) { return IN_CAP; }

EXPORT(eng_new)
Eng* eng_new(uint16_t cols, uint16_t rows, uint32_t scrollback, uint32_t cw, uint32_t ch,
             uint32_t atlas_w, uint32_t atlas_h) {
  Eng* e = xalloc(sizeof(Eng));
  if (!e) return NULL;
  e->cols = cols;
  e->rows = rows;
  e->cw = cw;
  e->ch = ch;
  if (ghostty_terminal_new(NULL, &e->t, cols, rows) || ghostty_render_state_new(NULL, &e->rs) ||
      ghostty_render_state_row_iterator_new(NULL, &e->it) ||
      ghostty_render_state_row_cells_new(NULL, &e->cells))
    return NULL;
  ghostty_terminal_resize(e->t, cols, rows, cw, ch);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_USERDATA, e);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_RENDER_HOLD, (const void*)on_hold);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_WRITE_PTY, (const void*)on_pty);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_BELL, (const void*)on_bell);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_TITLE_CHANGED, (const void*)on_title);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_CLIPBOARD_WRITE, (const void*)on_clipboard);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_SIZE, (const void*)on_size);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES, (const void*)on_attributes);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_XTVERSION, (const void*)on_xtversion);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_COLOR_SCHEME, (const void*)on_scheme);
  /* Kitty graphics: the browser has no filesystem or shared memory, so only
   * direct transmission is allowed. PNG payloads decode through Wuffs. */
  bool off = false;
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_FILE, &off);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_TEMP_FILE, &off);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_SHARED_MEM, &off);
  uint64_t img_limit = 256ull << 20;
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT, &img_limit);
#ifdef ENGINE_PNG
  ghostty_sys_set(GHOSTTY_SYS_OPT_DECODE_PNG, (const void*)decode_png);
#endif
  e->next_sixel_id = 0x7F000001u;
  /* Search highlight colours (r low): yellow, and orange for the selected match. */
  e->hl_fg = 0x000000; e->hl_bg = 0x5FD7FF; e->hl_sel_fg = 0x000000; e->hl_sel_bg = 0x0087FF;
  if (ghostty_kitty_graphics_placement_iterator_new(NULL, &e->pit)) return NULL;
  if (ghostty_selection_gesture_new(NULL, &e->gesture) ||
      ghostty_selection_gesture_event_new(NULL, &e->gpress, GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_PRESS) ||
      ghostty_selection_gesture_event_new(NULL, &e->gdrag, GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_DRAG) ||
      ghostty_selection_gesture_event_new(NULL, &e->grelease, GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_RELEASE) ||
      ghostty_selection_gesture_event_new(NULL, &e->gtick, GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_AUTOSCROLL_TICK))
    return NULL;
  if (ghostty_key_encoder_new(NULL, &e->kenc) || ghostty_key_event_new(NULL, &e->kev) ||
      ghostty_mouse_encoder_new(NULL, &e->menc) || ghostty_mouse_event_new(NULL, &e->mev))
    return NULL;
  size_t lines = scrollback;
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, NULL);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &lines);
  /* Grapheme clustering (mode 2027) on by default, as the Ghostty app and
   * xterm.js with the graphemes addon do: a flag, a skin-tone emoji or a
   * ZWJ family is one cell pair, not three. */
  GhosttyTerminalModeConfig gc = {.mode = ghostty_mode_new(2027, false), .value = true};
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_MODE_DEFAULT, &gc);
  e->inst = xalloc((size_t)cols * rows * 12);
  e->row_dirty = xalloc(rows);
  e->runs = xalloc((size_t)rows * RUNS_PER_ROW * RUN_WORDS * 4);
  e->run_n = xalloc(rows);
  e->cls = xalloc(cols);
  /* The glyph table and text arena start small and grow with use, so an
   * idle terminal holds little wasm memory. */
  e->gt_cap = GT_START;
  e->arena_cap = ARENA_START;
  e->table = xalloc(sizeof(GEnt) * e->gt_cap);
  e->arena = xalloc(e->arena_cap);
  e->miss = xalloc(sizeof(Miss) * MISS_CAP);
  e->in = xalloc(IN_CAP);
  e->slots_per_row = atlas_w / cw;
  e->max_slots = e->slots_per_row * (atlas_h / ch);
  if (e->max_slots > I_SLOT_MASK) e->max_slots = I_SLOT_MASK;
  e->slot_text = xalloc(4 * (size_t)e->max_slots);
  e->slot_len = xalloc(2 * (size_t)e->max_slots);
  e->next_slot = 1;
  e->need_capture = true;
  return e;
}

EXPORT(eng_theme) void eng_theme(Eng* e, uint32_t fg, uint32_t bg, uint32_t cur) {
  GhosttyColorRgb f = {fg & 255, (fg >> 8) & 255, (fg >> 16) & 255};
  GhosttyColorRgb b = {bg & 255, (bg >> 8) & 255, (bg >> 16) & 255};
  GhosttyColorRgb c = {cur & 255, (cur >> 8) & 255, (cur >> 16) & 255};
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &f);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &b);
  e->bg_rgb = bg & 0xFFFFFF;
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &c);
}

EXPORT(eng_input) uint8_t* eng_input(Eng* e) { return e->in; }
EXPORT(eng_write_input) void eng_write_input(Eng* e, uint32_t n) {
  vt_feed(e, e->in, n);
  e->stats[0] += n;
}
void eng_write(Eng* e, const uint8_t* p, size_t n) { vt_feed(e, p, n); }

EXPORT(eng_scroll) void eng_scroll(Eng* e, int32_t delta) {
  GhosttyTerminalScrollViewport v = {.tag = GHOSTTY_SCROLL_VIEWPORT_DELTA,
                                     .value = {.delta = delta}};
  ghostty_terminal_scroll_viewport(e->t, v);
}

EXPORT(eng_held) uint32_t eng_held(Eng* e) { return e->held; }
EXPORT(eng_release_hold) void eng_release_hold(Eng* e) {
  GhosttyTerminalModeConfig config = {.mode = ghostty_mode_new(2026, false), .value = false};
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_MODE, &config);
  e->held = false;
}

/* ---- glyph cache ---------------------------------------------------- */

static uint64_t fnv(const uint8_t* p, size_t n) {
  uint64_t h = 1469598103934665603ull;
  for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 1099511628211ull;
  return h;
}

static size_t utf8(uint32_t cp, uint8_t* o) {
  if (cp < 0x80) { o[0] = cp; return 1; }
  if (cp < 0x800) { o[0] = 0xC0 | (cp >> 6); o[1] = 0x80 | (cp & 63); return 2; }
  if (cp < 0x10000) {
    o[0] = 0xE0 | (cp >> 12); o[1] = 0x80 | ((cp >> 6) & 63); o[2] = 0x80 | (cp & 63);
    return 3;
  }
  o[0] = 0xF0 | (cp >> 18); o[1] = 0x80 | ((cp >> 12) & 63);
  o[2] = 0x80 | ((cp >> 6) & 63); o[3] = 0x80 | (cp & 63);
  return 4;
}

static void atlas_reset(Eng* e) {
  MEMSET(e->table, 0, sizeof(GEnt) * e->gt_cap);
  e->gt_used = 0;
  e->arena_len = 0;
  e->next_slot = 1;
  e->miss_n = 0;
  e->atlas_gen++;
}

/* Returns the slot, or 0 when the atlas is full (the caller resets and
 * rebuilds the frame). style: bit0 bold, bit1 italic. */
static uint32_t gt_hash(uint64_t key) { return (uint32_t)(key ^ (key >> 29) ^ (key >> 47)) * 2654435761u; }

/* Double the glyph table (up to GT_CAP) and reinsert every entry. */
static bool gt_grow(Eng* e) {
  if (e->gt_cap >= GT_CAP) return false;
  uint32_t cap = e->gt_cap * 2;
  GEnt* t = (GEnt*)xalloc(sizeof(GEnt) * cap);
  if (!t) return false;
  for (uint32_t k = 0; k < e->gt_cap; k++) {
    if (!e->table[k].used) continue;
    uint32_t h = gt_hash(e->table[k].key);
    for (uint32_t i = 0;; i++) {
      GEnt* g = &t[(h + i) & (cap - 1)];
      if (!g->used) { *g = e->table[k]; break; }
    }
  }
  ghostty_free(NULL, (uint8_t*)e->table, sizeof(GEnt) * e->gt_cap);
  e->table = t;
  e->gt_cap = cap;
  return true;
}

static bool arena_grow(Eng* e, size_t need) {
  uint32_t cap = e->arena_cap;
  while (cap < e->arena_len + need && cap < ARENA_CAP) cap *= 2;
  if (cap < e->arena_len + need) return false;
  uint8_t* a = (uint8_t*)xalloc(cap);
  if (!a) return false;
  MEMCPY(a, e->arena, e->arena_len);
  ghostty_free(NULL, e->arena, e->arena_cap);
  e->arena = a;
  e->arena_cap = cap;
  return true;
}

static uint32_t glyph(Eng* e, uint64_t key, const uint8_t* text, size_t len, uint32_t width,
                      uint32_t style, bool* full) {
  uint32_t h = gt_hash(key);
  for (uint32_t i = 0;; i++) {
    GEnt* g = &e->table[(h + i) & (e->gt_cap - 1)];
    if (!g->used) {
      /* miss: allocate, growing the table at half load and the arena when
       * full, up to their limits */
      if (e->gt_used + 1 > e->gt_cap / 2 && gt_grow(e)) return glyph(e, key, text, len, width, style, full);
      if (e->arena_len + len > e->arena_cap) arena_grow(e, len);
      uint32_t slot = e->next_slot;
      /* A glyph never wraps across atlas rows: a wide one or a shaped run
       * starts the next row when it would. */
      if ((slot % e->slots_per_row) + width > e->slots_per_row) slot += e->slots_per_row - slot % e->slots_per_row;
      if (slot + width > e->max_slots || e->arena_len + len > e->arena_cap ||
          e->miss_n >= MISS_CAP || i > e->gt_cap / 2) {
        *full = true;
        return 0;
      }
      e->gt_used++;
      e->next_slot = slot + width;
      g->used = 1;
      g->key = key;
      g->slot = slot;
      g->text = e->arena_len;
      g->len = (uint16_t)len;
      g->width = (uint8_t)width;
      MEMCPY(e->arena + e->arena_len, text, len);
      e->arena_len += len;
      e->slot_text[slot] = g->text;
      e->slot_len[slot] = g->len;
      e->miss[e->miss_n++] = (Miss){slot, g->text, (uint32_t)len | (width << 16) | (style << 24)};
      return slot;
    }
    if (g->key == key && g->width == width &&
        ((key >> 63) == 0 || (g->len == len && __builtin_memcmp(e->arena + g->text, text, len) == 0)))
      return g->slot;
  }
}

/* ---- frame builder -------------------------------------------------- */

static GhosttyColorRgb resolve(GhosttyStyleColor c, const GhosttyRenderStateColors* colors,
                               GhosttyColorRgb fallback) {
  if (c.tag == GHOSTTY_STYLE_COLOR_RGB) return c.value.rgb;
  if (c.tag == GHOSTTY_STYLE_COLOR_PALETTE) return colors->palette[c.value.palette];
  return fallback;
}

static GhosttyRenderStateColors g_colors;

/* Build one row into the instance buffer. Returns false if the atlas
 * filled up mid-row. */
/* ---- shaped runs ------------------------------------------------------ */
/* Scripts that need more than one cell at a time to draw right: right to
 * left scripts (Hebrew, Arabic, Syriac, Thaana, NKo) for joining and
 * order, and Brahmic scripts (Devanagari through Sinhala, Tibetan,
 * Myanmar, Khmer) for conjuncts and vowel signs that move across clusters.
 * A run of them, with the spaces, digits and punctuation between them,
 * is drawn by the browser's text stack as one string, so it shapes and
 * applies the bidi algorithm, inside the cells the terminal gave it. */
enum { CL_NONE = 0, CL_RTL = 1, CL_COMPLEX = 2, CL_NEUTRAL = 3 };
static uint8_t classify(uint32_t cp) {
  if ((cp >= 0x0590 && cp <= 0x08FF) || (cp >= 0xFB1D && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF) ||
      (cp >= 0x10800 && cp <= 0x10FFF) || (cp >= 0x1E800 && cp <= 0x1EFFF))
    return CL_RTL;
  if ((cp >= 0x0900 && cp <= 0x0DFF) || (cp >= 0x0F00 && cp <= 0x109F) || (cp >= 0x1780 && cp <= 0x17FF) ||
      (cp >= 0xA8E0 && cp <= 0xA8FF))
    return CL_COMPLEX;
  if (cp == 0 || cp == ' ' || (cp >= '0' && cp <= '9') || cp == '.' || cp == ',' || cp == ':' || cp == ';' ||
      cp == '!' || cp == '?' || cp == '-' || cp == '(' || cp == ')' || cp == '"' || cp == '\'' || cp == 0x200C || cp == 0x200D)
    return CL_NEUTRAL;
  return CL_NONE;
}

#define MF_RUN 4u /* miss style bit: a shaped run */
#define MF_RTL 8u /* the run is right to left */

static void find_runs(Eng* e, uint16_t y, const GhosttyCellsView* raw, uint32_t* out, uint32_t n, bool* full) {
  e->run_n[y] = 0;
  uint32_t* runs = e->runs + (size_t)y * RUNS_PER_ROW * RUN_WORDS;
  for (uint32_t x = 0; x < n;) {
    uint8_t c = e->cls[x] & 15;
    if (c != CL_RTL && c != CL_COMPLEX) { x++; continue; }
    /* Extend over shaped cells and neutrals that lead to more of them, with
     * one style; stop at the run limit. */
    uint32_t a = x, b = x, sid = C_STYLE(raw->ptr[x]);
    bool rtl = c == CL_RTL;
    for (uint32_t k = x + 1; k < n && k - a < RUN_MAX && C_STYLE(raw->ptr[k]) == sid; k++) {
      uint8_t ck = e->cls[k] & 15;
      if (ck == CL_RTL || ck == CL_COMPLEX) { b = k; rtl |= ck == CL_RTL; continue; }
      if (ck != CL_NEUTRAL) break;
    }
    x = b + 1;
    if (e->run_n[y] >= RUNS_PER_ROW) continue;
    /* The run's text in logical order. */
    uint8_t text[RUN_MAX * 16];
    size_t len = 0;
    for (uint32_t k = a; k <= b; k++) {
      GhosttyCell cell = raw->ptr[k];
      if (C_WIDE(cell) == GHOSTTY_CELL_WIDE_SPACER_TAIL) continue;
      if (C_TAG(cell) == GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME) {
        GhosttyBuffer t = {.ptr = text + len, .cap = sizeof(text) - len, .len = 0};
        ghostty_render_state_row_cells_select(e->cells, (uint16_t)k);
        if (ghostty_render_state_row_cells_get(e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &t) == GHOSTTY_SUCCESS)
          len += t.len;
      } else {
        uint32_t cp = C_CP(cell);
        if (len + 4 > sizeof(text)) break;
        len += cp > 32 ? utf8(cp, text + len) : (text[len] = ' ', 1);
      }
    }
    uint32_t w = b - a + 1;
    uint32_t st = e->cls[a] >> 4; /* the head cell's bold and italic */
    uint64_t key = (fnv(text, len) & ~(0xFull << 60)) | (1ull << 63) | (1ull << 60) | ((uint64_t)(st & 3) << 61);
    uint32_t slot = glyph(e, key, text, len, w, (st & 3) | MF_RUN | (rtl ? MF_RTL : 0), full);
    if (*full) return;
    if (!slot) continue;
    uint32_t* r = runs + (size_t)e->run_n[y]++ * RUN_WORDS;
    r[0] = a; r[1] = w; r[2] = slot; r[3] = out[a * 3 + 1]; r[4] = rtl ? 1 : 0;
    /* The cells keep their backgrounds and decorations; their own glyphs
     * are dropped for the run's. */
    for (uint32_t k = a; k <= b; k++) out[k * 3] &= ~I_SLOT_MASK; /* keep I_WIDE: the head still covers both cells */
  }
}

static bool build_row(Eng* e, uint16_t y, const GhosttyRenderStateColors* colors) {
  GhosttyCellsView raw = {0};
  if (ghostty_render_state_row_get(e->it, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW, &raw)) return true;
  ghostty_render_state_row_get(e->it, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &e->cells);
  GhosttyRenderStateRowSelection sel = GHOSTTY_INIT_SIZED(GhosttyRenderStateRowSelection);
  bool any_sel = ghostty_render_state_row_get(e->it, GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION,
                                              &sel) == GHOSTTY_SUCCESS;
  uint32_t* out = e->inst + (size_t)y * e->cols * 3;
  uint32_t style_id = 0xFFFFFFFFu, sflags = 0, sstyle = 0;
  uint32_t sfg = rgb(colors->foreground), sbg = rgb(colors->background);
  bool inverse = false, invisible = false;
  uint32_t dfg = sfg, dbg = sbg;
  size_t n = raw.len < e->cols ? raw.len : e->cols;
  bool full = false, shaped = false;
  for (uint32_t x = 0; x < n; x++) {
    GhosttyCell c = raw.ptr[x];
    uint32_t tag = C_TAG(c), wide = C_WIDE(c), sid = C_STYLE(c);
    if (sid != style_id) {
      style_id = sid;
      if (sid == 0) {
        sfg = dfg; sbg = dbg; sflags = 0; sstyle = 0; inverse = false; invisible = false;
      } else {
        GhosttyStyle st = GHOSTTY_INIT_SIZED(GhosttyStyle);
        ghostty_render_state_row_cells_select(e->cells, (uint16_t)x);
        ghostty_render_state_row_cells_get(e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &st);
        sfg = rgb(resolve(st.fg_color, colors, colors->foreground));
        sbg = rgb(resolve(st.bg_color, colors, colors->background));
        inverse = st.inverse;
        invisible = st.invisible;
        sstyle = (st.bold ? 1u : 0) | (st.italic ? 2u : 0);
        sflags = ((uint32_t)(st.underline & 7) << I_UL_SHIFT) | (st.strikethrough ? I_STRIKE : 0) |
                 (st.overline ? I_OVERLINE : 0) | (st.faint ? I_FAINT : 0) | (st.blink ? I_BLINK : 0);
      }
    }
    uint32_t fg = sfg, bg = sbg;
    if (tag == GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE) {
      bg = rgb(colors->palette[(c >> 2) & 255]);
    } else if (tag == GHOSTTY_CELL_CONTENT_BG_COLOR_RGB) {
      uint32_t v = (uint32_t)((c >> 2) & 0xFFFFFFu);
      bg = v; /* r low, g, b: same packing as rgb() */
    }
    if (inverse) { uint32_t t = fg; fg = bg; bg = t; }
    if (any_sel && x >= sel.start_x && x <= sel.end_x) { uint32_t t = fg; fg = bg; bg = t; }
    uint32_t w0 = sflags, slot = 0;
    {
      uint8_t cl = (tag == GHOSTTY_CELL_CONTENT_CODEPOINT || tag == GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME)
                       ? classify(C_CP(c)) : CL_NEUTRAL;
      e->cls[x] = (uint8_t)(cl | (sstyle << 4));
      if (cl == CL_RTL || cl == CL_COMPLEX) shaped = true;
    }
    if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL) {
      w0 = I_TAIL;
    } else if (wide == GHOSTTY_CELL_WIDE_SPACER_HEAD) {
      w0 = 0; /* the blank Ghostty leaves where a wide char wrapped */
    } else if (invisible) {
      /* nothing to draw */
    } else if (tag == GHOSTTY_CELL_CONTENT_CODEPOINT) {
      uint32_t cp = C_CP(c);
      if (cp > 32 && cp != PLACEHOLDER_CP) {
        uint8_t buf[4];
        size_t len = utf8(cp, buf);
        uint32_t width = wide == GHOSTTY_CELL_WIDE_WIDE ? 2 : 1;
        slot = glyph(e, (uint64_t)cp | ((uint64_t)sstyle << 21) | ((uint64_t)width << 24), buf, len,
                     width, sstyle, &full);
      }
    } else if (tag == GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME && C_CP(c) != PLACEHOLDER_CP) {
      uint8_t buf[256];
      GhosttyBuffer text = {.ptr = buf, .cap = sizeof(buf), .len = 0};
      ghostty_render_state_row_cells_select(e->cells, (uint16_t)x);
      if (ghostty_render_state_row_cells_get(
              e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &text) == GHOSTTY_SUCCESS &&
          text.len) {
        uint32_t width = wide == GHOSTTY_CELL_WIDE_WIDE ? 2 : 1;
        uint64_t key = (fnv(buf, text.len) & ~(0x7ull << 60)) | (1ull << 63) | ((uint64_t)sstyle << 61);
        slot = glyph(e, key, buf, text.len, width, sstyle, &full);
      }
    }
    if (full) return false;
    if (slot && wide == GHOSTTY_CELL_WIDE_WIDE) w0 |= I_WIDE;
    out[x * 3] = w0 | slot;
    out[x * 3 + 1] = fg;
    out[x * 3 + 2] = bg;
  }
  for (uint32_t x = n; x < e->cols; x++) {
    out[x * 3] = 0; out[x * 3 + 1] = dfg; out[x * 3 + 2] = dbg;
  }
  e->run_n[y] = 0;
  if (shaped) {
    find_runs(e, y, &raw, out, (uint32_t)n, &full);
    if (full) return false;
  }
  return true;
}

/* All shaped runs in view: count, then per run x, y, cells, slot, fg, flags. */
EXPORT(eng_runs) uint32_t* eng_runs(Eng* e) {
  static uint32_t* buf;
  static uint32_t cap;
  uint32_t need = 1 + e->rows * RUNS_PER_ROW * 6;
  if (cap < need) {
    if (buf) ghostty_free(NULL, (uint8_t*)buf, cap * 4);
    buf = (uint32_t*)xalloc((size_t)need * 4);
    cap = buf ? need : 0;
    if (!buf) return NULL;
  }
  uint32_t k = 0;
  for (uint32_t y = 0; y < e->rows; y++)
    for (uint32_t i = 0; i < e->run_n[y]; i++) {
      uint32_t* r = e->runs + ((size_t)y * RUNS_PER_ROW + i) * RUN_WORDS;
      uint32_t* o = buf + 1 + k++ * 6;
      o[0] = r[0]; o[1] = y; o[2] = r[1]; o[3] = r[2]; o[4] = r[3]; o[5] = r[4];
    }
  buf[0] = k;
  return buf;
}

/* ---- search ---------------------------------------------------------- */
/* Paint the matches in view: every match in the highlight colours, the
 * selected one in the selected colours. Runs after the rows are built. */
static void paint_range(Eng* e, GhosttyGridRef* a, GhosttyGridRef* b, uint32_t fg, uint32_t bg) {
  GhosttyPointCoordinate p0, p1;
  if (ghostty_terminal_point_from_grid_ref(e->t, a, GHOSTTY_POINT_TAG_VIEWPORT, &p0) ||
      ghostty_terminal_point_from_grid_ref(e->t, b, GHOSTTY_POINT_TAG_VIEWPORT, &p1))
    return;
  if (p1.y < p0.y || (p1.y == p0.y && p1.x < p0.x)) { GhosttyPointCoordinate t = p0; p0 = p1; p1 = t; }
  for (uint32_t y = p0.y; y <= p1.y && y < e->rows; y++) {
    uint32_t x0 = y == p0.y ? p0.x : 0, x1 = y == p1.y ? p1.x : e->cols - 1u;
    uint32_t* row = e->inst + (size_t)y * e->cols * 3;
    for (uint32_t x = x0; x <= x1 && x < e->cols; x++) { row[x * 3 + 1] = fg; row[x * 3 + 2] = bg; }
    e->row_dirty[y] = 1;
  }
}

static void highlight_matches(Eng* e) {
  GhosttySelectionBuffer buf = {.ptr = e->matches, .cap = e->matches_cap, .len = 0};
  GhosttyResult r = ghostty_search_get(e->search, GHOSTTY_SEARCH_DATA_VIEWPORT_MATCHES, &buf);
  if (r == GHOSTTY_OUT_OF_SPACE) {
    size_t cap = buf.len + 16;
    if (e->matches) ghostty_free(NULL, (uint8_t*)e->matches, e->matches_cap * sizeof(GhosttySelection));
    e->matches = (GhosttySelection*)xalloc(cap * sizeof(GhosttySelection));
    e->matches_cap = e->matches ? cap : 0;
    for (size_t i = 0; i < e->matches_cap; i++) e->matches[i] = (GhosttySelection)GHOSTTY_INIT_SIZED(GhosttySelection);
    buf = (GhosttySelectionBuffer){.ptr = e->matches, .cap = e->matches_cap, .len = 0};
    r = ghostty_search_get(e->search, GHOSTTY_SEARCH_DATA_VIEWPORT_MATCHES, &buf);
  }
  if (r == GHOSTTY_SUCCESS)
    for (size_t i = 0; i < buf.len; i++) paint_range(e, &e->matches[i].start, &e->matches[i].end, e->hl_fg, e->hl_bg);
  GhosttySelection sel = GHOSTTY_INIT_SIZED(GhosttySelection);
  if (ghostty_search_get(e->search, GHOSTTY_SEARCH_DATA_SELECTED_MATCH, &sel) == GHOSTTY_SUCCESS)
    paint_range(e, &sel.start, &sel.end, e->hl_sel_fg, e->hl_sel_bg);
}

static uint32_t search_out[3]; /* status, total, selected index (UINT32_MAX for none) */
static void search_report(Eng* e) {
  GhosttySearchStatus st = GHOSTTY_SEARCH_STATUS_COMPLETE;
  size_t total = 0, idx = 0;
  ghostty_search_get(e->search, GHOSTTY_SEARCH_DATA_STATUS, &st);
  ghostty_search_get(e->search, GHOSTTY_SEARCH_DATA_TOTAL_MATCHES, &total);
  bool has = ghostty_search_get(e->search, GHOSTTY_SEARCH_DATA_SELECTED_INDEX, &idx) == GHOSTTY_SUCCESS;
  search_out[0] = st;
  search_out[1] = total > 0xFFFFFFFFu ? 0xFFFFFFFFu : (uint32_t)total;
  search_out[2] = has ? (uint32_t)idx : 0xFFFFFFFFu;
}

/* Set the needle (the input buffer, len bytes; 0 closes the search). */
EXPORT(eng_search) uint32_t* eng_search(Eng* e, uint32_t len) {
  if (!e->search && ghostty_search_new(NULL, &e->search, e->t)) return search_out;
  GhosttyString needle = {.ptr = e->in, .len = len};
  ghostty_search_set(e->search, GHOSTTY_SEARCH_OPT_NEEDLE, len ? &needle : NULL);
  e->searching = len != 0;
  e->searching_changed = true;
  search_report(e);
  return search_out;
}

/* Bounded progress: one feed and up to `ticks` ticks. */
EXPORT(eng_search_step) uint32_t* eng_search_step(Eng* e, uint32_t ticks) {
  if (!e->searching) { search_out[0] = GHOSTTY_SEARCH_STATUS_COMPLETE; return search_out; }
  ghostty_search_feed(e->search);
  GhosttySearchStatus st = GHOSTTY_SEARCH_STATUS_RUNNING;
  for (uint32_t i = 0; i < ticks && st == GHOSTTY_SEARCH_STATUS_RUNNING; i++)
    if (ghostty_search_tick(e->search, &st)) break;
  e->searching_changed = true;
  search_report(e);
  return search_out;
}

/* dir 1 next (older), 2 previous (newer). The viewport follows. */
EXPORT(eng_search_select) uint32_t* eng_search_select(Eng* e, uint32_t dir) {
  if (!e->searching) return search_out;
  ghostty_search_set(e->search, dir == 1 ? GHOSTTY_SEARCH_OPT_SELECT_NEXT : GHOSTTY_SEARCH_OPT_SELECT_PREV, NULL);
  e->searching_changed = true;
  search_report(e);
  return search_out;
}

EXPORT(eng_search_colors) void eng_search_colors(Eng* e, uint32_t fg, uint32_t bg, uint32_t sfg, uint32_t sbg) {
  e->hl_fg = fg; e->hl_bg = bg; e->hl_sel_fg = sfg; e->hl_sel_bg = sbg;
}

/* Bits returned by eng_frame. */
#define F_DRAW 1u
#define F_ATLAS_RESET 2u
#define F_HELD 4u

EXPORT(eng_frame) uint32_t eng_frame(Eng* e, uint32_t force) {
  uint32_t ret = 0;
  if (!e->held) ghostty_render_state_update(e->rs, e->t);
  else ret |= F_HELD;
  e->need_capture = true;
  GhosttyRenderStateDirty dirty = 0;
  ghostty_render_state_get(e->rs, GHOSTTY_RENDER_STATE_DATA_DIRTY, &dirty);
  GhosttyRenderStateCursor cur = GHOSTTY_INIT_SIZED(GhosttyRenderStateCursor);
  ghostty_render_state_get(e->rs, GHOSTTY_RENDER_STATE_DATA_CURSOR, &cur);
  uint32_t vis = cur.visible && cur.viewport_has_value;
  uint32_t cx = vis ? cur.viewport_x : 0, cy = vis ? cur.viewport_y : 0;
  bool cursor_changed = cx != e->cursor[0] || cy != e->cursor[1] || vis != e->cursor[2] ||
                        (uint32_t)cur.visual_style != e->cursor[3];
  e->cursor[0] = cx; e->cursor[1] = cy; e->cursor[2] = vis;
  e->cursor[3] = cur.visual_style; e->cursor[4] = cur.blinking;
  MEMSET(e->row_dirty, 0, e->rows);
  e->miss_n = 0;
  if (dirty == GHOSTTY_RENDER_STATE_DIRTY_FALSE && !force && !e->searching_changed) return ret | (cursor_changed ? F_DRAW : 0);
  e->searching_changed = false;
  GhosttyRenderStateColors* colors = &g_colors;
  *colors = (GhosttyRenderStateColors)GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
  ghostty_render_state_get(e->rs, GHOSTTY_RENDER_STATE_DATA_COLORS, colors);
  e->colors[0] = rgb(colors->foreground);
  e->colors[1] = rgb(colors->background);
  e->colors[2] = colors->cursor_has_value ? rgb(colors->cursor) : rgb(colors->foreground);
  /* While a search is open its highlights move with every change, so every
   * row is rebuilt (0.12 ms for 200x50). */
  bool all = force || dirty == GHOSTTY_RENDER_STATE_DIRTY_FULL || e->searching;
  for (int attempt = 0; attempt < 2; attempt++) {
    bool ok = true;
    ghostty_render_state_get(e->rs, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &e->it);
    if (all) {
      uint16_t y = 0;
      while (y < e->rows && ghostty_render_state_row_iterator_next(e->it)) {
        if (!build_row(e, y, colors)) { ok = false; break; }
        e->row_dirty[y++] = 1;
      }
    } else {
      uint16_t y;
      while (ghostty_render_state_row_iterator_next_dirty(e->it, &y)) {
        if (y >= e->rows) continue;
        if (!build_row(e, y, colors)) { ok = false; break; }
        e->row_dirty[y] = 1;
      }
    }
    if (ok) break;
    /* Atlas full: drop every glyph and rebuild every row against a fresh
     * atlas. JS clears its texture when it sees F_ATLAS_RESET. */
    atlas_reset(e);
    ret |= F_ATLAS_RESET;
    all = true;
  }
  if (e->searching) highlight_matches(e);
  ghostty_render_state_clean(e->rs);
  e->stats[1]++;
  return ret | F_DRAW;
}

/* Queue printable ASCII, regular and bold, as atlas misses so the worker
 * can rasterize them before the first output arrives (xterm's WebGL atlas
 * does the same). Returns the miss count. */
EXPORT(eng_warm_ascii) uint32_t eng_warm_ascii(Eng* e) {
  bool full = false;
  e->miss_n = 0;
  for (uint32_t style = 0; style < 2; style++)
    for (uint32_t cp = 33; cp < 127; cp++) {
      uint8_t b = (uint8_t)cp;
      glyph(e, (uint64_t)cp | ((uint64_t)style << 21) | (1ull << 24), &b, 1, 1, style, &full);
    }
  return e->miss_n;
}

/* ---- input: everything here appends to the out buffer ---------------- */
EXPORT(eng_out) uint8_t* eng_out(Eng* e) { return e->out; }
EXPORT(eng_out_len) uint32_t eng_out_len(Eng* e) { return e->out_len; }
EXPORT(eng_out_clear) void eng_out_clear(Eng* e) { e->out_len = 0; }

EXPORT(eng_mode) uint32_t eng_mode(Eng* e, uint32_t mode, uint32_t ansi) {
  GhosttyTerminalModeConfig c = {.mode = ghostty_mode_new((uint16_t)mode, ansi != 0), .value = false};
  ghostty_terminal_get(e->t, GHOSTTY_TERMINAL_DATA_MODE, &c);
  return c.value;
}

static void scroll_bottom(Eng* e) {
  GhosttyTerminalScrollViewport v = {.tag = GHOSTTY_SCROLL_VIEWPORT_BOTTOM};
  ghostty_terminal_scroll_viewport(e->t, v);
}

/* A key event from the page. key is a GhosttyKey (from the DOM code), text
 * the UTF-8 the key produced (in the input staging buffer), unshifted the
 * codepoint of the key without shift. Returns the bytes appended. The
 * encoder reads the terminal's modes itself: cursor keys, keypad, kitty
 * keyboard flags, modifyOtherKeys. */
EXPORT(eng_key)
uint32_t eng_key(Eng* e, uint32_t key, uint32_t mods, uint32_t action, uint32_t text_len,
                 uint32_t unshifted, uint32_t composing) {
  ghostty_key_encoder_setopt_from_terminal(e->kenc, e->t);
  ghostty_key_event_set_key(e->kev, key);
  ghostty_key_event_set_mods(e->kev, (GhosttyMods)mods);
  ghostty_key_event_set_action(e->kev, action);
  ghostty_key_event_set_utf8(e->kev, (const char*)e->in, text_len);
  ghostty_key_event_set_unshifted_codepoint(e->kev, unshifted);
  ghostty_key_event_set_composing(e->kev, composing != 0);
  /* The browser already applied shift to the text it reports. */
  ghostty_key_event_set_consumed_mods(e->kev, text_len ? (mods & GHOSTTY_MODS_SHIFT) : 0);
  char buf[128];
  size_t n = 0;
  if (ghostty_key_encoder_encode(e->kenc, e->kev, buf, sizeof(buf), &n) || !n) return 0;
  out_put(e, (const uint8_t*)buf, n);
  if (action != GHOSTTY_KEY_ACTION_RELEASE) scroll_bottom(e);
  return (uint32_t)n;
}

/* Text with no key behind it: an IME commit or a soft keyboard insert. */
EXPORT(eng_text) uint32_t eng_text(Eng* e, uint32_t len) {
  out_put(e, e->in, len);
  scroll_bottom(e);
  return len;
}

/* Paste the text in the input buffer, bracketed if the program asked for
 * it (mode 2004). Control bytes are made safe by Ghostty's encoder. */
EXPORT(eng_paste) uint32_t eng_paste(Eng* e, uint32_t len) {
  bool bracketed = eng_mode(e, 2004, 0);
  size_t need = 0;
  ghostty_paste_encode((char*)e->in, len, bracketed, NULL, 0, &need);
  uint32_t before = e->out_len;
  out_put(e, e->in, need); /* reserve, then encode in place */
  if (e->out_len != before + need) return 0;
  size_t wrote = 0;
  if (ghostty_paste_encode((char*)e->in, len, bracketed, (char*)e->out + before, need, &wrote)) {
    e->out_len = before;
    return 0;
  }
  e->out_len = before + (uint32_t)wrote;
  scroll_bottom(e);
  return (uint32_t)wrote;
}

EXPORT(eng_focus) uint32_t eng_focus(Eng* e, uint32_t focused) {
  if (!eng_mode(e, 1004, 0)) return 0;
  char buf[8];
  size_t n = 0;
  if (ghostty_focus_encode(focused ? GHOSTTY_FOCUS_GAINED : GHOSTTY_FOCUS_LOST, buf, sizeof(buf), &n)) return 0;
  out_put(e, (const uint8_t*)buf, n);
  return (uint32_t)n;
}

/* A pointer event in canvas pixels. Returns the bytes appended; 0 when the
 * program has not asked for mouse reports. */
EXPORT(eng_mouse)
uint32_t eng_mouse(Eng* e, uint32_t action, uint32_t button, uint32_t mods, float x, float y,
                   uint32_t any_pressed) {
  ghostty_mouse_encoder_setopt_from_terminal(e->menc, e->t);
  GhosttyMouseEncoderSize size = {.size = sizeof(size), .screen_width = e->cols * e->cw,
                                  .screen_height = e->rows * e->ch, .cell_width = e->cw,
                                  .cell_height = e->ch};
  bool any = any_pressed != 0;
  ghostty_mouse_encoder_setopt(e->menc, GHOSTTY_MOUSE_ENCODER_OPT_SIZE, &size);
  ghostty_mouse_encoder_setopt(e->menc, GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED, &any);
  ghostty_mouse_event_set_action(e->mev, action);
  ghostty_mouse_event_set_mods(e->mev, (GhosttyMods)mods);
  if (button) ghostty_mouse_event_set_button(e->mev, button);
  else ghostty_mouse_event_clear_button(e->mev);
  GhosttyMousePosition pos = {x, y};
  ghostty_mouse_event_set_position(e->mev, pos);
  char buf[64];
  size_t n = 0;
  if (ghostty_mouse_encoder_encode(e->menc, e->mev, buf, sizeof(buf), &n) || !n) return 0;
  out_put(e, (const uint8_t*)buf, n);
  return (uint32_t)n;
}

/* Whether any mouse tracking mode is on (9, 1000, 1002, 1003). */
EXPORT(eng_mouse_tracking) uint32_t eng_mouse_tracking(Eng* e) {
  return eng_mode(e, 1000, 0) || eng_mode(e, 1002, 0) || eng_mode(e, 1003, 0) || eng_mode(e, 9, 0);
}

/* Resize the grid. The instance buffer is reallocated; the next frame is
 * a full rebuild. Returns 0 on success. */
EXPORT(eng_resize) uint32_t eng_resize(Eng* e, uint16_t cols, uint16_t rows) {
  if (!cols || !rows) return 1;
  if (cols == e->cols && rows == e->rows) return 0;
  uint32_t* inst = xalloc((size_t)cols * rows * 12);
  uint8_t* dirty = xalloc(rows);
  if (!inst || !dirty) return 1;
  if (ghostty_terminal_resize(e->t, cols, rows, e->cw, e->ch)) {
    ghostty_free(NULL, (uint8_t*)inst, (size_t)cols * rows * 12);
    ghostty_free(NULL, dirty, rows);
    return 1;
  }
  ghostty_free(NULL, (uint8_t*)e->inst, (size_t)e->cols * e->rows * 12);
  ghostty_free(NULL, e->row_dirty, e->rows);
  ghostty_free(NULL, (uint8_t*)e->runs, (size_t)e->rows * RUNS_PER_ROW * RUN_WORDS * 4);
  ghostty_free(NULL, e->run_n, e->rows);
  ghostty_free(NULL, e->cls, e->cols);
  e->runs = xalloc((size_t)rows * RUNS_PER_ROW * RUN_WORDS * 4);
  e->run_n = xalloc(rows);
  e->cls = xalloc(cols);
  e->inst = inst;
  e->row_dirty = dirty;
  e->cols = cols;
  e->rows = rows;
  return 0;
}

/* ---- events and selection ------------------------------------------ */
EXPORT(eng_events) uint8_t* eng_events(Eng* e) { return e->ev; }
EXPORT(eng_events_len) uint32_t eng_events_len(Eng* e) { return e->ev_len; }
EXPORT(eng_events_clear) void eng_events_clear(Eng* e) { e->ev_len = 0; }

static bool viewport_ref(Eng* e, double x, double y, GhosttyGridRef* ref) {
  int32_t cx = (int32_t)(x / e->cw), cy = (int32_t)(y / e->ch);
  if (cx < 0) cx = 0;
  if (cy < 0) cy = 0;
  if (cx >= e->cols) cx = e->cols - 1;
  if (cy >= e->rows) cy = e->rows - 1;
  GhosttyPoint p = {.tag = GHOSTTY_POINT_TAG_VIEWPORT, .value = {.coordinate = {(uint16_t)cx, (uint32_t)cy}}};
  *ref = (GhosttyGridRef)GHOSTTY_INIT_SIZED(GhosttyGridRef);
  return ghostty_terminal_grid_ref(e->t, p, ref) == GHOSTTY_SUCCESS;
}

/* A selection gesture from the pointer, in canvas pixels. kind: 0 press,
 * 1 drag, 2 release. Ghostty's gesture handles click counting (cell, word,
 * line), drag thresholds and the anchor. Returns 1 when a selection is set,
 * 0 when it was cleared or left alone. */
EXPORT(eng_select)
uint32_t eng_select(Eng* e, uint32_t kind, double x, double y, double time_ms, uint32_t rect) {
  GhosttyGridRef ref;
  bool have = viewport_ref(e, x, y, &ref);
  GhosttySurfacePosition pos = {x, y};
  GhosttySelection sel = GHOSTTY_INIT_SIZED(GhosttySelection);
  GhosttyResult r;
  if (kind == 0) {
    if (!have) return 0;
    uint64_t ns = (uint64_t)(time_ms * 1e6);
    uint64_t interval = 500000000ull;
    double dist = (double)e->cw;
    ghostty_selection_gesture_event_set(e->gpress, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF, &ref);
    ghostty_selection_gesture_event_set(e->gpress, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION, &pos);
    ghostty_selection_gesture_event_set(e->gpress, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_TIME_NS, &ns);
    ghostty_selection_gesture_event_set(e->gpress, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REPEAT_INTERVAL_NS, &interval);
    ghostty_selection_gesture_event_set(e->gpress, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REPEAT_DISTANCE, &dist);
    r = ghostty_selection_gesture_event(e->gesture, e->t, e->gpress, &sel);
  } else if (kind == 1) {
    if (!have) return 0;
    GhosttySelectionGestureGeometry geo = {.columns = e->cols, .cell_width = e->cw, .padding_left = 0, .screen_height = e->rows * e->ch};
    bool rectangle = rect != 0;
    ghostty_selection_gesture_event_set(e->gdrag, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF, &ref);
    ghostty_selection_gesture_event_set(e->gdrag, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION, &pos);
    ghostty_selection_gesture_event_set(e->gdrag, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_GEOMETRY, &geo);
    ghostty_selection_gesture_event_set(e->gdrag, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_RECTANGLE, &rectangle);
    r = ghostty_selection_gesture_event(e->gesture, e->t, e->gdrag, &sel);
  } else if (kind == 3) {
    /* Autoscroll tick: the pointer is held past the top or bottom edge.
     * Scroll one row toward it, then let the gesture extend the selection
     * to the row that came into view. */
    GhosttySelectionGestureAutoscroll dir = GHOSTTY_SELECTION_GESTURE_AUTOSCROLL_NONE;
    ghostty_selection_gesture_get(e->gesture, e->t, GHOSTTY_SELECTION_GESTURE_DATA_AUTOSCROLL, &dir);
    if (dir == GHOSTTY_SELECTION_GESTURE_AUTOSCROLL_NONE) return 0;
    eng_scroll(e, dir == GHOSTTY_SELECTION_GESTURE_AUTOSCROLL_UP ? -1 : 1);
    GhosttySelectionGestureGeometry geo = {.columns = e->cols, .cell_width = e->cw, .padding_left = 0, .screen_height = e->rows * e->ch};
    int32_t cx = (int32_t)(x / e->cw);
    if (cx < 0) cx = 0;
    if (cx >= e->cols) cx = e->cols - 1;
    GhosttyPointCoordinate vp = {(uint16_t)cx, dir == GHOSTTY_SELECTION_GESTURE_AUTOSCROLL_UP ? 0u : (uint32_t)(e->rows - 1)};
    ghostty_selection_gesture_event_set(e->gtick, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_VIEWPORT, &vp);
    ghostty_selection_gesture_event_set(e->gtick, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_GEOMETRY, &geo);
    ghostty_selection_gesture_event_set(e->gtick, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION, &pos);
    r = ghostty_selection_gesture_event(e->gesture, e->t, e->gtick, &sel);
  } else {
    ghostty_selection_gesture_event_set(e->grelease, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF, have ? &ref : NULL);
    ghostty_selection_gesture_event(e->gesture, e->t, e->grelease, NULL);
    return 0;
  }
  if (r == GHOSTTY_SUCCESS) {
    ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_SELECTION, &sel);
    return 1;
  }
  if (r == GHOSTTY_NO_VALUE && kind == 0) ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_SELECTION, NULL);
  return 0;
}

/* 1 up, 2 down, 0 none: whether a held drag wants the viewport to scroll. */
EXPORT(eng_autoscroll) uint32_t eng_autoscroll(Eng* e) {
  GhosttySelectionGestureAutoscroll dir = GHOSTTY_SELECTION_GESTURE_AUTOSCROLL_NONE;
  ghostty_selection_gesture_get(e->gesture, e->t, GHOSTTY_SELECTION_GESTURE_DATA_AUTOSCROLL, &dir);
  return (uint32_t)dir;
}

EXPORT(eng_select_clear) void eng_select_clear(Eng* e) {
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_SELECTION, NULL);
}

EXPORT(eng_select_all) uint32_t eng_select_all(Eng* e) {
  GhosttySelection sel = GHOSTTY_INIT_SIZED(GhosttySelection);
  if (ghostty_terminal_select_all(e->t, &sel)) return 0;
  return ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_SELECTION, &sel) == GHOSTTY_SUCCESS;
}

/* The selected text as plain UTF-8, soft wraps joined and trailing blanks
 * trimmed, the way Ghostty copies. Returns the length; eng_selection_ptr
 * gives the bytes until the next call. */
EXPORT(eng_selection_text) uint32_t eng_selection_text(Eng* e) {
  if (e->sel_text) { ghostty_free(NULL, e->sel_text, e->sel_len); e->sel_text = NULL; e->sel_len = 0; }
  GhosttyTerminalSelectionFormatOptions o = GHOSTTY_INIT_SIZED(GhosttyTerminalSelectionFormatOptions);
  o.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN;
  o.unwrap = true;
  o.trim = true;
  if (ghostty_terminal_selection_format_alloc(e->t, NULL, o, &e->sel_text, &e->sel_len)) return 0;
  return (uint32_t)e->sel_len;
}
EXPORT(eng_selection_ptr) uint8_t* eng_selection_ptr(Eng* e) { return e->sel_text; }

/* Viewport scroll position for a scrollbar: total rows, offset of the top
 * viewport row, viewport rows. */
EXPORT(eng_scrollbar) uint32_t* eng_scrollbar(Eng* e) {
  static uint32_t out[3];
  GhosttyTerminalScrollbar sb = {0};
  if (ghostty_terminal_get(e->t, GHOSTTY_TERMINAL_DATA_SCROLLBAR, &sb) == GHOSTTY_SUCCESS) {
    out[0] = (uint32_t)sb.total; out[1] = (uint32_t)sb.offset; out[2] = (uint32_t)sb.len;
  }
  return out;
}

static void dput(Eng* e, const void* p, size_t n);
static void dbegin(Eng* e);

/* ---- links ------------------------------------------------------------ */
static uint8_t link_uri[4096];
static uint32_t link_range[2];

static bool cell_ref(Eng* e, uint32_t col, uint32_t row, GhosttyGridRef* ref) {
  GhosttyPoint p = {.tag = GHOSTTY_POINT_TAG_VIEWPORT, .value = {.coordinate = {(uint16_t)col, row}}};
  *ref = (GhosttyGridRef)GHOSTTY_INIT_SIZED(GhosttyGridRef);
  return ghostty_terminal_grid_ref(e->t, p, ref) == GHOSTTY_SUCCESS;
}

static size_t uri_at(Eng* e, uint32_t col, uint32_t row, uint8_t* buf, size_t cap) {
  GhosttyGridRef ref;
  size_t n = 0;
  if (!cell_ref(e, col, row, &ref)) return 0;
  if (ghostty_grid_ref_hyperlink_uri(&ref, buf, cap, &n) != GHOSTTY_SUCCESS) return 0;
  return n;
}

/* The OSC 8 hyperlink under a viewport cell. Returns the URI length (the
 * bytes are at eng_link_uri) and sets eng_link_range to the columns of
 * the run of cells on this row that carry the same link. 0 for none. */
EXPORT(eng_link_at) uint32_t eng_link_at(Eng* e, uint32_t col, uint32_t row) {
  if (col >= e->cols || row >= e->rows) return 0;
  size_t n = uri_at(e, col, row, link_uri, sizeof(link_uri));
  if (!n) return 0;
  static uint8_t other[sizeof(link_uri)];
  uint32_t x0 = col, x1 = col;
  while (x0 > 0) {
    size_t m = uri_at(e, x0 - 1, row, other, sizeof(other));
    if (m != n || __builtin_memcmp(other, link_uri, n)) break;
    x0--;
  }
  while (x1 + 1 < e->cols) {
    size_t m = uri_at(e, x1 + 1, row, other, sizeof(other));
    if (m != n || __builtin_memcmp(other, link_uri, n)) break;
    x1++;
  }
  link_range[0] = x0;
  link_range[1] = x1;
  return (uint32_t)n;
}
EXPORT(eng_link_uri) uint8_t* eng_link_uri(void) { return link_uri; }
EXPORT(eng_link_range) uint32_t* eng_link_range(void) { return link_range; }

/* The text of one viewport row as UTF-8 in the dump buffer, and for every
 * byte the column it came from (eng_row_cols, u16), so a pattern found in
 * the text maps back to cells. Wide characters cover two columns; the
 * byte map gives the first. Returns the byte length. */
static uint16_t* row_cols;
static uint8_t* row_buf;
#define ROW_BUF (64u << 10)
EXPORT(eng_row_text) uint32_t eng_row_text(Eng* e, uint32_t row) {
  if (!row_cols) row_cols = (uint16_t*)xalloc(2u * ROW_BUF);
  if (!row_buf) row_buf = (uint8_t*)xalloc(ROW_BUF);
  if (!row_cols || !row_buf || row >= e->rows) return 0;
  /* During a synchronized-output hold the captured frame is what is on
   * screen, so read that. */
  if (!e->held) ghostty_render_state_update(e->rs, e->t);
  ghostty_render_state_get(e->rs, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &e->it);
  for (uint32_t y = 0; y <= row; y++)
    if (!ghostty_render_state_row_iterator_next(e->it)) return 0;
  ghostty_render_state_row_get(e->it, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &e->cells);
  uint32_t x = 0, n = 0;
  while (ghostty_render_state_row_cells_next(e->cells) && x < e->cols) {
    GhosttyCell raw = 0;
    ghostty_render_state_row_cells_get(e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw);
    if (C_WIDE(raw) == GHOSTTY_CELL_WIDE_SPACER_TAIL) { x++; continue; }
    uint8_t buf[256];
    GhosttyBuffer text = {.ptr = buf, .cap = sizeof(buf), .len = 0};
    ghostty_render_state_row_cells_get(e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &text);
    size_t len = text.len ? text.len : 1;
    if (n + len > ROW_BUF) break;
    if (text.len) MEMCPY(row_buf + n, buf, len); else row_buf[n] = ' ';
    for (uint32_t k = n; k < n + len; k++) row_cols[k] = (uint16_t)x;
    n += (uint32_t)len;
    x++;
  }
  return n;
}
EXPORT(eng_row_ptr) uint8_t* eng_row_ptr(void) { return row_buf; }
EXPORT(eng_row_cols) uint16_t* eng_row_cols(void) { return row_cols; }

/* ---- graphics for the frame ---------------------------------------- */
/* eng_gfx lists what to draw for images: kitty placements (sixel arrives
 * as one) and kitty unicode placeholder cells. Each entry is 10 words:
 * image id, layer (1 below backgrounds, 2 below text, 3 above text), then
 * destination x, y, w, h in canvas pixels and source x, y, w, h in image
 * pixels, all as float32. Call after eng_frame. */
#define GFX_WORDS 10
#define PLACEHOLDER 0x10EEEEu

static void gfx_put(Eng* e, uint32_t id, uint32_t layer, float dx, float dy, float dw, float dh,
                    float sx, float sy, float sw, float sh) {
  if (e->gfx_n == e->gfx_cap) {
    uint32_t cap = e->gfx_cap ? e->gfx_cap * 2 : 64;
    float* next = (float*)ghostty_alloc(NULL, (size_t)cap * GFX_WORDS * 4);
    if (!next) return;
    if (e->gfx_n) MEMCPY(next, e->gfx, (size_t)e->gfx_n * GFX_WORDS * 4);
    if (e->gfx) ghostty_free(NULL, (uint8_t*)e->gfx, (size_t)e->gfx_cap * GFX_WORDS * 4);
    e->gfx = next;
    e->gfx_cap = cap;
  }
  float* o = e->gfx + (size_t)e->gfx_n++ * GFX_WORDS;
  MEMCPY(&o[0], &id, 4);
  MEMCPY(&o[1], &layer, 4);
  o[2] = dx; o[3] = dy; o[4] = dw; o[5] = dh; o[6] = sx; o[7] = sy; o[8] = sw; o[9] = sh;
}

static int32_t diacritic_index(uint32_t cp) {
  int32_t lo = 0, hi = DIACRITICS_LEN - 1;
  while (lo <= hi) {
    int32_t mid = (lo + hi) / 2;
    if (DIACRITICS[mid] == cp) return mid;
    if (DIACRITICS[mid] < cp) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

static uint32_t color_id(GhosttyStyleColor c) {
  if (c.tag == GHOSTTY_STYLE_COLOR_PALETTE) return c.value.palette;
  if (c.tag == GHOSTTY_STYLE_COLOR_RGB) return ((uint32_t)c.value.rgb.r << 16) | ((uint32_t)c.value.rgb.g << 8) | c.value.rgb.b;
  return 0;
}

/* The grid a virtual placement covers, for placeholder cells. */
static bool virtual_grid(Eng* e, GhosttyKittyGraphics g, uint32_t image, uint32_t placement,
                         uint32_t* cols, uint32_t* rows) {
  if (ghostty_kitty_graphics_get(g, GHOSTTY_KITTY_GRAPHICS_DATA_PLACEMENT_ITERATOR, &e->pit)) return false;
  while (ghostty_kitty_graphics_placement_next(e->pit)) {
    uint32_t iid = 0, pid = 0, c = 0, r = 0;
    bool virt = false;
    ghostty_kitty_graphics_placement_get(e->pit, GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_IMAGE_ID, &iid);
    ghostty_kitty_graphics_placement_get(e->pit, GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_IS_VIRTUAL, &virt);
    if (!virt || iid != image) continue;
    ghostty_kitty_graphics_placement_get(e->pit, GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_PLACEMENT_ID, &pid);
    if (placement && pid != placement) continue;
    ghostty_kitty_graphics_placement_get(e->pit, GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_COLUMNS, &c);
    ghostty_kitty_graphics_placement_get(e->pit, GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_ROWS, &r);
    *cols = c;
    *rows = r;
    return true;
  }
  return false;
}

static void placeholder_cell(Eng* e, GhosttyKittyGraphics g, uint32_t x, uint32_t y, uint32_t image,
                             uint32_t placement, uint32_t row, uint32_t col) {
  GhosttyKittyGraphicsImage img = ghostty_kitty_graphics_image(g, image);
  if (!img) return;
  uint32_t iw = 0, ih = 0, cols = 0, rows = 0;
  ghostty_kitty_graphics_image_get(img, GHOSTTY_KITTY_IMAGE_DATA_WIDTH, &iw);
  ghostty_kitty_graphics_image_get(img, GHOSTTY_KITTY_IMAGE_DATA_HEIGHT, &ih);
  if (!iw || !ih || !virtual_grid(e, g, image, placement, &cols, &rows)) return;
  /* Missing grid sizes follow the image's own size in cells. */
  if (!cols) cols = (iw + e->cw - 1) / e->cw;
  if (!rows) rows = (ih + e->ch - 1) / e->ch;
  /* The image is fitted into the cols x rows box, aspect kept, centred. */
  float bw = (float)(cols * e->cw), bh = (float)(rows * e->ch);
  float sc = bw / iw < bh / ih ? bw / iw : bh / ih;
  float ox = (bw - iw * sc) / 2, oy = (bh - ih * sc) / 2;
  float cx0 = (float)(col * e->cw), cy0 = (float)(row * e->ch);
  float x0 = cx0 > ox ? cx0 : ox, y0 = cy0 > oy ? cy0 : oy;
  float x1 = cx0 + e->cw < ox + iw * sc ? cx0 + e->cw : ox + iw * sc;
  float y1 = cy0 + e->ch < oy + ih * sc ? cy0 + e->ch : oy + ih * sc;
  if (x1 <= x0 || y1 <= y0) return;
  gfx_put(e, image, 3, (float)(x * e->cw) + (x0 - cx0), (float)(y * e->ch) + (y0 - cy0), x1 - x0, y1 - y0,
          (x0 - ox) / sc, (y0 - oy) / sc, (x1 - x0) / sc, (y1 - y0) / sc);
}

EXPORT(eng_gfx) uint32_t eng_gfx(Eng* e) {
  e->gfx_n = 0;
  GhosttyKittyGraphics g = NULL;
  if (ghostty_terminal_get(e->t, GHOSTTY_TERMINAL_DATA_KITTY_GRAPHICS, &g) || !g) return 0;
  uint64_t gen = 0;
  ghostty_kitty_graphics_get(g, GHOSTTY_KITTY_GRAPHICS_DATA_GENERATION, &gen);
  if (!gen) return 0;
  bool any_virtual = false;
  /* Placements on the grid. */
  if (ghostty_kitty_graphics_get(g, GHOSTTY_KITTY_GRAPHICS_DATA_PLACEMENT_ITERATOR, &e->pit)) return 0;
  while (ghostty_kitty_graphics_placement_next(e->pit)) {
    uint32_t iid = 0, xo = 0, yo = 0;
    int32_t z = 0;
    bool virt = false;
    ghostty_kitty_graphics_placement_get(e->pit, GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_IMAGE_ID, &iid);
    ghostty_kitty_graphics_placement_get(e->pit, GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_IS_VIRTUAL, &virt);
    if (virt) { any_virtual = true; continue; }
    ghostty_kitty_graphics_placement_get(e->pit, GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_X_OFFSET, &xo);
    ghostty_kitty_graphics_placement_get(e->pit, GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_Y_OFFSET, &yo);
    ghostty_kitty_graphics_placement_get(e->pit, GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_Z, &z);
    GhosttyKittyGraphicsImage img = ghostty_kitty_graphics_image(g, iid);
    if (!img) continue;
    GhosttyKittyGraphicsPlacementRenderInfo ri = GHOSTTY_INIT_SIZED(GhosttyKittyGraphicsPlacementRenderInfo);
    if (ghostty_kitty_graphics_placement_render_info(e->pit, img, e->t, &ri) || !ri.viewport_visible ||
        !ri.pixel_width || !ri.pixel_height || !ri.source_width || !ri.source_height)
      continue;
    uint32_t layer = z < INT32_MIN / 2 ? 1 : z < 0 ? 2 : 3;
    gfx_put(e, iid, layer, (float)(ri.viewport_col * (int32_t)e->cw + (int32_t)xo),
            (float)(ri.viewport_row * (int32_t)e->ch + (int32_t)yo), (float)ri.pixel_width,
            (float)ri.pixel_height, (float)ri.source_x, (float)ri.source_y, (float)ri.source_width,
            (float)ri.source_height);
  }
  if (!any_virtual) return e->gfx_n;
  /* Unicode placeholder cells: U+10EEEE with the image id in the
   * foreground colour, the placement id in the underline colour, and row,
   * column and the image id's high byte as diacritics. Runs continue the
   * way kitty and Ghostty continue them. */
  ghostty_render_state_get(e->rs, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &e->it);
  uint32_t y = 0;
  while (y < e->rows && ghostty_render_state_row_iterator_next(e->it)) {
    GhosttyCellsView raw = {0};
    if (ghostty_render_state_row_get(e->it, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW, &raw)) { y++; continue; }
    ghostty_render_state_row_get(e->it, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &e->cells);
    bool run = false;
    uint32_t r_img = 0, r_pid = 0, r_row = 0, r_col = 0, r_w = 0, r_high = 0;
    for (uint32_t x = 0; x < raw.len && x < e->cols; x++) {
      GhosttyCell c = raw.ptr[x];
      uint32_t tag = C_TAG(c);
      if ((tag != 0 && tag != 1) || C_CP(c) != PLACEHOLDER) { run = false; continue; }
      ghostty_render_state_row_cells_select(e->cells, (uint16_t)x);
      GhosttyStyle st = GHOSTTY_INIT_SIZED(GhosttyStyle);
      ghostty_render_state_row_cells_get(e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &st);
      uint32_t img = color_id(st.fg_color), pid = color_id(st.underline_color);
      int32_t row = -1, col = -1, high = -1;
      if (tag == 1) {
        uint32_t cps[8] = {0}, len = 0;
        ghostty_render_state_row_cells_get(e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &len);
        if (len > 8) len = 8;
        if (len) ghostty_render_state_row_cells_get(e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, cps);
        if (len > 1) row = diacritic_index(cps[1]);
        if (len > 2) col = diacritic_index(cps[2]);
        if (len > 3) high = diacritic_index(cps[3]);
        if (high > 255) high = -1;
      }
      bool cont = run && img == r_img && pid == r_pid && (row < 0 || (uint32_t)row == r_row) &&
                  (col < 0 || (uint32_t)col == r_col + r_w) && (high < 0 || (uint32_t)high == r_high);
      if (cont) {
        r_w++;
      } else {
        run = true;
        r_img = img; r_pid = pid; r_w = 1;
        r_row = row < 0 ? 0 : (uint32_t)row;
        r_col = col < 0 ? 0 : (uint32_t)col;
        r_high = high < 0 ? 0 : (uint32_t)high;
      }
      placeholder_cell(e, g, x, y, r_img | (r_high << 24), r_pid, r_row, r_col + r_w - 1);
    }
    y++;
  }
  return e->gfx_n;
}
EXPORT(eng_gfx_ptr) float* eng_gfx_ptr(Eng* e) { return e->gfx; }

/* One image's pixels: width, height, format, byte length, data pointer,
 * low 32 bits of its generation. Returns NULL when the image is gone. */
EXPORT(eng_image) uint32_t* eng_image(Eng* e, uint32_t id) {
  static uint32_t out[6];
  GhosttyKittyGraphics g = NULL;
  if (ghostty_terminal_get(e->t, GHOSTTY_TERMINAL_DATA_KITTY_GRAPHICS, &g) || !g) return NULL;
  GhosttyKittyGraphicsImage img = ghostty_kitty_graphics_image(g, id);
  if (!img) return NULL;
  uint32_t w = 0, h = 0;
  GhosttyKittyImageFormat fmt = 0;
  size_t len = 0;
  const uint8_t* data = NULL;
  uint64_t gen = 0;
  ghostty_kitty_graphics_image_get(img, GHOSTTY_KITTY_IMAGE_DATA_WIDTH, &w);
  ghostty_kitty_graphics_image_get(img, GHOSTTY_KITTY_IMAGE_DATA_HEIGHT, &h);
  ghostty_kitty_graphics_image_get(img, GHOSTTY_KITTY_IMAGE_DATA_FORMAT, &fmt);
  ghostty_kitty_graphics_image_get(img, GHOSTTY_KITTY_IMAGE_DATA_DATA_LEN, &len);
  ghostty_kitty_graphics_image_get(img, GHOSTTY_KITTY_IMAGE_DATA_DATA_PTR, &data);
  ghostty_kitty_graphics_image_get(img, GHOSTTY_KITTY_IMAGE_DATA_GENERATION, &gen);
  out[0] = w; out[1] = h; out[2] = (uint32_t)fmt; out[3] = (uint32_t)len;
  out[4] = (uint32_t)(uintptr_t)data; out[5] = (uint32_t)gen;
  return out;
}

/* ---- appearance ------------------------------------------------------ */
static GhosttyColorRgb pal_buf[256];
/* JS fills 256 r,g,b triples, then calls eng_apply_palette. */
EXPORT(eng_palette_buf) uint8_t* eng_palette_buf(void) { return (uint8_t*)pal_buf; }
EXPORT(eng_apply_palette) void eng_apply_palette(Eng* e) {
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, pal_buf);
}

/* The cursor a program gets back with CSI 0 q, applied now as well.
 * style: 0 bar, 1 block, 2 underline, 3 hollow block. */
EXPORT(eng_cursor_default) void eng_cursor_default(Eng* e, uint32_t style, uint32_t blink) {
  GhosttyTerminalCursorStyle st = (GhosttyTerminalCursorStyle)style;
  bool b = blink != 0;
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_DEFAULT_CURSOR_STYLE, &st);
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_DEFAULT_CURSOR_BLINK, &b);
  static const uint8_t reset[] = "\x1b[0 q";
  ghostty_terminal_vt_write(e->t, reset, sizeof(reset) - 1);
}

EXPORT(eng_scrollback_lines) void eng_scrollback_lines(Eng* e, uint32_t lines) {
  size_t n = lines;
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &n);
}

/* A new font: new cell size and a new atlas geometry. Every cached glyph
 * is dropped; the next frame rebuilds all rows. Returns 0 on success. */
EXPORT(eng_set_cell) uint32_t eng_set_cell(Eng* e, uint32_t cw, uint32_t ch, uint32_t atlas_w, uint32_t atlas_h) {
  uint32_t spr = atlas_w / cw, max = spr * (atlas_h / ch);
  if (max > I_SLOT_MASK) max = I_SLOT_MASK;
  uint32_t* st = (uint32_t*)xalloc(4 * (size_t)max);
  uint16_t* sl = (uint16_t*)xalloc(2 * (size_t)max);
  if (!st || !sl) return 1;
  ghostty_free(NULL, (uint8_t*)e->slot_text, 4 * (size_t)e->max_slots);
  ghostty_free(NULL, (uint8_t*)e->slot_len, 2 * (size_t)e->max_slots);
  e->slot_text = st;
  e->slot_len = sl;
  e->slots_per_row = spr;
  e->max_slots = max;
  e->cw = cw;
  e->ch = ch;
  atlas_reset(e);
  ghostty_terminal_resize(e->t, e->cols, e->rows, cw, ch);
  return 0;
}

/* xterm's clear(): the cursor's line becomes the first line, and the
 * scrollback and everything above it are gone. */
EXPORT(eng_clear_scrollback) void eng_clear_scrollback(Eng* e) {
  ghostty_render_state_update(e->rs, e->t);
  GhosttyRenderStateCursor cur = GHOSTTY_INIT_SIZED(GhosttyRenderStateCursor);
  ghostty_render_state_get(e->rs, GHOSTTY_RENDER_STATE_DATA_CURSOR, &cur);
  uint32_t y = cur.viewport_has_value ? cur.viewport_y : 0, x = cur.viewport_has_value ? cur.viewport_x : 0;
  uint8_t buf[48];
  size_t o = 0;
  buf[o++] = 27; buf[o++] = '[';
  if (y) { put_num(buf, &o, y); buf[o++] = 'S'; buf[o++] = 27; buf[o++] = '['; }
  buf[o++] = '3'; buf[o++] = 'J';
  buf[o++] = 27; buf[o++] = '['; buf[o++] = '1'; buf[o++] = ';'; put_num(buf, &o, x + 1); buf[o++] = 'H';
  ghostty_terminal_vt_write(e->t, buf, o);
}

/* Full reset (RIS) plus a fresh render state, for the warm-up. */
EXPORT(eng_reset) void eng_reset(Eng* e) {
  ghostty_terminal_reset(e->t);
  e->held = false;
  e->need_capture = true;
}

EXPORT(eng_free) void eng_free(Eng* e) {
  if (!e) return;
  if (e->search) ghostty_search_free(e->search);
  if (e->matches) ghostty_free(NULL, (uint8_t*)e->matches, e->matches_cap * sizeof(GhosttySelection));
  ghostty_kitty_graphics_placement_iterator_free(e->pit);
  if (e->gfx) ghostty_free(NULL, (uint8_t*)e->gfx, (size_t)e->gfx_cap * GFX_WORDS * 4);
  sixel_end(e, false);
  ghostty_selection_gesture_event_free(e->gpress);
  ghostty_selection_gesture_event_free(e->gdrag);
  ghostty_selection_gesture_event_free(e->grelease);
  ghostty_selection_gesture_event_free(e->gtick);
  ghostty_selection_gesture_free(e->gesture, e->t);
  if (e->sel_text) ghostty_free(NULL, e->sel_text, e->sel_len);
  if (e->ev) ghostty_free(NULL, e->ev, e->ev_cap);
  ghostty_key_event_free(e->kev);
  ghostty_key_encoder_free(e->kenc);
  ghostty_mouse_event_free(e->mev);
  ghostty_mouse_encoder_free(e->menc);
  if (e->out) ghostty_free(NULL, e->out, e->out_cap);
  ghostty_render_state_row_cells_free(e->cells);
  ghostty_render_state_row_iterator_free(e->it);
  ghostty_render_state_free(e->rs);
  ghostty_terminal_free(e->t);
  ghostty_free(NULL, (uint8_t*)e->inst, (size_t)e->cols * e->rows * 12);
  ghostty_free(NULL, e->row_dirty, e->rows);
  ghostty_free(NULL, (uint8_t*)e->table, sizeof(GEnt) * e->gt_cap);
  ghostty_free(NULL, e->arena, e->arena_cap);
  ghostty_free(NULL, (uint8_t*)e->miss, sizeof(Miss) * MISS_CAP);
  ghostty_free(NULL, e->in, IN_CAP);
  ghostty_free(NULL, (uint8_t*)e->slot_text, 4 * (size_t)e->max_slots);
  ghostty_free(NULL, (uint8_t*)e->slot_len, 2 * (size_t)e->max_slots);
  if (e->dump) ghostty_free(NULL, e->dump, 4u << 20);
  ghostty_free(NULL, (uint8_t*)e, sizeof(Eng));
}

/* ---- accessors for JS ----------------------------------------------- */
EXPORT(eng_inst) uint32_t* eng_inst(Eng* e) { return e->inst; }
EXPORT(eng_row_dirty) uint8_t* eng_row_dirty(Eng* e) { return e->row_dirty; }
EXPORT(eng_cursor) uint32_t* eng_cursor(Eng* e) { return e->cursor; }
EXPORT(eng_colors) uint32_t* eng_colors(Eng* e) { return e->colors; }
EXPORT(eng_miss) Miss* eng_miss(Eng* e) { return e->miss; }
EXPORT(eng_miss_n) uint32_t eng_miss_n(Eng* e) { return e->miss_n; }
EXPORT(eng_arena) uint8_t* eng_arena(Eng* e) { return e->arena; }
EXPORT(eng_slots_per_row) uint32_t eng_slots_per_row(Eng* e) { return e->slots_per_row; }
EXPORT(eng_atlas_gen) uint32_t eng_atlas_gen(Eng* e) { return e->atlas_gen; }
EXPORT(eng_stats) uint32_t* eng_stats(Eng* e) { return e->stats; }

/* ---- accuracy dumps ------------------------------------------------- */
/* Both dumps write one line per viewport row: the row text with trailing
 * blanks trimmed, a tab, then a hex hash of (fg, bg, decoration) per cell.
 * The first line is "cursor x y visible". eng_dump_render reads only the
 * instance buffer and the glyph table, so it checks what the GPU is told.
 * eng_dump_direct reads Ghostty's cells through the public API only. */

static void dput(Eng* e, const void* p, size_t n) {
  if (e->dump_len + n > (4u << 20)) return;
  MEMCPY(e->dump + e->dump_len, p, n);
  e->dump_len += n;
}
static void dhex(Eng* e, uint32_t v) {
  char b[8];
  for (int i = 7; i >= 0; i--) { b[i] = "0123456789abcdef"[v & 15]; v >>= 4; }
  dput(e, b, 8);
}
static void dnum(Eng* e, uint32_t v) {
  char b[12]; int i = 12;
  do { b[--i] = '0' + v % 10; v /= 10; } while (v);
  dput(e, b + i, 12 - i);
}
static void dbegin(Eng* e) {
  if (!e->dump) e->dump = xalloc(4u << 20);
  e->dump_len = 0;
}
static void dcursor(Eng* e) {
  dput(e, "cursor ", 7); dnum(e, e->cursor[0]); dput(e, " ", 1);
  dnum(e, e->cursor[1]); dput(e, " ", 1); dnum(e, e->cursor[2]); dput(e, "\n", 1);
}

EXPORT(eng_dump_render) uint8_t* eng_dump_render(Eng* e) {
  eng_frame(e, 1);
  dbegin(e);
  dcursor(e);
  for (uint32_t y = 0; y < e->rows; y++) {
    uint32_t* row = e->inst + (size_t)y * e->cols * 3;
    uint32_t start = e->dump_len, end = e->dump_len, h = 2166136261u;
    const uint32_t* runs = e->runs + (size_t)y * RUNS_PER_ROW * RUN_WORDS;
    uint32_t ri = 0;
    for (uint32_t x = 0; x < e->cols; x++) {
      uint32_t w0 = row[x * 3], slot = w0 & I_SLOT_MASK;
      /* A shaped run's text stands for all of its cells. */
      while (ri < e->run_n[y] && runs[ri * RUN_WORDS] + runs[ri * RUN_WORDS + 1] <= x) ri++;
      bool in_run = ri < e->run_n[y] && x >= runs[ri * RUN_WORDS];
      if (in_run) {
        if (x == runs[ri * RUN_WORDS]) {
          uint32_t rs = runs[ri * RUN_WORDS + 2];
          dput(e, e->arena + e->slot_text[rs], e->slot_len[rs]);
          end = e->dump_len;
        }
        uint32_t a[3] = {row[x * 3 + 1], row[x * 3 + 2], w0 & ~(I_SLOT_MASK | I_WIDE)};
        if (!(w0 & I_TAIL)) for (int k = 0; k < 3; k++) h = (h ^ a[k]) * 16777619u;
        continue;
      }
      if (w0 & I_TAIL) continue;
      if (slot) {
        dput(e, e->arena + e->slot_text[slot], e->slot_len[slot]);
        end = e->dump_len;
      } else {
        dput(e, " ", 1);
      }
      uint32_t a[3] = {row[x * 3 + 1], row[x * 3 + 2], w0 & ~(I_SLOT_MASK | I_WIDE)};
      for (int k = 0; k < 3; k++) h = (h ^ a[k]) * 16777619u;
    }
    e->dump_len = end > start ? end : start;
    dput(e, "\t", 1); dhex(e, h); dput(e, "\n", 1);
  }
  return e->dump;
}

EXPORT(eng_dump_direct) uint8_t* eng_dump_direct(Eng* e) {
  ghostty_render_state_update(e->rs, e->t);
  GhosttyRenderStateCursor cur = GHOSTTY_INIT_SIZED(GhosttyRenderStateCursor);
  ghostty_render_state_get(e->rs, GHOSTTY_RENDER_STATE_DATA_CURSOR, &cur);
  uint32_t vis = cur.visible && cur.viewport_has_value;
  e->cursor[0] = vis ? cur.viewport_x : 0; e->cursor[1] = vis ? cur.viewport_y : 0; e->cursor[2] = vis;
  GhosttyRenderStateColors colors = GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
  ghostty_render_state_get(e->rs, GHOSTTY_RENDER_STATE_DATA_COLORS, &colors);
  dbegin(e);
  dcursor(e);
  ghostty_render_state_get(e->rs, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &e->it);
  uint32_t y = 0;
  while (y < e->rows && ghostty_render_state_row_iterator_next(e->it)) {
    ghostty_render_state_row_get(e->it, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &e->cells);
    uint32_t start = e->dump_len, end = e->dump_len, h = 2166136261u;
    while (ghostty_render_state_row_cells_next(e->cells)) {
      GhosttyCell raw = 0;
      ghostty_render_state_row_cells_get(e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw);
      GhosttyCellWide wide = 0;
      ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide);
      if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL) continue;
      GhosttyStyle st = GHOSTTY_INIT_SIZED(GhosttyStyle);
      ghostty_render_state_row_cells_get(e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &st);
      GhosttyColorRgb fgc = colors.foreground, bgc = colors.background;
      ghostty_render_state_row_cells_get(e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &fgc);
      ghostty_render_state_row_cells_get(e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &bgc);
      uint32_t fg = rgb(fgc), bg = rgb(bgc);
      if (st.inverse) { uint32_t t = fg; fg = bg; bg = t; }
      uint8_t buf[256];
      GhosttyBuffer text = {.ptr = buf, .cap = sizeof(buf), .len = 0};
      ghostty_render_state_row_cells_get(e->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &text);
      bool blank = text.len == 0 || (text.len == 1 && buf[0] == ' ') || st.invisible ||
                   wide == GHOSTTY_CELL_WIDE_SPACER_HEAD;
      if (blank) dput(e, " ", 1);
      else { dput(e, buf, text.len); end = e->dump_len; }
      uint32_t flags = ((uint32_t)(st.underline & 7) << I_UL_SHIFT) | (st.strikethrough ? I_STRIKE : 0) |
                       (st.overline ? I_OVERLINE : 0) | (st.faint ? I_FAINT : 0) | (st.blink ? I_BLINK : 0);
      if (wide == GHOSTTY_CELL_WIDE_SPACER_HEAD) flags = 0;
      uint32_t a[3] = {fg, bg, flags};
      for (int k = 0; k < 3; k++) h = (h ^ a[k]) * 16777619u;
    }
    e->dump_len = end > start ? end : start;
    dput(e, "\t", 1); dhex(e, h); dput(e, "\n", 1);
    y++;
  }
  return e->dump;
}
EXPORT(eng_dump_len) uint32_t eng_dump_len(Eng* e) { return e->dump_len; }
EXPORT(eng_dump_ptr) uint8_t* eng_dump_ptr(Eng* e) { return e->dump; }

/* Checks the hard-coded cell layout against the public getter. Returns 0
 * when they agree. */
EXPORT(eng_selftest) uint32_t eng_selftest(Eng* e) {
  static const char probe[] = "\x1b[H\x1b[2J\x1b[38;5;3mA\xe6\xbc\xa2\x1b[48;2;1;2;3m\x1b[K";
  ghostty_terminal_vt_write(e->t, (const uint8_t*)probe, sizeof(probe) - 1);
  ghostty_render_state_update(e->rs, e->t);
  ghostty_render_state_get(e->rs, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &e->it);
  uint32_t bad = 0;
  if (!ghostty_render_state_row_iterator_next(e->it)) return 1;
  GhosttyCellsView raw = {0};
  ghostty_render_state_row_get(e->it, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW, &raw);
  for (size_t x = 0; x < raw.len && x < 8; x++) {
    GhosttyCell c = raw.ptr[x];
    uint32_t cp = 0, tag = 0, wide = 0; uint16_t sid = 0;
    ghostty_cell_get(c, GHOSTTY_CELL_DATA_CODEPOINT, &cp);
    ghostty_cell_get(c, GHOSTTY_CELL_DATA_CONTENT_TAG, &tag);
    ghostty_cell_get(c, GHOSTTY_CELL_DATA_WIDE, &wide);
    ghostty_cell_get(c, GHOSTTY_CELL_DATA_STYLE_ID, &sid);
    if (tag != C_TAG(c)) bad |= 2;
    if (wide != C_WIDE(c)) bad |= 4;
    if (sid != C_STYLE(c)) bad |= 8;
    if ((tag == 0 || tag == 1) && cp != C_CP(c)) bad |= 16;
  }
  ghostty_terminal_reset(e->t);
  return bad;
}
