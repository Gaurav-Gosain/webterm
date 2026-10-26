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

#define GT_CAP 32768u /* glyph table, power of two */
#define ARENA_CAP (1u << 20)
#define MISS_CAP 4096u
#define IN_CAP (1u << 20)

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
  uint32_t atlas_gen;
  Miss* miss;
  uint32_t miss_n;
  uint8_t* in; /* input staging for JS */
  uint8_t* dump;
  uint32_t dump_len;
  uint32_t stats[8];
} Eng;

static void* xalloc(size_t n) {
  uint8_t* p = ghostty_alloc(NULL, n);
  if (p) MEMSET(p, 0, n);
  return p;
}

static uint32_t rgb(GhosttyColorRgb c) {
  return (uint32_t)c.r | ((uint32_t)c.g << 8) | ((uint32_t)c.b << 16);
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
  e->table = xalloc(sizeof(GEnt) * GT_CAP);
  e->arena = xalloc(ARENA_CAP);
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
  ghostty_terminal_set(e->t, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &c);
}

EXPORT(eng_input) uint8_t* eng_input(Eng* e) { return e->in; }
EXPORT(eng_write_input) void eng_write_input(Eng* e, uint32_t n) {
  ghostty_terminal_vt_write(e->t, e->in, n);
  e->stats[0] += n;
}
void eng_write(Eng* e, const uint8_t* p, size_t n) { ghostty_terminal_vt_write(e->t, p, n); }

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
  MEMSET(e->table, 0, sizeof(GEnt) * GT_CAP);
  e->arena_len = 0;
  e->next_slot = 1;
  e->miss_n = 0;
  e->atlas_gen++;
}

/* Returns the slot, or 0 when the atlas is full (the caller resets and
 * rebuilds the frame). style: bit0 bold, bit1 italic. */
static uint32_t glyph(Eng* e, uint64_t key, const uint8_t* text, size_t len, uint32_t width,
                      uint32_t style, bool* full) {
  uint32_t h = (uint32_t)(key ^ (key >> 29) ^ (key >> 47)) * 2654435761u;
  for (uint32_t i = 0;; i++) {
    GEnt* g = &e->table[(h + i) & (GT_CAP - 1)];
    if (!g->used) {
      /* miss: allocate */
      uint32_t slot = e->next_slot;
      if (width == 2 && (slot % e->slots_per_row) == e->slots_per_row - 1) slot++;
      if (slot + width > e->max_slots || e->arena_len + len > ARENA_CAP ||
          e->miss_n >= MISS_CAP || i > GT_CAP / 2) {
        *full = true;
        return 0;
      }
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
  bool full = false;
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
    if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL) {
      w0 = I_TAIL;
    } else if (wide == GHOSTTY_CELL_WIDE_SPACER_HEAD) {
      w0 = 0; /* the blank Ghostty leaves where a wide char wrapped */
    } else if (invisible) {
      /* nothing to draw */
    } else if (tag == GHOSTTY_CELL_CONTENT_CODEPOINT) {
      uint32_t cp = C_CP(c);
      if (cp > 32) {
        uint8_t buf[4];
        size_t len = utf8(cp, buf);
        uint32_t width = wide == GHOSTTY_CELL_WIDE_WIDE ? 2 : 1;
        slot = glyph(e, (uint64_t)cp | ((uint64_t)sstyle << 21) | ((uint64_t)width << 24), buf, len,
                     width, sstyle, &full);
      }
    } else if (tag == GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME) {
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
  return true;
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
  if (dirty == GHOSTTY_RENDER_STATE_DIRTY_FALSE && !force) return ret | (cursor_changed ? F_DRAW : 0);
  GhosttyRenderStateColors* colors = &g_colors;
  *colors = (GhosttyRenderStateColors)GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
  ghostty_render_state_get(e->rs, GHOSTTY_RENDER_STATE_DATA_COLORS, colors);
  e->colors[0] = rgb(colors->foreground);
  e->colors[1] = rgb(colors->background);
  e->colors[2] = colors->cursor_has_value ? rgb(colors->cursor) : rgb(colors->foreground);
  bool all = force || dirty == GHOSTTY_RENDER_STATE_DIRTY_FULL;
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

EXPORT(eng_free) void eng_free(Eng* e) {
  if (!e) return;
  ghostty_render_state_row_cells_free(e->cells);
  ghostty_render_state_row_iterator_free(e->it);
  ghostty_render_state_free(e->rs);
  ghostty_terminal_free(e->t);
  ghostty_free(NULL, (uint8_t*)e->inst, (size_t)e->cols * e->rows * 12);
  ghostty_free(NULL, e->row_dirty, e->rows);
  ghostty_free(NULL, (uint8_t*)e->table, sizeof(GEnt) * GT_CAP);
  ghostty_free(NULL, e->arena, ARENA_CAP);
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
    for (uint32_t x = 0; x < e->cols; x++) {
      uint32_t w0 = row[x * 3], slot = w0 & I_SLOT_MASK;
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
