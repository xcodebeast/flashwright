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

/* eslint-disable no-restricted-properties */

import child_process from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { stripAnsiEscapes } from '@isomorphic/stringUtils';

import { findFfmpeg, installVoiceHint, isKokoroInstalled, kVoiceRate, resolveVoiceEngine, Voices } from './narratedVoice';

import type { FullConfigInternal } from '../common/config';
import type { Recording, RecordedBox, RecordedPoint } from '../narratedVideoRecorder';
import type { Ffmpeg } from './narratedVoice';
import type { NarratedVideoOptions } from '../../types/test';
import type { TestRun } from './tasks';

// Flashwright: `playwright test --video` and `--demo`. Tests record what they do at their own speed
// (see narratedVideoRecorder.ts); once they have all finished, this makes the video. It walks each
// recording and holds real frames for as long as a viewer needs: while the voice speaks, while the
// cursor moves to what the test clicks. Nothing is drawn on the page itself, so the tests do not
// change. Each test becomes a clip with the same encoding, and the clips join into one video.

const kWidth = 1920;
const kHeight = 1080;
const kFps = 30;
const kMargin = 30;
const kBandHeight = 120;
// With a camera, the page is drawn at twice its size so that slow moves stay smooth.
const kCameraScale = 2;

// Seconds.
const kTitleCard = 2.0;
const kPassedCard = 1.6;
const kFailedCard = 4.5;
const kSummaryCard = 3.0;
const kLeadIn = 0.4;
const kSettle = 0.25;
const kAfterAction = 0.22;
const kAssertion = 0.55;
const kFailedAssertion = 1.6;
const kSpeechLeadIn = 0.1;
const kAfterSpeech = 0.35;
const kLongestWait = 0.8;
const kLastHold = 0.9;
const kCameraMove = 0.7;
const kCameraZoom = 1.55;

const kInputMethods = new Set(['click', 'dblclick', 'tap', 'fill', 'press', 'type', 'check', 'uncheck', 'setChecked', 'selectOption', 'hover', 'keyboardPress', 'keyboardType', 'keyboardInsertText', 'mouseClick', 'goto']);
const kPointerMethods = new Set(['click', 'dblclick', 'tap', 'fill', 'check', 'uncheck', 'setChecked', 'selectOption', 'mouseClick']);

const quote = (text: string) => `\u201c${text}\u201d`;

function describeTarget(selector = ''): { text: string, name?: string } {
  const parts = selector.split(' >> ');
  const last = parts[parts.length - 1];
  const name = last.match(/\[name="((?:[^"\\]|\\.)*)"/)?.[1]
    ?? last.match(/^internal:(?:label|text|has-text)="((?:[^"\\]|\\.)*)"/)?.[1]
    ?? last.match(/^internal:attr=\[[\w-]+="((?:[^"\\]|\\.)*)"/)?.[1]
    ?? last.match(/^internal:testid=\[[\w-]+="((?:[^"\\]|\\.)*)"/)?.[1];
  const context = parts.slice(0, -1).map(part => part.match(/^internal:has-text="((?:[^"\\]|\\.)*)"/)?.[1]).filter(Boolean)[0];
  return { text: (name ? quote(name) : 'the element') + (context ? ` for ${quote(context)}` : ''), name };
}

export function describeAction(step: Recording['steps'][0]): string {
  const params = step.params ?? {};
  const target = describeTarget(params.selector);
  switch (step.method) {
    case 'goto': {
      let where = params.url ?? '';
      try {
        where = new URL(where).pathname;
      } catch {
      }
      return where && where !== '/' ? `Open ${where}` : 'Open the page';
    }
    case 'fill':
    case 'type':
      return params.value ? `Type ${quote(params.value.slice(0, 80))} into ${target.text}` : `Clear ${target.text}`;
    case 'press': return `Press ${params.key} in ${target.text}`;
    case 'keyboardPress': return `Press ${params.key}`;
    case 'keyboardType':
    case 'keyboardInsertText': return `Type ${quote((params.text ?? '').slice(0, 80))}`;
    case 'check': return `Check ${target.text}`;
    case 'uncheck': return `Uncheck ${target.text}`;
    case 'selectOption': return `Choose an option in ${target.text}`;
    case 'hover': return `Hover over ${target.text}`;
    case 'dblclick': return `Double-click ${target.text}`;
    default: return `Click ${target.text}`;
  }
}

export function describeAssertion(step: Pick<Recording['steps'][0], 'title' | 'subtitle' | 'failed'>): string {
  const matcher = step.title.match(/Expect "(.*)"/)?.[1] ?? step.title;
  const negated = /^not /.test(matcher);
  const name = matcher.replace(/^not /, '');
  const subject = step.subtitle ?? '';
  // The last part of a chain names the element; a hasText filter says which one.
  const lastPart = subject.split(/\)\.(?=get|locator|first|last|nth|filter)/).filter(part => !/^(filter|first|last|nth)/.test(part)).pop() ?? '';
  // A selector means nothing to whoever watches the video.
  const named = lastPart.match(/name: '((?:[^'\\]|\\.)*)'/)?.[1] ?? lastPart.match(/^get\w+\('((?:[^'\\]|\\.)*)'/)?.[1];
  const context = subject.match(/hasText: '((?:[^'\\]|\\.)*)'/)?.[1];
  const shown = named ? quote(named) + (context ? ` for ${quote(context)}` : '') : 'The element';
  const not = negated ? 'not ' : '';
  if (step.failed) {
    const states: Record<string, string> = { toBeVisible: 'visible', toBeHidden: 'hidden', toBeChecked: 'checked', toBeEnabled: 'enabled', toBeDisabled: 'disabled' };
    return states[name] ? `Expected ${shown} ${not ? 'not ' : ''}to be ${states[name]}` : `Expected ${shown} ${name.replace(/^to/, 'to ').toLowerCase()}`;
  }
  const passed: Record<string, string> = {
    toBeVisible: `${shown} is ${not}visible`,
    toBeHidden: `${shown} is ${not}hidden`,
    toBeChecked: `${shown} is ${not}checked`,
    toBeEnabled: `${shown} is ${not}enabled`,
    toBeDisabled: `${shown} is ${not}disabled`,
    toHaveURL: `The address is ${not}as expected`,
    toHaveTitle: `The title is ${not}as expected`,
    toHaveValue: `${shown} has ${negated ? 'another' : 'the expected'} value`,
    toHaveText: `${shown} has ${negated ? 'other' : 'the expected'} text`,
    toContainText: `${shown} has ${negated ? 'other' : 'the expected'} text`,
    toHaveCount: `${shown} appears ${negated ? 'another' : 'the expected'} number of times`,
    toHaveScreenshot: 'The page looks as expected',
  };
  return passed[name] ?? `${shown}: ${matcher}`;
}

