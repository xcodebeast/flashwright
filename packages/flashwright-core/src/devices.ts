import { failure } from './errors.js';
import { validateBoolean, validateOptions } from './validation.js';

export interface DeviceOptions {
  defaultBrowserType?: 'chromium' | 'firefox' | 'webkit';
  screen?: { width: number; height: number };
  userAgent?: string;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
}

/** Validate the whole device profile before context allocation or storage restoration. */
export function prepareDeviceOptions(options: DeviceOptions & { viewport?: object | null }) {
  const method = 'browser.newContext';
  // Descriptor metadata never changes the browser already selected by the caller.
  if (options.defaultBrowserType !== undefined && !['chromium', 'firefox', 'webkit'].includes(options.defaultBrowserType)) throw failure('InvalidArgumentError', `${method}.defaultBrowserType`, 'expected chromium, firefox or webkit');
  validateBoolean(`${method}.isMobile`, options.isMobile);
  validateBoolean(`${method}.hasTouch`, options.hasTouch);
  if (options.userAgent !== undefined && typeof options.userAgent !== 'string') throw failure('InvalidArgumentError', `${method}.userAgent`, 'expected a string');
  if (options.deviceScaleFactor !== undefined && (!Number.isFinite(options.deviceScaleFactor) || options.deviceScaleFactor < 0)) throw failure('InvalidArgumentError', `${method}.deviceScaleFactor`, 'expected a finite nonnegative number');
  if (options.viewport === null && (options.deviceScaleFactor !== undefined || options.isMobile)) throw failure('InvalidArgumentError', method, 'deviceScaleFactor and mobile emulation require a non-null viewport');
  if (options.screen !== undefined) {
    validateOptions(`${method}.screen`, options.screen, ['width', 'height']);
    if (![options.screen.width, options.screen.height].every(value => Number.isInteger(value) && value > 0 && value <= 0xffffffff)) throw failure('InvalidArgumentError', `${method}.screen`, 'width and height must be positive 32-bit integers');
  }
  return {
    ...(options.screen === undefined ? {} : { screen: options.screen }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    ...(options.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: options.deviceScaleFactor }),
    ...(options.isMobile === undefined ? {} : { isMobile: options.isMobile }),
    ...(options.hasTouch === undefined ? {} : { hasTouch: options.hasTouch }),
    ...(options.userAgent ? { userAgentMetadata: userAgentMetadata(options.userAgent, options.isMobile ?? false) } : {}),
  };
}

/** Adapted from Playwright 1.60.0 calculateUserAgentMetadata; Apache-2.0 provenance is retained. */
function userAgentMetadata(userAgent: string, isMobile: boolean) {
  const metadata = { mobile: isMobile, model: '', architecture: 'x86', platform: 'Windows', platformVersion: '' };
  const platforms = [
    { pattern: /Android (\d+(\.\d+)?(\.\d+)?)/, platform: 'Android', architecture: 'arm' },
    { pattern: /iPhone OS (\d+(_\d+)?)/, platform: 'iOS', architecture: 'arm' },
    { pattern: /iPad; CPU OS (\d+(_\d+)?)/, platform: 'iOS', architecture: 'arm' },
    { pattern: /Mac OS X (\d+(_\d+)?(_\d+)?)/, platform: 'macOS', architecture: userAgent.includes('Intel') ? 'x86' : 'arm' },
    { pattern: /Windows\D+(\d+(\.\d+)?(\.\d+)?)/, platform: 'Windows', architecture: 'x86' },
  ];
  let matched = false;
  for (const platform of platforms) {
    const match = userAgent.match(platform.pattern);
    if (!match) continue;
    Object.assign(metadata, { platform: platform.platform, architecture: platform.architecture, platformVersion: match[1] });
    matched = true;
    break;
  }
  if (!matched && userAgent.toLowerCase().includes('linux')) metadata.platform = 'Linux';
  if (userAgent.includes('ARM')) metadata.architecture = 'arm';
  return metadata;
}
