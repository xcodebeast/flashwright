/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import path from 'path';

import { msToString } from '@isomorphic/formatUtils';
import { stripAnsiEscapes } from '@isomorphic/stringUtils';
import { getPackageManagerExecCommand } from '@utils/env';

import { kOutputSymbol, plainTerminalScreen, TerminalReporter } from './base';

import type { AgentReporterOptions } from '../../types/test';
import type { FullResult, Suite, TestCase, TestError, TestResult } from '../../types/testReporter';
import type { CommonReporterOptions, TerminalReporterOptions, TestResultOutput } from './base';

// Flashwright: the reporter that agent mode uses in place of list, line and dot. It prints what an
// agent acts on and nothing else: no line per passing test, no console output from passing tests,
// each failure once, then the counts and how to rerun. It also writes the outcome as JSON.

const kOutputTailLines = 20;
const kErrorLines = 40;

type SummaryOutcome = 'passed' | 'failed' | 'error' | 'no-tests' | 'timedout' | 'interrupted';

export type AgentSummary = {
  version: 1;
  outcome: SummaryOutcome;
  status: FullResult['status'];
  durationMs: number;
  counts: { total: number, passed: number, failed: number, flaky: number, skipped: number, interrupted: number, didNotRun: number };
  failures: {
    title: string;
    project: string;
    location: string;
    status: TestResult['status'];
    attempts: number;
    errors: { message: string, location?: string }[];
    attachments: { name: string, contentType: string, path: string }[];
    rerun: string;
  }[];
  flaky: { title: string, project: string, location: string, errors: { message: string, location?: string }[] }[];
  errors: { message: string, location?: string }[];
  rerun?: string;
};

class AgentReporter extends TerminalReporter {
  private _outputFile: string | undefined;
  private _errors: TestError[] = [];

  constructor(options?: AgentReporterOptions & CommonReporterOptions & TerminalReporterOptions) {
    // Only the last attempt of a failed test: earlier ones usually repeat the same error.
    super({ screen: plainTerminalScreen, ...options, omitFailures: true, lastResult: true });
    this._outputFile = options?.outputFile ? path.resolve(options.configDir ?? process.cwd(), options.outputFile) : undefined;
  }

  override onBegin(suite: Suite) {
    super.onBegin(suite);
    const message = this.generateStartingMessage();
    if (message)
      this.writeLine(message);
  }

  override onStdOut(chunk: string | Buffer, test?: TestCase, result?: TestResult) {
    super.onStdOut(chunk, test, result);
    // Output from a test is printed with its failure; output from outside tests is printed now.
    if (!result && !this.config.quiet)
      this.screen.stdout.write(chunk);
  }

  override onStdErr(chunk: string | Buffer, test?: TestCase, result?: TestResult) {
    super.onStdErr(chunk, test, result);
    if (!result && !this.config.quiet)
      this.screen.stderr.write(chunk);
  }

  override onTestEnd(test: TestCase, result: TestResult) {
    super.onTestEnd(test, result);
    // One line as soon as a test has failed for good, so that a run that is cut short still says
    // what failed. The details come at the end.
    if (test.outcome() === 'unexpected' && !this.willRetry(test))
      this.writeLine(this.screen.colors.red(`  ✘ ${this.formatTestTitle(test)}`));
  }

  override onError(error: TestError): void {
    super.onError(error);
    this._errors.push(error);
    this.writeLine('\n' + this.formatError(error).message);
  }

