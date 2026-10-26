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

import { callSiteFile, callSiteFormatter, captureRawStack, coreDir, filterStackFile, parseStackFrame } from '@utils/stackTrace';

import type { CallSiteFormatter, StackFrame } from '@utils/stackTrace';

export function captureLibraryStackTrace(): { frames: StackFrame[], apiName: string } {
  const format = callSiteFormatter();
  if (format)
    return captureFromCallSites(format);

  const stack = captureRawStack();
  const playwrightCoreDir = coreDir();

  type ParsedFrame = {
    frame: StackFrame;
    frameText: string;
    isPlaywrightLibrary: boolean;
  };
  let parsedFrames = stack.map(line => {
    const frame = parseStackFrame(line);
    if (!frame || !frame.file)
      return null;
    const isPlaywrightLibrary = !!playwrightCoreDir && frame.file.startsWith(playwrightCoreDir);
    const parsed: ParsedFrame = {
      frame,
      frameText: line,
      isPlaywrightLibrary
    };
    return parsed;
  }).filter(Boolean) as ParsedFrame[];

  let apiName = '';

  // Deepest transition between non-client code calling into client
  // code is the api entry.
  for (let i = 0; i < parsedFrames.length - 1; i++) {
    const parsedFrame = parsedFrames[i];
    if (parsedFrame.isPlaywrightLibrary && !parsedFrames[i + 1].isPlaywrightLibrary) {
      apiName = apiName || normalizeAPIName(parsedFrame.frame.function);
      break;
    }
  }

  // This is for the inspector so that it did not include the test runner stack frames.
  parsedFrames = parsedFrames.filter(f => filterStackFile(f.frame.file));

  return {
    frames: parsedFrames.map(p => p.frame),
    apiName
  };
}

// Flashwright: the result of the code above, without formatting and parsing all frames of the stack
// captured for every API call: frames are told apart by the files of their call sites, and only the
// frames returned and the one naming the API call are formatted.
function captureFromCallSites(format: CallSiteFormatter): { frames: StackFrame[], apiName: string } {
  const playwrightCoreDir = coreDir();
  let result = { frames: [] as StackFrame[], apiName: '' };
  const stackTraceLimit = Error.stackTraceLimit;
  const prepareStackTrace = Error.prepareStackTrace;
  Error.stackTraceLimit = 50;
  Error.prepareStackTrace = (error, callSites) => {
    const sites: { callSite: NodeJS.CallSite, file: string, isPlaywrightLibrary: boolean }[] = [];
    for (const callSite of callSites) {
      const file = callSiteFile(error, callSite, format);
      if (file)
        sites.push({ callSite, file, isPlaywrightLibrary: !!playwrightCoreDir && file.startsWith(playwrightCoreDir) });
    }
    const apiSite = sites.find((site, i) => site.isPlaywrightLibrary && i + 1 < sites.length && !sites[i + 1].isPlaywrightLibrary);
    const kept = sites.filter(site => filterStackFile(site.file)).map(site => site.callSite);
    const lines = format(error, apiSite ? [apiSite.callSite, ...kept] : kept).split('\n').slice(1);
    const apiName = apiSite ? normalizeAPIName(parseStackFrame(lines.shift()!)?.function) : '';
    const frames = lines.map(parseStackFrame).filter(frame => !!frame?.file && filterStackFile(frame.file)) as StackFrame[];
    result = { frames, apiName };
    return '';
  };
  try {
    void new Error().stack;
  } finally {
    Error.prepareStackTrace = prepareStackTrace;
    Error.stackTraceLimit = stackTraceLimit;
  }
  return result;
}

function normalizeAPIName(name?: string): string {
  if (!name)
    return '';
  // (\d) is to tolerate bundler renames Locator2 instead of Locator.
  const match = name.match(/(API|JS|CDP|[A-Z])([^\d]+)\d?\.(.*)/);
  if (!match)
    return name;
  return match[1].toLowerCase() + match[2] + '.' + match[3];
}
