// Smoke test for the emscripten libuv port: exercises the loop features
// neovim's event loop relies on. Prints "ok <name>" per check, exits 0 if
// all pass.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <uv.h>

static int failures = 0;
#define CHECK(name, cond) \
  do { \
    if (cond) { printf("ok %s\n", name); } \
    else { printf("FAIL %s\n", name); failures++; } \
  } while (0)

static int timer_fired = 0;
static void on_timer(uv_timer_t *t) { timer_fired++; uv_close((uv_handle_t *)t, NULL); }

static int idle_count = 0;
static void on_idle(uv_idle_t *h) { if (++idle_count == 3) uv_idle_stop(h); }

static int work_ran = 0, work_done = 0;
static void do_work(uv_work_t *r) { work_ran = 1; }
static void after_work(uv_work_t *r, int status) { work_done = status == 0 ? 1 : -1; }

static int fs_done = 0;
static void on_fs(uv_fs_t *r) { fs_done = r->result >= 0 ? 1 : -1; uv_fs_req_cleanup(r); }

static int async_hit = 0;
static void on_async(uv_async_t *a) { async_hit++; uv_close((uv_handle_t *)a, NULL); }

static char pipe_buf[64];
static size_t pipe_len = 0;
static void alloc_cb(uv_handle_t *h, size_t sz, uv_buf_t *b) { *b = uv_buf_init(pipe_buf + pipe_len, sizeof(pipe_buf) - pipe_len); }
static void on_read(uv_stream_t *s, ssize_t n, const uv_buf_t *b) {
  if (n > 0) pipe_len += n;
  uv_read_stop(s);
  uv_close((uv_handle_t *)s, NULL);
}

int main(void) {
  uv_loop_t *loop = uv_default_loop();

  uv_timer_t timer;
  uv_timer_init(loop, &timer);
  uv_timer_start(&timer, on_timer, 10, 0);

  uv_idle_t idle;
  uv_idle_init(loop, &idle);
  uv_idle_start(&idle, on_idle);

  uv_work_t work;
  uv_queue_work(loop, &work, do_work, after_work);

  uv_fs_t fs;
  uv_fs_mkdir(loop, &fs, "/tmp/uvtest", 0755, on_fs);

  uv_async_t async;
  uv_async_init(loop, &async, on_async);
  uv_async_send(&async);

  uv_file fds[2];
  int pipe_err = uv_pipe(fds, 0, 0);
  uv_pipe_t reader;
  if (pipe_err == 0) {
    uv_pipe_init(loop, &reader, 0);
    uv_pipe_open(&reader, fds[0]);
    uv_read_start((uv_stream_t *)&reader, alloc_cb, on_read);
    uv_fs_t wr;
    uv_buf_t b = uv_buf_init("hello", 5);
    uv_fs_write(NULL, &wr, fds[1], &b, 1, -1, NULL);
    uv_fs_req_cleanup(&wr);
  }

  uint64_t start = uv_now(loop);
  uv_run(loop, UV_RUN_DEFAULT);

  CHECK("timer", timer_fired == 1);
  CHECK("timer-elapsed", uv_now(loop) - start >= 10);
  CHECK("idle", idle_count == 3);
  CHECK("queue_work", work_ran && work_done == 1);
  CHECK("fs-async", fs_done == 1);
  CHECK("async", async_hit == 1);
  CHECK("pipe", pipe_err == 0 && pipe_len == 5 && memcmp(pipe_buf, "hello", 5) == 0);

  uv_loop_close(loop);
  return failures ? 1 : 0;
}