// Long narration is shown a sentence or two at a time, each for its share of the voice.
function captionParts(text: string): string[] {
  const kLongestCaption = 100;
  if (text.length <= kLongestCaption)
    return [text];
  const parts: string[] = [];
  for (const sentence of text.match(/[^.!?]+[.!?]*\s*/g) ?? [text]) {
    const last = parts[parts.length - 1];
    if (last !== undefined && last.length + sentence.length <= kLongestCaption)
      parts[parts.length - 1] = last + sentence;
    else
      parts.push(sentence);
  }
  return parts.map(part => part.trim()).filter(Boolean);
}

type CaptionStyle = 'narration' | 'action' | 'passed' | 'failed';
type Caption = { style: CaptionStyle, text: string };
type Move = { t0: number, t1: number, from: number, to: number };
type Cue = { start: number, end: number, text: string };
type Chapter = { start: number, title: string };

type Plan = {
  recording: Recording;
  dir: string;
  passed: boolean;
  layout: { pageWidth: number, pageHeight: number, pageX: number, pageY: number, bandHeight: number };
  shots: { file: string, duration: number }[];
  captions: { caption: Caption | null, duration: number }[];
  cursor: { x: Move[], y: Move[], startX: number, startY: number };
  ripples: { t: number, x: number, y: number }[];
  camera: { t: number, zoom: number, left: number, top: number }[];
  audio: { text: string, at: number }[];
  cues: Cue[];
  chapters: Chapter[];
  titleCard: number;
  endCard: number;
  endCardStart: number;
  total: number;
};

function spokenSentences(recording: Recording, options: NarratedVideoOptions) {
  if (recording.narrations.length)
    return recording.narrations.map(n => n.text);
  // A step title is read out only by tests that wrote no narration of their own.
  if (options.mode === 'demo')
    return [];
  return recording.steps.filter(step => step.category === 'test.step').map(step => step.title);
}

function makeLayout(recording: Recording, options: NarratedVideoOptions): Plan['layout'] {
  const bandHeight = options.captions ? kBandHeight : 0;
  const boxWidth = kWidth - 2 * kMargin;
  const boxHeight = kHeight - bandHeight - (bandHeight ? kMargin : 2 * kMargin);
  const { width, height } = recording.frames[0];
  const scale = Math.min(boxWidth / width, boxHeight / height);
  const pageWidth = Math.floor(width * scale / 2) * 2;
  const pageHeight = Math.floor(height * scale / 2) * 2;
  return { pageWidth, pageHeight, pageX: Math.round((kWidth - pageWidth) / 2), pageY: kMargin + Math.round((boxHeight - pageHeight) / 2), bandHeight };
}

