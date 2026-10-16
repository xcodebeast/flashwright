#define _GNU_SOURCE
/* CPU-custody regression fixture for run-linux-cgroup-command-tests.py.
 * Every case spends at least 80 ms of process CPU in a child. The subreaper
 * cases make that worker an orphan before it starts the measured work.
 */
#include <assert.h>
#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static long long cpu_ns(void) {
  struct timespec value;
  assert(clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &value) == 0);
  return value.tv_sec * 1000000000LL + value.tv_nsec;
}
static void delay(void) {
  struct timespec value = {.tv_nsec = 1000000};
  nanosleep(&value, NULL);
}
static void burn_cpu(void) {
  long long end = cpu_ns() + 80000000;
  while (cpu_ns() < end) {}
}
static void finish_child(pid_t child, bool automatic) {
  int status;
  if (!automatic) {
    assert(waitpid(child, &status, 0) == child && status == 0);
    return;
  }
  bool gone = false;
  for (int i = 0; i < 4000; i++) {
    if (kill(child, 0) < 0) {
      assert(errno == ESRCH);
      gone = true;
      break;
    }
    delay();
  }
  assert(gone);
  assert(waitpid(child, &status, 0) == -1 && errno == ECHILD);
}
static void run_case(const char *mode, bool orphan) {
  bool ignored = !strcmp(mode, "ignored");
  bool no_wait = !strcmp(mode, "nocldwait");
  assert(ignored || no_wait || !strcmp(mode, "reaped"));
  struct sigaction action = {0};
  sigemptyset(&action.sa_mask);
  action.sa_handler = ignored ? SIG_IGN : SIG_DFL;
  action.sa_flags = no_wait ? SA_NOCLDWAIT : 0;
  assert(sigaction(SIGCHLD, &action, NULL) == 0);
  int channel[2];
  assert(pipe(channel) == 0);
  pid_t reaper = getpid();
  pid_t child = fork();
  assert(child >= 0);
  if (!child) {
    close(channel[0]);
    if (orphan) {
      pid_t worker = fork();
      assert(worker >= 0);
      if (worker) {
        assert(write(channel[1], &worker, sizeof(worker)) == sizeof(worker));
        _exit(0);
      }
      close(channel[1]);
      bool adopted = false;
      for (int i = 0; i < 4000; i++) {
        if (getppid() == reaper) { adopted = true; break; }
        delay();
      }
      assert(adopted);
    } else {
      close(channel[1]);
    }
    burn_cpu();
    _exit(0);
  }
  close(channel[1]);
  pid_t worker = -1;
  if (orphan) assert(read(channel[0], &worker, sizeof(worker)) == sizeof(worker));
  close(channel[0]);
  finish_child(child, ignored || no_wait);
  if (orphan) finish_child(worker, ignored || no_wait);
}
int main(int argc, char **argv) {
  assert(argc == 2);
  if (!strncmp(argv[1], "subreaper-", 10)) {
    pid_t child = fork();
    assert(child >= 0);
    if (!child) {
      assert(prctl(PR_SET_CHILD_SUBREAPER, 1) == 0);
      run_case(argv[1] + 10, true);
      _exit(0);
    }
    finish_child(child, false);
  } else {
    run_case(argv[1], false);
  }
  return 0;
}
