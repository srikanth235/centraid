/* The C harness for the binding spike, host half (#1020, D-1020-D2-7).
 *
 * What it measures: the cost of crossing the ABI, ten thousand times, for a
 * bounded read, plus the event drain rate. What it does NOT measure: a phone.
 * These are `ci-linux-x64-4c` numbers and the receipt says so — the device half
 * (cinterop on iOS, JNA on Android, the Swift wrapper) is wave 3 lane E's and is
 * an owner hand-off.
 *
 * The point of the spike is to fix the ABI's SHAPE before three shells are
 * written against it. A number that is fine here and terrible on an iPhone
 * would still have validated the shape; a shape that needs a sixth symbol would
 * not, and that is the thing this catches early.
 *
 * Built and run from `tests/spike.rs`, which compiles it with `cc` against the
 * built cdylib. Run on its own:
 *
 *   cc -O2 spike.c -L<target>/debug -lcentraid_core_ffi -o spike
 *   LD_LIBRARY_PATH=<target>/debug ./spike /tmp/spike-vault.db
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* The five. Declared here rather than by including `centraid.h`, deliberately:
 * a shell author's first act is to write these five lines, and a spike that
 * included the generated header would not have tested that the header's
 * signatures are what a hand-written declaration would say. `tests/header.rs`
 * checks the generated header separately. */
typedef struct Handle Handle;

extern int32_t centraid_open(const uint8_t *config, size_t len, Handle **out);
extern int32_t centraid_call(Handle *h, const uint8_t *req, size_t len,
                             uint8_t **out_buf, size_t *out_len);
extern int32_t centraid_next_event(Handle *h, uint32_t timeout_ms,
                                   uint8_t **out_buf, size_t *out_len);
extern void centraid_free(uint8_t *buf, size_t len);
extern int32_t centraid_close(Handle *h);

#define CENTRAID_OK 0
#define CENTRAID_TIMEOUT -5

#define CALLS 10000

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1.0e6;
}

static int compare_double(const void *left, const void *right) {
  double a = *(const double *)left;
  double b = *(const double *)right;
  return (a > b) - (a < b);
}

/* Nearest-rank percentile over a sorted sample. */
static double percentile(const double *sorted, size_t count, double fraction) {
  if (count == 0) return 0.0;
  size_t rank = (size_t)(fraction * (double)count);
  if (rank >= count) rank = count - 1;
  return sorted[rank];
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr,
            "usage: %s <vault-path> <request-bytes-file>\n"
            "  the request file holds one encoded centraid.core.v1.Envelope,\n"
            "  written by tests/spike.rs so this harness needs no protobuf\n",
            argv[0]);
    return 2;
  }

  /* --- open --------------------------------------------------------------- */

  char config[4096];
  int written = snprintf(config, sizeof config,
                         "{\"path\":\"%s\",\"role\":\"gateway\",\"create\":true}",
                         argv[1]);
  if (written < 0 || (size_t)written >= sizeof config) {
    fprintf(stderr, "the vault path does not fit in the configuration buffer\n");
    return 2;
  }

  Handle *handle = NULL;
  double open_started = now_ms();
  int32_t code = centraid_open((const uint8_t *)config, strlen(config), &handle);
  double open_ms = now_ms() - open_started;
  if (code != CENTRAID_OK || handle == NULL) {
    fprintf(stderr, "centraid_open failed: %d\n", code);
    return 1;
  }

  /* --- the request bytes -------------------------------------------------- */

  FILE *file = fopen(argv[2], "rb");
  if (file == NULL) {
    fprintf(stderr, "cannot read %s\n", argv[2]);
    centraid_close(handle);
    return 1;
  }
  static uint8_t request[65536];
  size_t request_len = fread(request, 1, sizeof request, file);
  fclose(file);
  if (request_len == 0) {
    fprintf(stderr, "%s is empty\n", argv[2]);
    centraid_close(handle);
    return 1;
  }

  /* --- warm up, unmeasured ----------------------------------------------- */

  for (int index = 0; index < 100; index++) {
    uint8_t *buf = NULL;
    size_t len = 0;
    code = centraid_call(handle, request, request_len, &buf, &len);
    if (code != CENTRAID_OK) {
      fprintf(stderr, "warm-up call failed: %d\n", code);
      centraid_close(handle);
      return 1;
    }
    centraid_free(buf, len);
  }

  /* --- ten thousand bounded reads ---------------------------------------- */

  double *samples = malloc(sizeof(double) * CALLS);
  if (samples == NULL) {
    fprintf(stderr, "out of memory\n");
    centraid_close(handle);
    return 1;
  }
  size_t total_bytes = 0;
  double loop_started = now_ms();
  for (int index = 0; index < CALLS; index++) {
    uint8_t *buf = NULL;
    size_t len = 0;
    double started = now_ms();
    code = centraid_call(handle, request, request_len, &buf, &len);
    samples[index] = now_ms() - started;
    if (code != CENTRAID_OK) {
      fprintf(stderr, "call %d failed: %d\n", index, code);
      free(samples);
      centraid_close(handle);
      return 1;
    }
    /* The answer is READ, not only freed: a spike that measured a call whose
     * bytes nobody touched would measure a call the optimiser could remove. */
    total_bytes += len;
    if (len > 0 && buf[0] == 0xff) {
      fprintf(stderr, "impossible first byte; this branch exists to keep the "
                      "read from being optimised away\n");
    }
    centraid_free(buf, len);
  }
  double loop_ms = now_ms() - loop_started;

  qsort(samples, CALLS, sizeof(double), compare_double);

  /* --- drain the event queue --------------------------------------------- */

  int events = 0;
  double drain_started = now_ms();
  for (;;) {
    uint8_t *buf = NULL;
    size_t len = 0;
    code = centraid_next_event(handle, 1, &buf, &len);
    if (code == CENTRAID_TIMEOUT) {
      /* CLAUSE 6: a timeout allocates nothing, so there is nothing to free. */
      break;
    }
    if (code != CENTRAID_OK) break;
    events++;
    centraid_free(buf, len);
    if (events >= 100000) break;
  }
  double drain_ms = now_ms() - drain_started;

  printf("{\n");
  printf("  \"harness\": \"c\",\n");
  printf("  \"hardware\": \"ci-linux-x64-4c\",\n");
  printf("  \"openMs\": %.3f,\n", open_ms);
  printf("  \"calls\": %d,\n", CALLS);
  printf("  \"p50Us\": %.2f,\n", percentile(samples, CALLS, 0.50) * 1000.0);
  printf("  \"p95Us\": %.2f,\n", percentile(samples, CALLS, 0.95) * 1000.0);
  printf("  \"p99Us\": %.2f,\n", percentile(samples, CALLS, 0.99) * 1000.0);
  printf("  \"callsPerSecond\": %.0f,\n",
         loop_ms > 0.0 ? (double)CALLS * 1000.0 / loop_ms : 0.0);
  printf("  \"answerBytesMean\": %.0f,\n", (double)total_bytes / (double)CALLS);
  printf("  \"events\": %d,\n", events);
  printf("  \"eventsPerSecond\": %.0f\n",
         drain_ms > 0.0 ? (double)events * 1000.0 / drain_ms : 0.0);
  printf("}\n");

  free(samples);
  return centraid_close(handle) == CENTRAID_OK ? 0 : 1;
}
