/* Native replay for the accuracy reference and for profiling.
 *
 *   replay COLS ROWS MODE FILE...
 *
 * MODE is "direct" (dump Ghostty's cells through the public API),
 * "render" (dump what the instance buffer says) or "bench" (time the
 * parse and the frame builds, no dump). Each FILE is fed in 64 KiB writes
 * to a fresh terminal; dumps are separated by a line "== FILE". */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct Eng Eng;
Eng* eng_new(uint16_t, uint16_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
void eng_write(Eng*, const uint8_t*, size_t);
uint32_t eng_frame(Eng*, uint32_t);
uint8_t* eng_dump_render(Eng*);
uint8_t* eng_dump_direct(Eng*);
uint32_t eng_dump_len(Eng*);
uint32_t eng_selftest(Eng*);
void eng_theme(Eng*, uint32_t, uint32_t, uint32_t);

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

int main(int argc, char** argv) {
  if (argc < 5) { fprintf(stderr, "usage: replay COLS ROWS direct|render|bench FILE...\n"); return 2; }
  int cols = atoi(argv[1]), rows = atoi(argv[2]);
  const char* mode = argv[3];
  for (int i = 4; i < argc; i++) {
    FILE* f = fopen(argv[i], "rb");
    if (!f) { perror(argv[i]); return 1; }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t* buf = malloc(n ? n : 1);
    if (fread(buf, 1, n, f) != (size_t)n) { perror("read"); return 1; }
    fclose(f);
    Eng* e = eng_new(cols, rows, 10000, 8, 18, 2048, 2048);
    if (!e || eng_selftest(e)) { fprintf(stderr, "engine init or self-test failed\n"); return 1; }
    /* The harness theme (Catppuccin Mocha), so colour hashes compare. */
    eng_theme(e, 0xf4d6cd, 0x2e1e1e, 0xdce0f5);
    double t0 = now(), tf = 0;
    long frames = 0;
    for (long off = 0; off < n; off += 65536) {
      long len = n - off < 65536 ? n - off : 65536;
      eng_write(e, buf + off, len);
      if (!strcmp(mode, "bench") && (off / 65536) % 16 == 15) {
        double a = now();
        eng_frame(e, 0);
        tf += now() - a;
        frames++;
      }
    }
    double t1 = now();
    if (!strcmp(mode, "bench")) {
      printf("%s: %.1f ms total, %.1f MiB/s, %ld frames %.2f ms\n", argv[i], t1 - t0,
             n / 1048576.0 / ((t1 - t0) / 1000), frames, tf);
    } else {
      uint8_t* d = !strcmp(mode, "direct") ? eng_dump_direct(e) : eng_dump_render(e);
      printf("== %s\n", argv[i]);
      fwrite(d, 1, eng_dump_len(e), stdout);
    }
    free(buf);
  }
  return 0;
}