function planClip(dir: string, recording: Recording, options: NarratedVideoOptions, voices: Voices, isOnlyTest: boolean): Plan {
  const demo = options.mode === 'demo';
  const showEvents = !!options.captions && !demo;
  const passed = recording.status === recording.expectedStatus;
  const layout = makeLayout(recording, options);
  const firstFrame = recording.frames[0].time;

  const inputFor = (start: number, end: number | undefined) => {
    const inputs = recording.inputs.filter(input => input.time >= start - 2 && input.time <= (end ?? Infinity) + 2);
    return inputs.find(input => input.point) ?? inputs.find(input => input.box) ?? inputs[0];
  };

  type Event = { order: number, kind: 'action' | 'assertion' | 'speech', time: number, end: number, text: string, file?: string, failed?: boolean, method?: string, point?: RecordedPoint, box?: RecordedBox, page?: number };
  const events: Event[] = [];
  let seenAction = false;
  for (const step of recording.steps.filter(step => step.start >= firstFrame - 1000)) {
    if (step.category === 'pw:api' && step.method && kInputMethods.has(step.method)) {
      // The first navigation only leads to the first thing on screen.
      if (step.method === 'goto' && !seenAction)
        continue;
      seenAction = true;
      const input = inputFor(step.start, step.end);
      events.push({ order: step.order, kind: 'action', time: step.start, end: step.end ?? step.start, text: describeAction(step), method: step.method, point: input?.point, box: input?.box, page: input?.page });
    } else if (step.category === 'expect' && !demo) {
      events.push({ order: step.order, kind: 'assertion', time: step.start, end: step.end ?? step.start, text: describeAssertion(step), failed: step.failed });
    }
  }
  if (recording.narrations.length) {
    for (const n of recording.narrations)
      events.push({ order: n.order, kind: 'speech', time: n.time, end: n.time, text: n.text, page: n.page, file: n.file });
  } else if (!demo) {
    for (const step of recording.steps.filter(step => step.category === 'test.step'))
      events.push({ order: step.order, kind: 'speech', time: step.start, end: step.start, text: step.title });
  }
  events.sort((a, b) => a.order - b.order);

  // ---- Walking the recording
  const framesByPage = new Map<number, Recording['frames']>();
  for (const frame of recording.frames)
    framesByPage.set(frame.page, [...(framesByPage.get(frame.page) ?? []), frame]);
  const position = new Map<number, number>();
  let activePage = recording.frames[0].page;
  const currentFrames = () => framesByPage.get(activePage)!;
  const currentFrame = () => currentFrames()[position.get(activePage) ?? 0];

  const shots: Plan['shots'] = [];
  const captions: Plan['captions'] = [];
  const audio: Plan['audio'] = [];
  const cues: Cue[] = [];
  const chapters: Chapter[] = [];
  const ripples: Plan['ripples'] = [];
  const cursorX: Move[] = [];
  const cursorY: Move[] = [];
  const camera: Plan['camera'] = [{ t: 0, zoom: 1, left: 0, top: 0 }];
  let outTime = 0;
  let caption: Caption | null = null;
  let captionStart = 0;

  const setCaption = (next: Caption | null) => {
    if (caption === next || (caption && next && caption.style === next.style && caption.text === next.text))
      return;
    if (outTime > captionStart)
      captions.push({ caption, duration: outTime - captionStart });
    caption = next;
    captionStart = outTime;
  };
  let heldPicture: string | undefined;
  const hold = (seconds: number) => {
    if (seconds <= 0)
      return;
    shots.push({ file: heldPicture ?? currentFrame().file, duration: seconds });
    outTime += seconds;
  };
  // Plays what the active page painted up to the given time, shortening long waits for it.
  const playTo = (time: number) => {
    const frames = currentFrames();
    let index = position.get(activePage) ?? 0;
    while (index + 1 < frames.length && frames[index + 1].time <= time) {
      hold(Math.min((frames[index + 1].time - frames[index].time) / 1000, kLongestWait));
      position.set(activePage, ++index);
    }
  };
  const switchTo = (page: number | undefined, time: number) => {
    if (page === undefined || page === activePage || !framesByPage.has(page))
      return;
    activePage = page;
    const frames = framesByPage.get(page)!;
    let index = 0;
    while (index + 1 < frames.length && frames[index + 1].time <= time)
      index++;
    position.set(page, index);
  };
  // From a point on a page to the same point in the page's place in the video.
  const toCanvas = (point: RecordedPoint) => {
    const { width, height } = currentFrame();
    const scale = Math.min(layout.pageWidth / width, layout.pageHeight / height);
    return { x: (layout.pageWidth - width * scale) / 2 + point.x * scale, y: (layout.pageHeight - height * scale) / 2 + point.y * scale };
  };
  const cameraOut = () => cameraTo(1, layout.pageWidth / 2, layout.pageHeight / 2);
  const cameraTo = (zoom: number, x: number, y: number) => {
    if (!options.zoom)
      return;
    const shownWidth = layout.pageWidth / zoom;
    const shownHeight = layout.pageHeight / zoom;
    const left = Math.max(0, Math.min(layout.pageWidth - shownWidth, x - shownWidth / 2)) / layout.pageWidth;
    const top = Math.max(0, Math.min(layout.pageHeight - shownHeight, y - shownHeight / 2)) / layout.pageHeight;
    const last = camera[camera.length - 1];
    if (last.zoom === zoom && Math.abs(last.left - left) < 0.001 && Math.abs(last.top - top) < 0.001)
      return;
    // A move starts after the one before it has finished.
    camera.push({ t: Math.max(outTime, last.t + kCameraMove), zoom, left, top });
  };

  // Open on the page the test starts from, not on the white screens that lead to it.
  if (events.length) {
    const frames = currentFrames();
    let index = 0;
    while (index + 1 < frames.length && frames[index + 1].time <= events[0].time)
      index++;
    position.set(activePage, index);
  }
  const titleCard = demo ? 0 : kTitleCard;
  hold(titleCard || kLeadIn);

  let cursor = { x: layout.pageWidth / 2, y: layout.pageHeight * 0.8 };
  const startCursor = cursor;
  const stepsLeft = recording.steps.filter(step => step.category === 'test.step');
  for (const [i, event] of events.entries()) {
    while (stepsLeft.length && stepsLeft[0].order <= event.order)
      chapters.push({ start: outTime, title: stepsLeft.shift()!.title });
    const nextAction = events.slice(i + 1).find(e => e.kind === 'action');
    const limit = nextAction ? nextAction.time - 1 : Infinity;
    if (event.kind === 'speech') {
      // The state a sentence talks about can be painted just after it was said in the test.
      switchTo(event.page, event.time);
      if (event.file) {
        const frames = currentFrames();
        const index = frames.findIndex(frame => frame.file === event.file);
        // A sentence's picture stands in for what was played before it.
        playTo(frames[index].time);
        position.set(activePage, index);
      } else {
        playTo(Math.min(event.time + 150, limit));
      }
      heldPicture = event.file;
      const clip = voices.clip(event.text);
      cameraOut();
      const parts = options.captions ? captionParts(event.text) : [event.text];
      const words = event.text.split(/\s+/).length;
      const spoken = clip ? clip.duration : options.captions ? Math.max(1.2, words * 0.32) : 0.8;
      if (clip)
        audio.push({ text: event.text, at: outTime + kSpeechLeadIn });
      const length = parts.reduce((sum, part) => sum + part.length, 0);
      hold(kSpeechLeadIn);
      for (const [index, part] of parts.entries()) {
        const duration = spoken * part.length / length;
        if (options.captions)
          setCaption({ style: 'narration', text: part });
        cues.push({ start: outTime, end: outTime + duration, text: part });
        hold(duration);
        if (index === parts.length - 1)
          hold(kAfterSpeech);
      }
      heldPicture = undefined;
      continue;
    }
    if (event.kind === 'assertion') {
      playTo(Math.min(event.end + 60, limit));
      if (!showEvents) {
        setCaption(null);
        continue;
      }
      if (events[i + 1]?.kind !== 'assertion')
        cameraOut();
      setCaption({ style: event.failed ? 'failed' : 'passed', text: `${event.failed ? '\u2717' : '\u2713'} ${event.text}` });
      hold(event.failed ? kFailedAssertion : kAssertion);
      continue;
    }
    // An input action: show the result of the last one, move the cursor, then do it.
    playTo(event.time);
    switchTo(event.page, event.time);
    hold(kSettle);
    setCaption(showEvents ? { style: 'action', text: event.text } : null);
    const target = event.point ?? (event.box ? { x: event.box.x + event.box.width / 2, y: event.box.y + event.box.height / 2 } : undefined);
    const point = target ? toCanvas(target) : undefined;
    if (point)
      cameraTo(kCameraZoom, point.x, point.y);
    const distance = point ? Math.hypot(point.x - cursor.x, point.y - cursor.y) : 0;
    if (point && distance > 1) {
      const duration = Math.min(0.85, 0.4 + distance / 1800);
      cursorX.push({ t0: outTime, t1: outTime + duration, from: cursor.x, to: point.x });
      cursorY.push({ t0: outTime, t1: outTime + duration, from: cursor.y, to: point.y });
      hold(duration);
      cursor = point;
    } else {
      hold(0.3);
    }
    if (point && event.method && kPointerMethods.has(event.method))
      ripples.push({ t: outTime, x: point.x, y: point.y });
    hold(kAfterAction);
  }
  playTo(Infinity);
  while (stepsLeft.length)
    chapters.push({ start: outTime, title: stepsLeft.shift()!.title });
  cameraOut();
  hold(kLastHold + (options.zoom ? kCameraMove : 0));
  setCaption(null);

  const endCard = demo ? 0 : passed ? kPassedCard : kFailedCard;
  const endCardStart = outTime;
  if (endCard) {
    // A run of many tests says its result once, at the end, unless one of them failed.
    const line = passed ? (isOnlyTest ? 'The test passed.' : undefined) : 'The test failed.';
    if (line && voices.clip(line))
      audio.push({ text: line, at: endCardStart + 0.2 });
    hold(Math.max(endCard, line && voices.clip(line) ? voices.clip(line)!.duration + 0.5 : 0));
  }
  if (outTime > captionStart)
    captions.push({ caption, duration: outTime - captionStart });

  return {
    recording, dir, passed, layout, shots, captions, audio, cues, chapters, ripples, camera,
    cursor: { x: cursorX, y: cursorY, startX: startCursor.x, startY: startCursor.y },
    titleCard, endCard: outTime - endCardStart, endCardStart,
    total: outTime,
  };
}

