#define _GNU_SOURCE
/* Experimental Linux capture primitive; see SPECS.md S6 for admission limits.
 * Build: cc -std=c11 -O2 -Wall -Wextra -Werror -o <output> this-file.c
 * Usage: <output> <fresh-cgroup> <exclusive-report> <32-hex-id> <timeout-ms>
 *                 <absolute-command> [arguments...]
 * The caller owns delegation, policy admission and an outer cleanup deadline.
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/magic.h>
#include <linux/sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define FIELD_BYTES 4096
static volatile sig_atomic_t interrupted;
static void on_signal(int number) { interrupted = number; }
static uint64_t now_ns(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value)) _exit(90);
  return (uint64_t)value.tv_sec * UINT64_C(1000000000) + value.tv_nsec;
}
static void pause_poll(void) {
  struct timespec delay = {.tv_nsec = 1000000};
  nanosleep(&delay, NULL);
}
static int read_field(int directory, const char *name, char *value) {
  int fd = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  size_t used = 0;
  value[0] = 0;
  for (;;) {
    char overflow;
    bool full = used == FIELD_BYTES - 1;
    ssize_t count = read(fd, full ? &overflow : value + used, full ? 1 : FIELD_BYTES - 1 - used);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 || (full && count)) { close(fd); return -1; }
    if (!count) break;
    used += (size_t)count;
    value[used] = 0;
  }
  close(fd);
  if (memchr(value, 0, used)) return -1;
  value[used] = 0;
  return 0;
}
static int unsigned_number(const char *text, uint64_t *value, const char **end) {
  if (*text < '0' || *text > '9') return -1;
  errno = 0;
  char *after;
  unsigned long long parsed = strtoull(text, &after, 10);
  if (errno) return -1;
  *value = parsed;
  *end = after;
  return 0;
}
/* Parse the complete key/value file, rejecting malformed and duplicate fields. */
static int counter(const char *text, const char *key, uint64_t *value) {
  char names[128][64];
  size_t count = 0;
  bool found = false;
  while (*text) {
    const char *space = strchr(text, ' ');
    if (!space || space == text || space - text >= 64 || count >= 128) return -1;
    for (const char *p = text; p != space; p++)
      if (!((*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9') || *p == '_' || *p == '.')) return -1;
    size_t length = (size_t)(space - text);
    memcpy(names[count], text, length); names[count][length] = 0;
    for (size_t i = 0; i < count; i++) if (!strcmp(names[i], names[count])) return -1;
    uint64_t number;
    const char *after;
    if (unsigned_number(space + 1, &number, &after) || *after != '\n') return -1;
    if (!strcmp(names[count], key)) { found = true; *value = number; }
    count++;
    text = after + 1;
  }
  return found ? 0 : -1;
}
static int scalar(const char *text, uint64_t *value) {
  const char *after;
  return unsigned_number(text, value, &after) || strcmp(after, "\n") ? -1 : 0;
}
struct snapshot {
  uint64_t started, finished, cpu, user, system, peak, populated;
  char cpu_stat[FIELD_BYTES], memory_peak[FIELD_BYTES], events[FIELD_BYTES];
  char procs[FIELD_BYTES], type[FIELD_BYTES];
};
static int snapshot(int directory, struct snapshot *result) {
  result->started = now_ns();
  if (read_field(directory, "cpu.stat", result->cpu_stat) ||
      read_field(directory, "memory.peak", result->memory_peak) ||
      read_field(directory, "cgroup.events", result->events) ||
      read_field(directory, "cgroup.procs", result->procs) ||
      read_field(directory, "cgroup.type", result->type)) return -1;
  result->finished = now_ns();
  if (strcmp(result->type, "domain\n") ||
      counter(result->cpu_stat, "usage_usec", &result->cpu) ||
      counter(result->cpu_stat, "user_usec", &result->user) ||
      counter(result->cpu_stat, "system_usec", &result->system) ||
      counter(result->events, "populated", &result->populated) || result->populated > 1 ||
      scalar(result->memory_peak, &result->peak)) return -1;
  return 0;
}
static int require_leaf(int directory) {
  int copied = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (copied < 0) return -1;
  DIR *entries = fdopendir(copied);
  if (!entries) { close(copied); return -1; }
  struct dirent *entry;
  int result = 0;
  errno = 0;
  while ((entry = readdir(entries))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    struct stat info;
    if (fstatat(directory, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) || S_ISDIR(info.st_mode)) {
      result = -1; break;
    }
  }
  if (errno) result = -1;
  closedir(entries);
  return result;
}
struct adopted_wait {
  pid_t process;
  int status;
  uint64_t started, finished;
  struct rusage usage;
};
#define MAX_ADOPTED 8192
static struct adopted_wait adopted_waits[MAX_ADOPTED];
static int population(int directory) {
  char events[FIELD_BYTES]; uint64_t value;
  if (read_field(directory, "cgroup.events", events) ||
      counter(events, "populated", &value) || value > 1) return -1;
  return (int)value;
}
static int kill_group(int directory) {
  int fd = openat(directory, "cgroup.kill", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  ssize_t count;
  do { count = write(fd, "1", 1); } while (count < 0 && errno == EINTR);
  close(fd);
  return count == 1 ? 0 : -1;
}
static void json_text(FILE *file, const char *text) {
  fputc('"', file);
  for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
    if (*p == '"' || *p == '\\') fprintf(file, "\\%c", *p);
    else if (*p < 32 || *p >= 127) fprintf(file, "\\u%04x", *p);
    else fputc(*p, file);
  }
  fputc('"', file);
}
static void print_snapshot(FILE *file, const struct snapshot *value) {
  fprintf(file, "{\"startedNanoseconds\":\"%"PRIu64"\",\"finishedNanoseconds\":\"%"PRIu64"\",\"cpuStat\":", value->started, value->finished);
  json_text(file, value->cpu_stat);
  fputs(",\"memoryPeak\":", file); json_text(file, value->memory_peak);
  fputs(",\"events\":", file); json_text(file, value->events);
  fputs(",\"processes\":", file); json_text(file, value->procs);
  fputs(",\"type\":", file); json_text(file, value->type);
  fputc('}', file);
}
static int finish_report(FILE *file) {
  int failed = ferror(file);
  if (fflush(file)) failed = 1;
  if (fsync(fileno(file))) failed = 1;
  if (fclose(file)) failed = 1;
  return failed;
}
static long long micros(struct timeval value) {
  return (long long)value.tv_sec * 1000000 + value.tv_usec;
}
int main(int argc, char **argv) {
  if (argc < 6 || strlen(argv[3]) != 32 || argv[5][0] != '/') return 2;
  for (size_t i = 0; i < 32; i++) if (!strchr("0123456789abcdef", argv[3][i])) return 2;
  uint64_t duration; const char *end;
  if (unsigned_number(argv[4], &duration, &end) || *end || duration < 50 || duration > 3600000) return 2;
  int group = open(argv[1], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat initial_identity;
  struct statfs filesystem;
  struct snapshot before = {0}, after = {0};
  if (group < 0 || fstat(group, &initial_identity) || fstatfs(group, &filesystem) ||
      filesystem.f_type != CGROUP2_SUPER_MAGIC || require_leaf(group) || snapshot(group, &before) ||
      before.cpu || before.user || before.system || before.peak || before.populated || *before.procs) {
    fputs("Require an empty, unused cgroup v2 domain with cpu and memory counters\n", stderr);
    return 3;
  }
  int output = open(argv[2], O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (output < 0) return 4;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1)) return 5;
  struct sigaction action = {.sa_handler = on_signal};
  sigemptyset(&action.sa_mask);
  struct sigaction child_action = {.sa_handler = SIG_DFL};
  sigemptyset(&child_action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL) ||
      sigaction(SIGCHLD, &child_action, NULL)) return 6;
  struct clone_args args = {.flags = CLONE_INTO_CGROUP, .exit_signal = SIGCHLD, .cgroup = (uint64_t)group};
  uint64_t clone_started = now_ns();
  pid_t pid = syscall(SYS_clone3, &args, sizeof(args));
  int launch_error = pid < 0 ? errno : 0;
  if (pid == 0) {
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL);
    if (setsid() < 0 || syscall(SYS_close_range, 3, ~0U, 0)) _exit(126);
    execv(argv[5], &argv[5]); _exit(127);
  }
  uint64_t clone_finished = now_ns(), deadline = clone_started + duration * UINT64_C(1000000);
  int wait_status = 0, cleanup_error = 0, survivors = -1, adopted = 0;
  bool observed = false, timed_out = false, killed = false, no_children = false;
  struct rusage usage = {0};
  uint64_t wait_started = 0, wait_finished = 0;
  if (pid > 0) {
    for (;;) {
      wait_started = now_ns();
      pid_t reaped = wait4(pid, &wait_status, WNOHANG, &usage);
      wait_finished = now_ns();
      if (reaped == pid) {
        observed = WIFEXITED(wait_status) || WIFSIGNALED(wait_status);
        if (!observed) cleanup_error = 1;
        break;
      }
      if (reaped < 0 && errno != EINTR) { cleanup_error = 1; break; }
      if (!killed && (interrupted || now_ns() >= deadline)) {
        timed_out = !interrupted;
        if (kill_group(group)) cleanup_error = 1;
        killed = true; deadline = now_ns() + UINT64_C(2000000000);
      } else if (killed && now_ns() >= deadline) { cleanup_error = 1; break; }
      pause_poll();
    }
    survivors = population(group);
    if (survivors != 0) {
      if (kill_group(group)) cleanup_error = 1;
      killed = true;
    }
    uint64_t drain_deadline = now_ns() + UINT64_C(2000000000);
    while (now_ns() < drain_deadline) {
      int status; struct rusage child_usage;
      uint64_t started = now_ns();
      pid_t reaped = wait4(-1, &status, WNOHANG, &child_usage);
      uint64_t finished = now_ns();
      if (reaped == pid) {
        observed = true; wait_status = status; usage = child_usage;
        wait_started = started; wait_finished = finished;
        continue;
      }
      if (reaped > 0) {
        if (adopted < MAX_ADOPTED) adopted_waits[adopted] = (struct adopted_wait){
          .process = reaped, .status = status, .started = started, .finished = finished, .usage = child_usage};
        else cleanup_error = 1;
        adopted++; continue;
      }
      if (reaped < 0 && errno == ECHILD) { no_children = true; break; }
      if (reaped < 0 && errno != EINTR) { cleanup_error = 1; break; }
      pause_poll();
    }
    if (!no_children) cleanup_error = 1;
  }
  /* Completion has won once all waits/drains finish. Freeze signal reporting
   * before calculating the terminal fields so they cannot contradict each other. */
  sigset_t terminal_signals;
  sigemptyset(&terminal_signals); sigaddset(&terminal_signals, SIGINT); sigaddset(&terminal_signals, SIGTERM);
  if (sigprocmask(SIG_BLOCK, &terminal_signals, NULL)) cleanup_error = 1;
  bool after_valid = snapshot(group, &after) == 0;
  bool final_leaf = require_leaf(group) == 0;
  struct stat final_identity, path_identity;
  bool identity_valid = !fstat(group, &final_identity) && !lstat(argv[1], &path_identity) &&
      S_ISDIR(path_identity.st_mode) && initial_identity.st_dev == final_identity.st_dev &&
      initial_identity.st_ino == final_identity.st_ino && initial_identity.st_dev == path_identity.st_dev &&
      initial_identity.st_ino == path_identity.st_ino;
  bool clean = observed && !launch_error && !timed_out && !interrupted && !killed &&
      !cleanup_error && !adopted && final_leaf && survivors == 0 && no_children && after_valid && identity_valid &&
      after.populated == 0 && !*after.procs && after.cpu >= before.cpu &&
      after.user >= before.user && after.system >= before.system && after.peak >= before.peak;
  FILE *file = fdopen(output, "w");
  if (!file) return 8;
  fprintf(file, "{\"schemaVersion\":1,\"captureClass\":\"experimental-linux-cgroup-command\",\"resourceAdmission\":false,\"identity\":\"%s\",\"clock\":\"clock_gettime(CLOCK_MONOTONIC)\",\"collectorProcess\":%d,\"ownerProcess\":%d,\"cgroupDevice\":\"%ju\",\"cgroupInode\":\"%ju\",\"identityUnchanged\":%s,\"commandBytes\":[", argv[3], getpid(), pid, (uintmax_t)initial_identity.st_dev, (uintmax_t)initial_identity.st_ino, identity_valid ? "true" : "false");
  for (int i = 5; i < argc; i++) { if (i != 5) fputc(',', file); json_text(file, argv[i]); }
  fprintf(file, "],\"cloneStartedNanoseconds\":\"%"PRIu64"\",\"cloneFinishedNanoseconds\":\"%"PRIu64"\",\"launchErrno\":%d,\"originalWait\":", clone_started, clone_finished, launch_error);
  if (observed) fprintf(file, "{\"method\":\"atomic-wait4-original-owner\",\"process\":%d,\"status\":%d,\"exitCode\":%d,\"startedNanoseconds\":\"%"PRIu64"\",\"finishedNanoseconds\":\"%"PRIu64"\",\"userMicroseconds\":%lld,\"systemMicroseconds\":%lld,\"inclusiveMaximumRssKiB\":%ld}", pid, wait_status, WIFEXITED(wait_status) ? WEXITSTATUS(wait_status) : -WTERMSIG(wait_status), wait_started, wait_finished, micros(usage.ru_utime), micros(usage.ru_stime), usage.ru_maxrss);
  else fputs("null", file);
  fprintf(file, ",\"timedOut\":%s,\"interruptedSignal\":%d,\"groupKilled\":%s,\"survivorsAfterOwner\":%d,\"adoptedChildren\":%d,\"noRemainingChildren\":%s,\"cleanupError\":%s,\"cleanObservedTeardown\":%s,\"before\":", timed_out ? "true" : "false", interrupted, killed ? "true" : "false", survivors, adopted, no_children ? "true" : "false", cleanup_error ? "true" : "false", clean ? "true" : "false");
  print_snapshot(file, &before); fputs(",\"after\":", file);
  print_snapshot(file, &after);
  fprintf(file, ",\"afterValid\":%s", after_valid ? "true" : "false");
  fputs(",\"adoptedWaits\":[", file);
  for (int i = 0; i < adopted && i < MAX_ADOPTED; i++) {
    const struct adopted_wait *item = &adopted_waits[i];
    if (i) fputc(',', file);
    fprintf(file, "{\"process\":%d,\"status\":%d,\"startedNanoseconds\":\"%"PRIu64"\",\"finishedNanoseconds\":\"%"PRIu64"\",\"userMicroseconds\":%lld,\"systemMicroseconds\":%lld}", item->process, item->status, item->started, item->finished, micros(item->usage.ru_utime), micros(item->usage.ru_stime));
  }
  fprintf(file, "],\"finalLeaf\":%s,\"commandEncoding\":\"Each original argv byte is represented by its equal-valued Unicode codepoint\"", final_leaf ? "true" : "false");
  fputs(",\"scope\":\"Kernel charges follow cgroup membership. Exclusive membership, migration prevention, resource policies, host/input identity and full resource admission remain external. Memory peak is charged memory, not concurrent RSS. Original wait4 excludes unreaped descendant usage. Adopted waits are never added to that original receipt.\"}\n", file);
  int publish_error = finish_report(file);
  close(group);
  return clean && !publish_error ? 0 : 1;
}
