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
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registry } from 'playwright-core/lib/coreBundle';
import { getPackageManagerExecCommand } from '@utils/env';

import type { NarratedVideoOptions } from '../../types/test';

// Flashwright: the voice and ffmpeg behind `playwright test --video`. By default the system's voice
// reads the narration, or Kokoro, a free voice that runs locally, once `playwright install-voice`
// has downloaded it (it is too large for the normal install). Sentences are cached across runs.

export const kVoiceRate = 48000;

const kKokoroVersion = '1.2.1';
const kKokoroDefaultVoice = 'af_heart';

// Reads { voice, items: [{ text, file }] } from stdin and writes each text's samples. A process of
// its own: it loads a speech model that the runner has no use for after this.
const kKokoroScript = `
const { createRequire } = require('module');
const { pathToFileURL } = require('url');
const fs = require('fs');
(async () => {
  const resolved = createRequire(process.cwd() + '/package.json').resolve('kokoro-js');
  const { KokoroTTS } = await import(pathToFileURL(resolved).href);
  const { voice, items } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  for (const item of items) {
    const parts = [];
    let rate = 24000;
    for (const sentence of item.text.match(/[^.!?]+[.!?]*\\s*/g) ?? [item.text]) {
      const audio = await tts.generate(sentence.trim(), { voice });
      rate = audio.sampling_rate;
      parts.push(Buffer.from(new Float32Array(audio.audio).buffer));
      parts.push(Buffer.alloc(Math.floor(rate * 0.12) * 4));
    }
    fs.writeFileSync(item.file, Buffer.concat(parts));
    console.log(JSON.stringify({ file: item.file, rate }));
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
`;

function findExecutable(name: string): string | undefined {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const extension of extensions) {
      const file = path.join(dir, name + extension);
      try {
        if (fs.statSync(file).isFile())
          return file;
      } catch {
      }
    }
  }
}

export type Ffmpeg = { path: string, probe?: string, filterScriptFlag: string };

const kFfmpegHint = process.platform === 'darwin' ? 'brew install ffmpeg' : process.platform === 'win32' ? 'winget install ffmpeg' : 'install the "ffmpeg" package';

export function findFfmpeg(): { ffmpeg?: Ffmpeg, problem?: string } {
  const file = findExecutable('ffmpeg');
  if (!file)
    return { problem: `ffmpeg is not installed: ${kFfmpegHint}` };
  const run = (...args: string[]) => child_process.spawnSync(file, args, { encoding: 'utf8', maxBuffer: 16 << 20 });
  const encoders = run('-hide_banner', '-encoders').stdout ?? '';
  const filters = run('-hide_banner', '-filters').stdout ?? '';
  const missing = [
    ...['libx264', ' aac '].filter(name => !encoders.includes(name)),
    ...['overlay', 'zoompan', 'pad'].filter(name => !filters.includes(' ' + name + ' ')),
  ].map(name => name.trim());
  if (missing.length)
    return { problem: `ffmpeg at ${file} has no ${missing.join(', ')}: ${kFfmpegHint}` };
  const version = run('-version').stdout?.match(/ffmpeg version n?(\d+)\./)?.[1];
  return { ffmpeg: {
    path: file,
    probe: findExecutable('ffprobe'),
    filterScriptFlag: version && +version < 7 ? '-filter_complex_script' : '-/filter_complex',
  } };
}

function kokoroDir() {
  return path.join(registry.registryDirectory, 'flashwright-voice');
}

export function isKokoroInstalled() {
  return fs.existsSync(path.join(kokoroDir(), 'node_modules', 'kokoro-js', 'package.json'));
}

type SystemVoice = { name: string, say: (text: string, voiceName: string | undefined, out: string) => void };

