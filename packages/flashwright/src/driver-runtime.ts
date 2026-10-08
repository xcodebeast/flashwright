import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { engineHandshake } from './engine-contract.js';
import { failure, FlashwrightError } from './errors.js';
import { residentRuntimeSha256 } from './runtime-version.cjs';

export interface RuntimeHost { platform: string; architecture: string; glibcVersion?: string | undefined }
const maximumDriverBytes = 128 * 1024 * 1024;
const maximumManifestBytes = 64 * 1024;

export function driverPackageName(platform: string, architecture: string): string {
  if (!['darwin-arm64', 'linux-x64'].includes(`${platform}-${architecture}`)) {
    throw failure('UnsupportedFeatureError', 'chromium.launch', `no Flashwright driver is available for ${platform}/${architecture}; supported targets are macOS arm64 and Linux x64 with glibc`);
  }
  return `@flashwright/driver-${platform}-${architecture}`;
}

/** Package metadata cannot turn a binary for another architecture into a supported runtime. */
export function verifyDriverHeader(bytes: Buffer, host: RuntimeHost): void {
  const valid = bytes.length >= 32 && (host.platform === 'darwin' && host.architecture === 'arm64'
    ? bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c && bytes.readUInt32LE(12) === 2
    : host.platform === 'linux' && host.architecture === 'x64' && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
      bytes[4] === 2 && bytes[5] === 1 && [2, 3].includes(bytes.readUInt16LE(16)) && bytes.readUInt16LE(18) === 62);
  if (!valid) incompatible('executable format or architecture does not match its platform');
}

function incompatible(message: string): never {
  throw failure('ProtocolError', 'chromium.launch', `installed Flashwright runtime ${message}; reinstall matching library and platform packages`);
}

function readManifest(path: string): Record<string, unknown> {
  const information = statSync(path);
  if (!information.isFile() || information.size > maximumManifestBytes) incompatible('has an invalid manifest file');
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) incompatible('has an invalid manifest object');
  return value as Record<string, unknown>;
}

function versionParts(value: unknown): number[] {
  if (typeof value !== 'string' || !/^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(value)) incompatible('has an invalid libc version');
  return value.split('.').map(Number);
}

function verifyLibc(minimumVersion: unknown, hostVersion: string | undefined): void {
  const minimum = versionParts(minimumVersion);
  if (!hostVersion) throw failure('UnsupportedFeatureError', 'chromium.launch', 'the Linux x64 Flashwright runtime requires glibc; musl-based Linux is not supported');
  const host = versionParts(hostVersion);
  for (let index = 0; index < 3; index++) {
    if ((host[index] ?? 0) > (minimum[index] ?? 0)) return;
    if ((host[index] ?? 0) < (minimum[index] ?? 0)) {
      throw failure('UnsupportedFeatureError', 'chromium.launch', `the installed Flashwright runtime requires glibc ${minimumVersion} or newer; this host has ${hostVersion}`);
    }
  }
}

/** Verify the installed artifact before starting it. Read bounded chunks so a bad
 * package cannot allocate a binary-sized JavaScript buffer during resolution. */
export function verifyInstalledDriver(packagePath: string, host: RuntimeHost): string {
  const expectedPackage = driverPackageName(host.platform, host.architecture);
  try {
    const packageManifest = readManifest(packagePath);
    if (packageManifest.name !== expectedPackage || packageManifest.version !== engineHandshake.packageVersion) incompatible('package identity does not match this library');
    const root = realpathSync(dirname(packagePath));
    const manifest = readManifest(join(root, 'runtime.json'));
    for (const [field, expected] of Object.entries({
      schemaVersion: 1, packageName: expectedPackage, packageVersion: engineHandshake.packageVersion,
      platform: host.platform, architecture: host.architecture, protocolVersion: engineHandshake.protocolVersion,
      capabilityInventoryVersion: engineHandshake.capabilityInventoryVersion, residentRuntimeSha256,
    })) if (manifest[field] !== expected) incompatible(`manifest ${field} does not match this library`);
    if (host.platform === 'linux') verifyLibc(manifest.minimumGlibcVersion, host.glibcVersion);
    if (manifest.executablePath !== 'bin/flashwright-driver' || !Number.isSafeInteger(manifest.executableBytes) ||
      (manifest.executableBytes as number) <= 0 || (manifest.executableBytes as number) > maximumDriverBytes ||
      typeof manifest.executableSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.executableSha256)) incompatible('has an invalid executable record');
    const executablePath = realpathSync(join(root, manifest.executablePath));
    if (!executablePath.startsWith(root + sep)) incompatible('executable escapes its package');
    accessSync(executablePath, constants.X_OK);
    const descriptor = openSync(executablePath, 'r');
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || before.size !== BigInt(manifest.executableBytes as number)) incompatible('executable size does not match its manifest');
      const digest = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let remaining = Number(before.size);
      while (remaining > 0) {
        const count = readSync(descriptor, buffer, 0, Math.min(remaining, buffer.length), null);
        if (!count) incompatible('executable ended before its declared size');
        if (remaining === Number(before.size)) verifyDriverHeader(buffer.subarray(0, count), host);
        digest.update(buffer.subarray(0, count));
        remaining -= count;
      }
      const after = fstatSync(descriptor, { bigint: true });
      const current = statSync(executablePath, { bigint: true });
      for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) {
        if (before[field] !== after[field] || before[field] !== current[field]) incompatible('executable changed during verification');
      }
      if (digest.digest('hex') !== manifest.executableSha256) incompatible('executable checksum does not match its manifest');
    } finally { closeSync(descriptor); }
    return executablePath;
  } catch (error) {
    if (error instanceof FlashwrightError) throw error;
    throw failure('ProtocolError', 'chromium.launch', `cannot verify installed Flashwright runtime ${expectedPackage}: ${error instanceof Error ? error.message : String(error)}; reinstall matching library and platform packages`);
  }
}

/** An explicit development override bypasses package lookup, while every normal
 * consumer resolves the exact-version platform dependency from this library. */
export function resolveDriverExecutable(): string {
  const packageName = driverPackageName(process.platform, process.arch);
  const override = process.env.FLASHWRIGHT_DRIVER_PATH;
  if (override) return override;
  const report = process.platform === 'linux' ? process.report.getReport() as { header: { glibcVersionRuntime?: string } } : undefined;
  if (process.platform === 'linux' && !report?.header.glibcVersionRuntime) verifyLibc('2.0', undefined);
  let packagePath: string;
  try { packagePath = require.resolve(`${packageName}/package.json`); }
  catch {
    throw failure('UnsupportedFeatureError', 'chromium.launch', `missing ${packageName}@${engineHandshake.packageVersion}; install Flashwright with optional dependencies enabled, or install that exact platform package explicitly. For development or offline use, set FLASHWRIGHT_DRIVER_PATH to a compatible driver`);
  }
  return verifyInstalledDriver(packagePath, { platform: process.platform, architecture: process.arch, glibcVersion: report?.header.glibcVersionRuntime });
}
