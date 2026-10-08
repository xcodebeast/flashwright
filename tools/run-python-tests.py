"""Print failure details immediately so a later watchdog cannot erase the diagnosis."""

import argparse
import traceback
import unittest


class ImmediateFailureResult(unittest.TextTestResult):
    def report_failure(self, error):
        self.stream.writeln("\nImmediate failure details:")
        traceback.print_exception(*error, file=self.stream)
        self.stream.flush()

    def addError(self, test, error):
        super().addError(test, error)
        self.report_failure(error)

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.report_failure(error)

    def addSubTest(self, test, subtest, error):
        super().addSubTest(test, subtest, error)
        if error is not None:
            self.report_failure(error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-directory", required=True)
    parser.add_argument("--pattern", default="test_*.py")
    arguments = parser.parse_args()
    suite = unittest.defaultTestLoader.discover(arguments.start_directory, pattern=arguments.pattern)
    result = unittest.TextTestRunner(verbosity=2, resultclass=ImmediateFailureResult).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    main()
