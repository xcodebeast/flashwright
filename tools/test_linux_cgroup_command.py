"""Bounded parser controls; native delegation/lifecycle controls use the runner tool."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent

@unittest.skipUnless(sys.platform == 'linux' and shutil.which('cc'), 'Linux C compiler required')
class CgroupParserTests(unittest.TestCase):
    def test_bounded_raw_counter_parser(self):
        (ROOT / 'workbench').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='cgroup-parser-', dir=ROOT / 'workbench') as directory:
            directory = Path(directory)
            source = directory / 'parser.c'
            source.write_text(r'''
#define main collector_main
#include "linux-cgroup-command.c"
#undef main
#include <assert.h>
int main(void) {
  uint64_t value;
  assert(!counter("usage_usec 20\nuser_usec 12\nsystem_usec 8\nfuture_counter 1\ncore_sched.force_idle_usec 0\n", "usage_usec", &value) && value == 20);
  const char *bad[] = {"", "usage_usec -1\n", "usage_usec +1\n", "usage_usec 1", "usage_usec 1\nusage_usec 2\n", "usage_usec 1\nbad 2\nbad 3\n", "usage_usec 18446744073709551616\n", "usage_usec 1\nbad-key 0\n", "usage_usec 1\nbad 1 extra\n", "usage_usec 1\nno_value\n"};
  for (size_t i = 0; i < sizeof(bad)/sizeof(bad[0]); i++) assert(counter(bad[i], "usage_usec", &value));
  assert(!scalar("18446744073709551615\n", &value) && value == UINT64_MAX);
  assert(scalar("1\n2\n", &value));
  assert(scalar("-1\n", &value));
  char many[FIELD_BYTES] = {0}; size_t used = 0;
  for (unsigned i = 0; i < 129; i++) used += snprintf(many + used, sizeof(many) - used, "x%u 0\n", i);
  assert(counter(many, "x0", &value));
  int directory = open(".", O_RDONLY | O_DIRECTORY);
  int fd = open("field", O_WRONLY | O_CREAT | O_EXCL, 0600); assert(fd >= 0);
  char boundary[FIELD_BYTES]; memset(boundary, 'x', sizeof(boundary));
  assert(write(fd, boundary, sizeof(boundary)-1) == sizeof(boundary)-1); close(fd);
  assert(!read_field(directory, "field", boundary));
  fd = open("field", O_WRONLY | O_APPEND); assert(write(fd, "x", 1) == 1); close(fd);
  assert(read_field(directory, "field", boundary));
  assert(boundary[FIELD_BYTES - 1] == 0);
  FILE *encoded = tmpfile(); assert(encoded); json_text(encoded, boundary);
  assert(ftell(encoded) == FIELD_BYTES + 1); fclose(encoded);
  assert(!symlink("field", "link")); assert(read_field(directory, "link", boundary));
  fd = open("field", O_WRONLY | O_TRUNC); assert(write(fd, "a\0b", 3) == 3); close(fd);
  assert(read_field(directory, "field", boundary)); close(directory);
  FILE *readonly = fopen("field", "r"); assert(readonly);
  assert(fputc('x', readonly) == EOF && ferror(readonly));
  assert(finish_report(readonly));
  FILE *full = fopen("/dev/full", "w"); assert(full);
  fputs("unpublishable report", full); assert(finish_report(full));
  return 0;
}
''')
            executable = directory / 'parser'
            subprocess.run(['cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
                            '-I', str(ROOT / 'tools'), str(source), '-o', str(executable)], check=True, timeout=30)
            subprocess.run([str(executable)], cwd=directory, check=True, timeout=5)

if __name__ == '__main__':
    unittest.main()