// ---- ffmpeg expressions. Flat sums: ffmpeg limits how deeply an expression can nest.

function window(variable: string, from: number, to: number, value: string) {
  return `(gte(${variable},${from.toFixed(3)})*lt(${variable},${to.toFixed(3)}))*(${value})`;
}

function movesExpression(variable: string, start: number, moves: Move[], digits: number): string {
  const terms: string[] = [];
  let at = -1;
  let current = start;
  for (const move of moves) {
    if (move.t0 > at)
      terms.push(window(variable, at, move.t0, current.toFixed(digits)));
    const eased = `st(0,(${variable}-${move.t0.toFixed(3)})/${(move.t1 - move.t0).toFixed(3)});ld(0)*ld(0)*(3-2*ld(0))`;
    terms.push(window(variable, move.t0, move.t1, `${move.from.toFixed(digits)}+(${(move.to - move.from).toFixed(digits)})*(${eased})`));
    at = move.t1;
    current = move.to;
  }
  terms.push(`gte(${variable},${at.toFixed(3)})*(${current.toFixed(digits)})`);
  return terms.join('+');
}

function cameraExpression(camera: Plan['camera'], pick: (entry: Plan['camera'][0]) => number): string {
  const moves: Move[] = [];
  for (let i = 1; i < camera.length; i++)
    moves.push({ t0: camera[i].t, t1: camera[i].t + kCameraMove, from: pick(camera[i - 1]), to: pick(camera[i]) });
  return movesExpression('it', pick(camera[0]), moves, 4);
}

const kRipples = [{ radius: 12, alpha: 0.75 }, { radius: 20, alpha: 0.6 }, { radius: 28, alpha: 0.4 }, { radius: 36, alpha: 0.22 }];

function rippleExpression(ripples: Plan['ripples'], axis: 'x' | 'y', index: number, scale: number) {
  const size = 84 * scale;
  const terms = ripples.map(ripple => {
    const t0 = ripple.t + index * 0.05;
    return window('t', t0, t0 + 0.05, (ripple[axis] * scale - size / 2 + 2000).toFixed(1));
  });
  return ['-2000', ...terms].join('+');
}

// ---- Stills, drawn by a browser for the fonts and the wrapping

const kFont = `'Inter','Noto Sans','Liberation Sans',system-ui,sans-serif`;
const kBackground = 'radial-gradient(1200px 700px at 20% 0%, #1e293b 0%, #0b1120 60%, #060a14 100%)';
const escapeHtml = (text: string) => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

type StillPage = { setViewportSize(size: { width: number, height: number }): Promise<void>, setContent(html: string): Promise<void>, screenshot(options: { path: string, omitBackground: boolean }): Promise<unknown> };

class Stills {
  private _page: StillPage;
  private _dir: string;
  private _count = 0;
  private _cache = new Map<string, string>();

  constructor(page: StillPage, dir: string) {
    this._page = page;
    this._dir = dir;
  }

  async draw(html: string, size: { width: number, height: number } = { width: kWidth, height: kHeight }): Promise<string> {
    const key = `${size.width}x${size.height}:${html}`;
    const known = this._cache.get(key);
    if (known)
      return known;
    const file = path.join(this._dir, `still-${this._count++}.png`);
    await this._page.setViewportSize(size);
    await this._page.setContent(`<!doctype html><body style="margin:0;background:transparent">${html}</body>`);
    await this._page.screenshot({ path: file, omitBackground: true });
    this._cache.set(key, file);
    return file;
  }

