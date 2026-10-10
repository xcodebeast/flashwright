#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Widen Rust's macOS pipe -> CLOEXEC window without changing fork or exec. */
static int delayed_pipe(int descriptors[2]) {
    static _Atomic unsigned calls = 0;
    int result = pipe(descriptors);
    if (!result && !strcmp(getprogname(), "flashwright-driver") &&
        getenv("FLASHWRIGHT_TEST_PIPE_WINDOW") &&
        !getenv("FLASHWRIGHT_GUARDIAN_HAS_NODE_PIPE") &&
        atomic_fetch_add(&calls, 1) == 0) {
        const char marker[] = "flashwright:test launch pipe inheritance window\n";
        (void)write(STDERR_FILENO, marker, sizeof(marker) - 1);
        usleep(250000);
    }
    return result;
}

__attribute__((used)) static struct { const void *replacement; const void *original; }
interpose_pipe __attribute__((section("__DATA,__interpose"))) = {
    (const void *)delayed_pipe, (const void *)pipe
};