function findSystemVoice(): SystemVoice | undefined {
  const run = (file: string, args: string[], env?: NodeJS.ProcessEnv) => {
    const result = child_process.spawnSync(file, args, { encoding: 'utf8', env: { ...process.env, ...env } });
    if (result.status !== 0)
      throw new Error(`${path.basename(file)} failed: ${result.error?.message ?? result.stderr}`);
  };
  if (process.platform === 'darwin') {
    const say = findExecutable('say');
    if (say)
      return { name: 'macOS say', say: (textFile, voiceName, out) => run(say, [...(voiceName ? ['-v', voiceName] : []), '-f', textFile, '-o', out + '.aiff']) };
    return;
  }
  if (process.platform === 'win32') {
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; if ($env:FW_VOICE) { $s.SelectVoice($env:FW_VOICE) }; $s.SetOutputToWaveFile($env:FW_OUT); $s.Speak((Get-Content -Raw -Encoding UTF8 $env:FW_IN)); $s.Dispose()`;
    return { name: 'Windows speech', say: (textFile, voiceName, out) => run('powershell', ['-NoProfile', '-Command', script], { FW_IN: textFile, FW_OUT: out + '.wav', FW_VOICE: voiceName ?? '' }) };
  }
  const espeak = findExecutable('espeak-ng') ?? findExecutable('espeak');
  if (espeak)
    return { name: path.basename(espeak), say: (textFile, voiceName, out) => run(espeak, [...(voiceName ? ['-v', voiceName] : []), '-f', textFile, '-w', out + '.wav']) };
}

export type VoiceEngine = { engine: 'kokoro' | 'system' | 'custom' | 'none', name: string };

// Which engine the options select on this machine.
export function resolveVoiceEngine(options: NarratedVideoOptions): VoiceEngine {
  const voice = options.voice ?? 'auto';
  if (voice === false)
    return { engine: 'none', name: 'off' };
  if (typeof voice === 'function')
    return { engine: 'custom', name: 'your function' };
  if (voice === 'kokoro' || (voice === 'auto' && isKokoroInstalled()))
    return { engine: 'kokoro', name: 'Kokoro' };
  const system = findSystemVoice();
  return system ? { engine: 'system', name: system.name } : { engine: 'none', name: 'no voice on this system' };
}

export function installVoiceHint() {
  return `${getPackageManagerExecCommand()} playwright install-voice`;
}

export type VoiceClip = { samples: Float32Array, duration: number };

export class Voices {
  private _options: NarratedVideoOptions;
  private _ffmpeg: Ffmpeg;
  private _engine: VoiceEngine;
  private _dir: string;
  private _clips = new Map<string, VoiceClip>();
  problem: string | undefined;

  constructor(options: NarratedVideoOptions, ffmpeg: Ffmpeg) {
    this._options = options;
    this._ffmpeg = ffmpeg;
    this._engine = resolveVoiceEngine(options);
    // FLASHWRIGHT_VOICE_CACHE keeps the voice between CI jobs, which have a new temp folder each.
    this._dir = process.env.FLASHWRIGHT_VOICE_CACHE ?? path.join(os.tmpdir(), `flashwright-voice-${os.userInfo().uid}`);
  }

  get engine() {
    return this._engine;
  }

  clip(text: string): VoiceClip | undefined {
    return this._clips.get(text);
  }

  // Makes the audio of every text that is not in the cache. A voice that fails leaves the video
  // without it: the tests have already run and their video is still worth having.
  async prepare(texts: string[]) {
    if (this._engine.engine === 'none')
      return;
    fs.mkdirSync(this._dir, { recursive: true, mode: 0o700 });
    // A changed function may speak differently; its source tells.
    const voiceFunction = typeof this._options.voice === 'function' ? String(this._options.voice) : '';
    const fileFor = (text: string) => path.join(this._dir, crypto.createHash('sha1').update([this._engine.engine, this._engine.name, this._options.voiceName ?? '', voiceFunction, text].join('\0')).digest('hex') + '.f32');
    const missing = [...new Set(texts)].filter(text => !fs.existsSync(fileFor(text)));
    try {
      if (missing.length) {
        if (this._engine.engine === 'kokoro')
          await this._sayWithKokoro(missing, fileFor);
        else if (this._engine.engine === 'custom')
          await this._sayWithFunction(missing, fileFor);
        else
          this._sayWithSystem(missing, fileFor);
      }
    } catch (error) {
      this.problem = `the voice failed, so the video has none: ${error?.message ?? error}`;
    }
    for (const text of new Set(texts)) {
      if (!fs.existsSync(fileFor(text)))
        continue;
      const data = fs.readFileSync(fileFor(text));
      const samples = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      this._clips.set(text, { samples, duration: samples.length / kVoiceRate });
    }
  }

  // To samples at the rate of the video's audio, atomically so that the cache never has half a clip.
  private _toCache(input: string[], target: string) {
    const temporary = `${target}.${process.pid}`;
    const result = child_process.spawnSync(this._ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-ar', String(kVoiceRate), '-ac', '1', '-f', 'f32le', temporary], { encoding: 'utf8' });
    if (result.status !== 0)
      throw new Error(result.stderr);
    fs.renameSync(temporary, target);
  }

  private _sayWithSystem(texts: string[], fileFor: (text: string) => string) {
    const system = findSystemVoice()!;
    for (const text of texts) {
      const base = `${fileFor(text)}.${process.pid}`;
      fs.writeFileSync(base + '.txt', text);
      try {
        system.say(base + '.txt', this._options.voiceName, base);
        const audio = [base + '.aiff', base + '.wav'].find(file => fs.existsSync(file))!;
        this._toCache(['-i', audio], fileFor(text));
      } finally {
        for (const suffix of ['.txt', '.aiff', '.wav'])
          fs.rmSync(base + suffix, { force: true });
      }
    }
  }

  private async _sayWithFunction(texts: string[], fileFor: (text: string) => string) {
    const voice = this._options.voice as (text: string) => Promise<Buffer>;
    for (const text of texts) {
      const base = `${fileFor(text)}.${process.pid}.audio`;
      fs.writeFileSync(base, await voice(text));
      try {
        this._toCache(['-i', base], fileFor(text));
      } finally {
        fs.rmSync(base, { force: true });
      }
    }
  }

  private async _sayWithKokoro(texts: string[], fileFor: (text: string) => string) {
    if (!isKokoroInstalled())
      throw new Error(`Kokoro is not installed: ${installVoiceHint()}`);
    const items = texts.map(text => ({ text, file: `${fileFor(text)}.${process.pid}.raw` }));
    const { stdout } = await runKokoro({ voice: this._options.voiceName ?? kKokoroDefaultVoice, items });
    for (const line of stdout.split('\n').filter(Boolean)) {
      const { file, rate } = JSON.parse(line) as { file: string, rate: number };
      const item = items.find(i => i.file === file)!;
      this._toCache(['-f', 'f32le', '-ar', String(rate), '-ac', '1', '-i', file], fileFor(item.text));
      fs.rmSync(file, { force: true });
    }
  }
}

function runKokoro(input: { voice: string, items: { text: string, file: string }[] }, stdio?: 'inherit'): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = child_process.spawn(process.execPath, ['-e', kKokoroScript], { cwd: kokoroDir(), env, stdio: ['pipe', 'pipe', stdio ?? 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', data => stdout += data);
    child.stderr?.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve({ stdout }) : reject(new Error(`Kokoro failed: ${stderr.slice(-500)}`)));
    child.stdin!.end(JSON.stringify(input));
  });
}

// `playwright install-voice`: downloads Kokoro and its model, about 500 MB, outside the project.
export async function runInstallVoice(): Promise<number> {
  const dir = kokoroDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'flashwright-voice', private: true }));
  process.stdout.write(`Downloading Kokoro, a free voice that runs on this machine, to ${dir}. This takes about 500 MB.\n`);
  const npm = child_process.spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', `kokoro-js@${kKokoroVersion}`, '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (npm.status !== 0) {
    process.stdout.write('Could not install Kokoro: npm failed.\n');
    return 1;
  }
  const sample = path.join(dir, 'sample.raw');
  try {
    await runKokoro({ voice: kKokoroDefaultVoice, items: [{ text: 'Hello.', file: sample }] }, 'inherit');
  } catch (error) {
    process.stdout.write(`Could not set up Kokoro: ${error?.message ?? error}\n`);
    return 1;
  }
  fs.rmSync(sample, { force: true });
  process.stdout.write(`Kokoro is ready. Runs with --video and --demo use it from now on.\n`);
  return 0;
}