  frame(layout: Plan['layout']) {
    const { pageX, pageY, pageWidth, pageHeight } = layout;
    return this.draw(`<svg xmlns="http://www.w3.org/2000/svg" width="${kWidth}" height="${kHeight}" style="display:block">
      <defs>
        <radialGradient id="g" cx="20%" cy="0%" r="90%"><stop offset="0" stop-color="#1e293b"/><stop offset=".6" stop-color="#0b1120"/><stop offset="1" stop-color="#060a14"/></radialGradient>
        <mask id="m"><rect width="${kWidth}" height="${kHeight}" fill="#fff"/><rect x="${pageX}" y="${pageY}" width="${pageWidth}" height="${pageHeight}" rx="14" fill="#000"/></mask>
      </defs>
      <rect width="${kWidth}" height="${kHeight}" fill="url(#g)" mask="url(#m)"/>
      <rect x="${pageX - 0.5}" y="${pageY - 0.5}" width="${pageWidth + 1}" height="${pageHeight + 1}" rx="14" fill="none" stroke="#ffffff22"/>
    </svg>`);
  }

  cursor(scale: number) {
    const size = 32 * scale;
    return this.draw(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 28 28" style="display:block"><path d="M5 3l15.5 11.5-6.8 1.1 4 8-3.4 1.7-4-8.1L5.6 22z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`, { width: size, height: size });
  }

  ripple(index: number, scale: number) {
    const { radius, alpha } = kRipples[index];
    const size = 84 * scale;
    return this.draw(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 84 84" style="display:block"><circle cx="42" cy="42" r="${radius}" fill="#38bdf8" fill-opacity="${alpha * 0.35}" stroke="#38bdf8" stroke-opacity="${alpha}" stroke-width="3"/></svg>`, { width: size, height: size });
  }

  caption(caption: Caption | null) {
    const styles: Record<CaptionStyle, string> = {
      narration: 'color:#f8fafc;font-size:38px;font-weight:600',
      action: 'color:#cbd5e1;font-size:32px;font-weight:500',
      passed: 'color:#4ade80;font-size:32px;font-weight:600',
      failed: 'color:#f87171;font-size:32px;font-weight:600',
    };
    return this.draw(`<div style="width:${kWidth}px;height:${kBandHeight}px;display:flex;align-items:center;justify-content:center;padding:0 120px;box-sizing:border-box;text-align:center;line-height:1.3;font-family:${kFont};${caption ? styles[caption.style] : ''}">${caption ? escapeHtml(caption.text) : ''}</div>`, { width: kWidth, height: kBandHeight });
  }

  private _card(body: string) {
    return `<div style="width:${kWidth}px;height:${kHeight}px;background:${kBackground};display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:${kFont};color:#f8fafc;text-align:center;padding:0 160px;box-sizing:border-box">${body}</div>`;
  }

  title(recording: Recording) {
    const location = recording.titlePath.slice(recording.projectName ? 2 : 1, -1).join(' \u203a ');
    return this.draw(this._card(`
      <div style="font-size:30px;color:#94a3b8;margin-bottom:22px">${escapeHtml(location)}</div>
      <div style="font-size:64px;font-weight:700;line-height:1.15">${escapeHtml(recording.title)}</div>
      ${recording.projectName ? `<div style="font-size:26px;color:#64748b;margin-top:24px">${escapeHtml(recording.projectName)}</div>` : ''}`));
  }

  private _badge(passed: boolean) {
    return `<div style="width:112px;height:112px;border-radius:50%;background:${passed ? '#16a34a' : '#dc2626'};display:flex;align-items:center;justify-content:center;font-size:68px;font-weight:700;margin-bottom:30px">${passed ? '\u2713' : '\u2717'}</div>`;
  }

  end(plan: Plan) {
    const { recording, passed } = plan;
    const assertions = recording.steps.filter(step => step.category === 'expect' && !step.failed).length;
    const errorLines = stripAnsiEscapes(recording.error ?? '').split('\n').filter(line => line.trim() && !line.includes('Call log')).slice(0, 6);
    return this.draw(this._card(`
      ${this._badge(passed)}
      <div style="font-size:60px;font-weight:700;margin-bottom:18px">Test ${passed ? 'passed' : 'failed'}</div>
      <div style="font-size:30px;color:#cbd5e1;margin-bottom:26px">${escapeHtml(recording.title)}</div>
      ${passed
        ? `<div style="font-size:26px;color:#94a3b8">${assertions} assertion${assertions === 1 ? '' : 's'} verified. The real run took ${(recording.duration / 1000).toFixed(2)} s; this video is slowed down to follow it.</div>`
        : `<pre style="font:22px/1.45 'Liberation Mono',ui-monospace,monospace;color:#fca5a5;background:#00000055;padding:22px 28px;border-radius:12px;text-align:left;white-space:pre-wrap;max-width:1500px;margin:0">${escapeHtml(errorLines.join('\n'))}</pre>`}`));
  }

  summary(passed: number, failed: number) {
    const parts = [`${passed} passed`, ...(failed ? [`${failed} failed`] : [])];
    return this.draw(this._card(`${this._badge(!failed)}<div style="font-size:60px;font-weight:700">${parts.join(', ')}</div>`));
  }

  empty() {
    return this.draw('');
  }
}

// ---- Encoding

const kEncoding = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(kFps), '-c:a', 'aac', '-b:a', '128k', '-ar', String(kVoiceRate), '-ac', '1', '-movflags', '+faststart'];