  override async onEnd(result: FullResult) {
    await super.onEnd(result);
    const summary = this.generateSummary();
    // Flaky tests passed in the end: they are listed in the counts and in the summary file.
    summary.failuresToPrint.filter(test => test.outcome() !== 'flaky').forEach((test, index) => {
      const failure = withoutRules(this.formatFailure(test, index + 1)).trimEnd();
      if (!failure)
        return;
      this.writeLine('');
      this.writeLine(failure);
      if (test.outcome() === 'unexpected')
        this._printOutputTail(test.results[test.results.length - 1]);
    });
    this.writeLine('');
    this.writeLine(withoutRules(this.generateSummaryMessage(summary)));
    for (const [file, duration] of this.getSlowTests())
      this.writeLine(`  Slow test file: ${file} (${msToString(duration)})`);

    const json = this._createSummary(result);
    if (json.rerun)
      this.writeLine(`\n  Rerun the failures: ${json.rerun}`);
    const file = this._summaryFile();
    if (file) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(json, undefined, 2) + '\n');
      this.writeLine(`  Summary: ${path.relative(process.cwd(), file) || file}`);
    }
  }

  printsToStdio() {
    return true;
  }

  private _printOutputTail(result: TestResult | undefined) {
    const output: TestResultOutput[] = (result as any)?.[kOutputSymbol] || [];
    const text = output.map(o => o.chunk.toString()).join('');
    const lines = stripAnsiEscapes(text).split('\n');
    if (lines[lines.length - 1] === '')
      lines.pop();
    if (!lines.length)
      return;
    const tail = lines.slice(-kOutputTailLines);
    const label = lines.length > tail.length ? `last ${tail.length} of ${lines.length} lines` : `${lines.length} line${lines.length === 1 ? '' : 's'}`;
    this.writeLine(this.screen.colors.dim(`    Test output (${label}):`));
    for (const line of tail)
      this.writeLine('    | ' + (line.length > 300 ? line.slice(0, 300) + '...' : line));
  }

  private _summaryFile(): string | undefined {
    if (this._outputFile)
      return this._outputFile;
    const outputDir = this.suite?.suites[0]?.project()?.outputDir ?? this.config.projects[0]?.outputDir;
    return outputDir ? path.join(outputDir, 'summary.json') : undefined;
  }

  private _createSummary(result: FullResult): AgentSummary {
    const summary = this.generateSummary();
    const exec = getPackageManagerExecCommand();
    const relative = (file: string) => path.relative(process.cwd(), file) || file;
    const location = (test: TestCase) => `${relative(test.location.file)}:${test.location.line}:${test.location.column}`;
    const project = (test: TestCase) => test.parent.project()?.name ?? '';
    const title = (test: TestCase) => test.titlePath().slice(3).join(' › ');
    const formatError = (error: TestError) => {
      const lines = stripAnsiEscapes(error.message ?? error.value ?? '').split('\n');
      return {
        message: lines.length > kErrorLines ? [...lines.slice(0, kErrorLines), `... ${lines.length - kErrorLines} more lines`].join('\n') : lines.join('\n'),
        location: error.location ? `${relative(error.location.file)}:${error.location.line}:${error.location.column}` : undefined,
      };
    };

    const failed = [...summary.unexpected];
    const failures = failed.map(test => {
      const last = test.results[test.results.length - 1];
      const projectName = project(test);
      return {
        title: title(test),
        project: projectName,
        location: location(test),
        status: last?.status ?? 'skipped',
        attempts: test.results.length,
        errors: (last?.errors ?? []).map(formatError),
        attachments: (last?.attachments ?? []).filter(a => a.path && !a.name.startsWith('_')).map(a => ({ name: a.name, contentType: a.contentType, path: relative(a.path!) })),
        rerun: `${exec} playwright test ${quoteIfNeeded(`${relative(test.location.file)}:${test.location.line}`)}${projectName ? ` --project=${quoteIfNeeded(projectName)}` : ''}`,
      };
    });

    let outcome: SummaryOutcome;
    if (result.status === 'interrupted')
      outcome = 'interrupted';
    else if (result.status === 'timedout')
      outcome = 'timedout';
    else if (failed.length || (result.status === 'failed' && summary.flaky.length && this.config.failOnFlakyTests))
      outcome = 'failed';
    else if (this._errors.some(error => !/^(Error: )?No tests found/.test(error.message ?? '')) || (result.status === 'failed' && this.totalTestCount))
      outcome = 'error';
    else if (!this.totalTestCount)
      outcome = 'no-tests';
    else
      outcome = 'passed';

    return {
      version: 1,
      outcome,
      status: result.status,
      durationMs: Math.round(result.duration),
      counts: {
        total: this.totalTestCount,
        passed: summary.expected,
        failed: summary.unexpected.length,
        flaky: summary.flaky.length,
        skipped: summary.skipped,
        interrupted: summary.interrupted.length,
        didNotRun: summary.didNotRun,
      },
      failures,
      flaky: summary.flaky.map(test => ({ title: title(test), project: project(test), location: location(test), errors: (test.results.find(r => r.errors.length)?.errors ?? []).map(formatError) })),
      errors: this._errors.map(formatError),
      rerun: failed.length || summary.interrupted.length || summary.didNotRun ? `${exec} playwright test --last-failed` : undefined,
    };
  }
}

// Terminal reporters draw rules of '─' to fill a 100 column line; an agent pays for every one.
function withoutRules(text: string): string {
  return text.replace(/ *─{3,}/g, '').replace(/[ \t]+$/gm, '');
}

function quoteIfNeeded(text: string): string {
  return /[\s"'$`\\]/.test(text) ? JSON.stringify(text) : text;
}

export default AgentReporter;