function runFfmpeg(ffmpeg: Ffmpeg, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.slice(-800)}`)));
  });
}

function writeList(file: string, items: { file: string, duration: number }[]) {
  const lines: string[] = [];
  for (const item of items)
    lines.push(`file '${item.file.replace(/'/g, `'\\''`)}'`, `duration ${item.duration.toFixed(5)}`);
  lines.push(`file '${items[items.length - 1].file.replace(/'/g, `'\\''`)}'`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function timestamp(seconds: number, separator: string) {
  const ms = Math.round(seconds * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

function toSrt(cues: Cue[]) {
  return cues.map((cue, i) => `${i + 1}\n${timestamp(cue.start, ',')} --> ${timestamp(cue.end, ',')}\n${cue.text}\n`).join('\n');
}

function toVtt(cues: Cue[]) {
  return 'WEBVTT\n\n' + cues.map(cue => `${timestamp(cue.start, '.')} --> ${timestamp(cue.end, '.')}\n${cue.text}\n`).join('\n');
}

function toChaptersMetadata(chapters: Chapter[], total: number) {
  const escape = (text: string) => text.replace(/[=;#\\\n]/g, c => `\\${c}`);
  const lines = [';FFMETADATA1'];
  chapters.forEach((chapter, i) => {
    const end = chapters[i + 1]?.start ?? total;
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(chapter.start * 1000)}`, `END=${Math.round(end * 1000)}`, `title=${escape(chapter.title)}`);
  });
  return lines.join('\n') + '\n';
}

function writeAudio(file: string, clips: { samples: Float32Array, at: number }[], total: number) {
  const samples = new Float32Array(Math.ceil((total + 0.5) * kVoiceRate));
  for (const clip of clips) {
    const offset = Math.round(clip.at * kVoiceRate);
    samples.set(clip.samples.subarray(0, Math.max(0, samples.length - offset)), offset);
  }
  fs.writeFileSync(file, Buffer.from(samples.buffer));
}

async function renderClip(plan: Plan, options: NarratedVideoOptions, ffmpeg: Ffmpeg, voices: Voices, stills: Stills, work: string, output: string): Promise<() => Promise<void>> {
  const { layout, camera, cursor, ripples } = plan;
  const zoom = !!options.zoom && camera.length > 1;
  const scale = zoom ? kCameraScale : 1;
  const canvasWidth = layout.pageWidth * scale;
  const canvasHeight = layout.pageHeight * scale;

  const inputs: string[][] = [];
  const input = (...args: string[]) => inputs.push(args) - 1;
  const still = (file: string) => input('-loop', '1', '-i', file);

  const pageInput = input('-reinit_filter', '0', '-f', 'concat', '-safe', '0', '-i', writeList(path.join(work, 'page.txt'), plan.shots.map(shot => ({ file: path.join(plan.dir, shot.file), duration: shot.duration }))));
  const frameInput = still(await stills.frame(layout));
  const cursorInput = still(await stills.cursor(scale));
  const rippleInputs: number[] = [];
  if (ripples.length) {
    for (let i = 0; i < kRipples.length; i++)
      rippleInputs.push(still(await stills.ripple(i, scale)));
  }

  // The page, with the cursor drawn on it, and the camera filming the result.
  let graph = `[${pageInput}:v]fps=${kFps},scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=decrease:eval=frame:flags=lanczos,pad=${canvasWidth}:${canvasHeight}:(ow-iw)/2:(oh-ih)/2:color=white:eval=frame,format=rgba[page];\n`;
  let label = 'page';
  rippleInputs.forEach((rippleInput, i) => {
    graph += `[${label}][${rippleInput}:v]overlay=x='${rippleExpression(ripples, 'x', i, scale)}':y='${rippleExpression(ripples, 'y', i, scale)}':eval=frame[ripple${i}];\n`;
    label = `ripple${i}`;
  });
  const scaleMoves = (moves: Move[], offset: number) => moves.map(move => ({ ...move, from: move.from * scale - offset, to: move.to * scale - offset }));
  // The tip of the arrow is near the image's corner.
  const tipX = 5 / 28 * 32 * scale;
  const tipY = 3 / 28 * 32 * scale;
  graph += `[${label}][${cursorInput}:v]overlay=x='${movesExpression('t', cursor.startX * scale - tipX, scaleMoves(cursor.x, tipX), 1)}':y='${movesExpression('t', cursor.startY * scale - tipY, scaleMoves(cursor.y, tipY), 1)}':eval=frame[drawn];\n`;
  if (zoom)
    graph += `[drawn]zoompan=z='${cameraExpression(camera, c => c.zoom)}':x='(${cameraExpression(camera, c => c.left)})*iw':y='(${cameraExpression(camera, c => c.top)})*ih':d=1:s=${layout.pageWidth}x${layout.pageHeight}:fps=${kFps}[filmed];\n`;
  else
    graph += `[drawn]null[filmed];\n`;
  graph += `[filmed]pad=${kWidth}:${kHeight}:${layout.pageX}:${layout.pageY}:color=black,format=yuv420p[base];\n`;
  graph += `[base][${frameInput}:v]overlay=0:0[framed];\n`;
  label = 'framed';
  if (layout.bandHeight) {
    const items: { file: string, duration: number }[] = [];
    for (const span of plan.captions)
      items.push({ file: await stills.caption(span.caption), duration: span.duration });
    const captionInput = input('-reinit_filter', '0', '-f', 'concat', '-safe', '0', '-i', writeList(path.join(work, 'captions.txt'), items));
    graph += `[${captionInput}:v]fps=${kFps},format=rgba[band];\n[framed][band]overlay=0:${kHeight - layout.bandHeight}[captioned];\n`;
    label = 'captioned';
  }
  if (plan.titleCard || plan.endCard) {
    const items: { file: string, duration: number }[] = [];
    if (plan.titleCard)
      items.push({ file: await stills.title(plan.recording), duration: plan.titleCard });
    items.push({ file: await stills.empty(), duration: plan.endCardStart - plan.titleCard });
    if (plan.endCard)
      items.push({ file: await stills.end(plan), duration: plan.endCard });
    const cardInput = input('-reinit_filter', '0', '-f', 'concat', '-safe', '0', '-i', writeList(path.join(work, 'cards.txt'), items));
    graph += `[${cardInput}:v]fps=${kFps},format=rgba[cards];\n[${label}][cards]overlay=0:0[out]`;
  } else {
    graph += `[${label}]null[out]`;
  }
  const graphFile = path.join(work, 'graph.txt');
  fs.writeFileSync(graphFile, graph);

  const audioFile = path.join(work, 'voice.f32');
  writeAudio(audioFile, plan.audio.map(entry => ({ samples: voices.clip(entry.text)!.samples, at: entry.at })), plan.total);
  const audioInput = input('-f', 'f32le', '-ar', String(kVoiceRate), '-ac', '1', '-i', audioFile);

  const args = [...inputs.flat(), ffmpeg.filterScriptFlag, graphFile, '-map', '[out]', '-map', `${audioInput}:a`];
  if (plan.cues.length) {
    const srt = path.join(work, 'captions.srt');
    fs.writeFileSync(srt, toSrt(plan.cues));
    args.splice(inputs.flat().length, 0, '-f', 'srt', '-i', srt);
    args.push('-map', `${inputs.length}:s`, '-c:s', 'mov_text');
  }
  args.push('-t', plan.total.toFixed(3), ...kEncoding, output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  return () => runFfmpeg(ffmpeg, args);
}

async function joinClips(ffmpeg: Ffmpeg, work: string, clips: { file: string, duration: number }[], cues: Cue[], chapters: Chapter[], total: number, output: string) {
  const list = path.join(work, 'clips.txt');
  fs.writeFileSync(list, clips.map(clip => `file '${clip.file.replace(/'/g, `'\\''`)}'`).join('\n') + '\n');
  const args = ['-f', 'concat', '-safe', '0', '-i', list];
  const maps = ['-map', '0:v', '-map', '0:a'];
  let next = 1;
  if (cues.length) {
    const srt = path.join(work, 'all.srt');
    fs.writeFileSync(srt, toSrt(cues));
    args.push('-f', 'srt', '-i', srt);
    maps.push('-map', `${next++}:s`);
  }
  if (chapters.length) {
    const metadata = path.join(work, 'chapters.txt');
    fs.writeFileSync(metadata, toChaptersMetadata(chapters, total));
    args.push('-f', 'ffmetadata', '-i', metadata);
    maps.push('-map_metadata', String(next), '-map_chapters', String(next));
    next++;
  }
  await runFfmpeg(ffmpeg, [...args, ...maps, '-c', 'copy', ...(cues.length ? ['-c:s', 'mov_text'] : []), '-movflags', '+faststart', output]);
}

async function launchBrowserForStills() {
  const playwright = require('playwright-core') as typeof import('playwright-core');
  let failure: unknown;
  for (const type of [playwright.chromium, playwright.firefox, playwright.webkit]) {
    try {
      return await type.launch();
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

async function inParallel(tasks: (() => Promise<void>)[]) {
  // A clip takes about half the cores while it encodes.
  const limit = Math.max(1, Math.floor(os.cpus().length / 3));
  const results: Promise<void>[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length)
      await tasks[next++]();
  };
  for (let i = 0; i < limit; i++)
    results.push(worker());
  await Promise.all(results);
}

function formatDuration(seconds: number) {
  const whole = Math.round(seconds);
  return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

export function checkNarratedVideoCanBeMade(config: FullConfigInternal) {
  const options = config.config.narratedVideo;
  if (options.mode === 'off')
    return;
  const { problem } = findFfmpeg();
  if (problem)
    throw new Error(`--video needs ffmpeg. ${problem}`);
  if (options.voice === 'kokoro' && !isKokoroInstalled())
    throw new Error(`The Kokoro voice is not installed: run "${installVoiceHint()}", or use another voice.`);
}

export async function renderNarratedVideo(testRun: TestRun) {
  const options = testRun.config.config.narratedVideo;
  if (options.mode === 'off' || !testRun.rootSuite)
    return;
  const project = testRun.filteredProjects[0];
  const recordingsRoot = path.join(project.project.outputDir, '.video-recordings');
  const work = path.join(project.project.outputDir, '.video-work');
  const write = (text: string) => process.stdout.write(text + '\n');
  try {
    await renderRun(testRun, options, path.join(project.project.outputDir, 'video.mp4'), work, write);
  } catch (error) {
    write(`\n  Could not make the video: ${error?.message ?? error}`);
  } finally {
    for (const dir of process.env.FLASHWRIGHT_KEEP_VIDEO_WORK ? [] : [...new Set([...testRun.filteredProjects.map(p => path.join(p.project.outputDir, '.video-recordings')), recordingsRoot, work])])
      fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function renderRun(testRun: TestRun, options: NarratedVideoOptions, output: string, work: string, write: (text: string) => void) {
  const demo = options.mode === 'demo';
  const { ffmpeg } = findFfmpeg();
  if (!ffmpeg)
    return;
  fs.mkdirSync(work, { recursive: true });

  // In the order the tests are written, whatever order the workers finished them in.
  const recordings: { dir: string, recording: Recording, id: string }[] = [];
  const leftOut: string[] = [];
  for (const test of testRun.rootSuite!.allTests()) {
    const dir = testRun.narratedVideoRecordings.get(test.id);
    if (!dir || !fs.existsSync(path.join(dir, 'recording.json')))
      continue;
    const recording = JSON.parse(fs.readFileSync(path.join(dir, 'recording.json'), 'utf8')) as Recording;
    if (recording.status === 'skipped')
      continue;
    if (demo && recording.status !== recording.expectedStatus) {
      leftOut.push(recording.title);
      continue;
    }
    recordings.push({ dir, recording, id: test.id });
  }
  if (leftOut.length)
    write(`\n  Left out of the demo because ${leftOut.length === 1 ? 'it' : 'they'} failed: ${leftOut.join(', ')}`);
  if (!recordings.length) {
    write(`\n  No video: ${leftOut.length ? 'every test failed' : 'no test opened a page'}.`);
    return;
  }

  const isOnlyTest = recordings.length === 1;
  const passedCount = recordings.filter(r => r.recording.status === r.recording.expectedStatus).length;
  const failedCount = recordings.length - passedCount;
  const summaryLine = !demo && !isOnlyTest ? `${passedCount} ${passedCount === 1 ? 'test' : 'tests'} passed${failedCount ? `, ${failedCount} failed` : ''}.` : undefined;

  const voices = new Voices(options, ffmpeg);
  const lines = new Set<string>();
  for (const { recording } of recordings)
    spokenSentences(recording, options).forEach(line => lines.add(line));
  if (!demo) {
    if (isOnlyTest)
      lines.add('The test passed.');
    if (failedCount)
      lines.add('The test failed.');
    if (summaryLine)
      lines.add(summaryLine);
  }
  await voices.prepare([...lines]);
  if (voices.problem)
    write(`\n  ${voices.problem}`);
  else if (options.voice !== false && voices.engine.engine === 'none')
    write(`\n  This system has no voice, so the video only has captions. For a free, natural voice: ${installVoiceHint()}`);

  const browser = await launchBrowserForStills();
  const tasks: (() => Promise<void>)[] = [];
  const clips: { file: string, plan: Plan }[] = [];
  let summaryClip: { file: string, duration: number } | undefined;
  try {
    const page = await browser.newPage({ viewport: { width: kWidth, height: kHeight } });
    const stillsDir = path.join(work, 'stills');
    fs.mkdirSync(stillsDir, { recursive: true });
    const stills = new Stills(page as unknown as StillPage, stillsDir);
    for (const [index, { dir, recording }] of recordings.entries()) {
      const plan = planClip(dir, recording, options, voices, isOnlyTest);
      const clipWork = path.join(work, String(index));
      fs.mkdirSync(clipWork, { recursive: true });
      const file = path.join(recording.outputDir, 'video.mp4');
      clips.push({ file, plan });
      tasks.push(await renderClip(plan, options, ffmpeg, voices, stills, clipWork, file));
    }
    if (summaryLine) {
      const card = await stills.summary(passedCount, failedCount);
      const clip = voices.clip(summaryLine);
      const duration = Math.max(kSummaryCard, clip ? clip.duration + 0.6 : 0);
      const audioFile = path.join(work, 'summary.f32');
      writeAudio(audioFile, clip ? [{ samples: clip.samples, at: 0.2 }] : [], duration);
      const file = path.join(work, 'summary.mp4');
      summaryClip = { file, duration };
      tasks.push(() => runFfmpeg(ffmpeg, ['-loop', '1', '-i', card, '-f', 'f32le', '-ar', String(kVoiceRate), '-ac', '1', '-i', audioFile, '-filter_complex', `[0:v]fps=${kFps},format=yuv420p[out]`, '-map', '[out]', '-map', '1:a', '-t', duration.toFixed(3), ...kEncoding, file]));
    }
  } finally {
    await browser.close().catch(() => {});
  }
  await inParallel(tasks);

  // The clips join without encoding again. Their real lengths keep the voice and captions in place.
  const durationOf = (file: string, planned: number) => {
    if (!ffmpeg.probe)
      return planned;
    const result = child_process.spawnSync(ffmpeg.probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    return parseFloat(result.stdout) || planned;
  };
  const joined: { file: string, duration: number }[] = [];
  const cues: Cue[] = [];
  const chapters: Chapter[] = [];
  let total = 0;
  for (const { file, plan } of clips) {
    const duration = durationOf(file, plan.total);
    cues.push(...plan.cues.map(cue => ({ ...cue, start: cue.start + total, end: cue.end + total })));
    if (!isOnlyTest && !demo)
      chapters.push({ start: total, title: plan.recording.title });
    else
      chapters.push(...plan.chapters.map(chapter => ({ ...chapter, start: chapter.start + total })));
    joined.push({ file, duration });
    total += duration;
  }
  if (summaryClip) {
    joined.push(summaryClip);
    total += durationOf(summaryClip.file, summaryClip.duration);
  }
  await joinClips(ffmpeg, work, joined, cues, chapters, total, output);
  if (cues.length)
    fs.writeFileSync(output.replace(/\.mp4$/, '.vtt'), toVtt(cues));
  (testRun.config.config as any)._narratedVideoFile = output;
  write(`\n  Video: ${path.relative(process.cwd(), output)} (${formatDuration(total)}, ${recordings.length} ${recordings.length === 1 ? 'test' : 'tests'})`);
}

// `playwright doctor`: what a video would need on this machine.
export function narratedVideoChecks(options: NarratedVideoOptions): { level: 'ok' | 'info' | 'error', title: string, details?: string[] }[] {
  const { ffmpeg, problem } = findFfmpeg();
  const needed = options.mode !== 'off';
  const checks: { level: 'ok' | 'info' | 'error', title: string, details?: string[] }[] = [];
  if (ffmpeg)
    checks.push({ level: needed ? 'ok' : 'info', title: `Video: ffmpeg at ${ffmpeg.path}` });
  else
    checks.push({ level: needed ? 'error' : 'info', title: `Video: ${problem}` });
  const engine = resolveVoiceEngine(options);
  if (engine.engine === 'none' && options.voice !== false)
    checks.push({ level: 'info', title: 'Video voice: none on this system, so videos have captions only', details: [`For a free, natural voice: ${installVoiceHint()}`] });
  else
    checks.push({ level: 'info', title: `Video voice: ${engine.name}` });
  return checks;
}
