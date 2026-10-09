/**
 * Browser detection for browser-driven test runners.
 *
 * Chrome and Chromium are searched through the standard, documented install
 * locations for each platform rather than one hard-coded path, and the search is
 * a filesystem check only — nothing is launched, so detection is cheap and
 * cannot hang a run waiting for a browser window.
 *
 * If a browser cannot be found the result is `not-found`, never "absent, and
 * that is fine". Callers decide whether a missing browser blocks a pipeline or
 * merely warns, because that depends on which test runner the project uses and
 * only the project knows.
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

export type BrowserName = 'chrome' | 'chromium';

export interface BrowserDetection {
  name: BrowserName;
  /** Absolute path to the executable. */
  path: string;
  /** Version read from the binary's metadata, when it could be read. */
  version: string | null;
}

export interface BrowserSearchResult {
  browsers: BrowserDetection[];
  /** Locations that were inspected, for a diagnostic that explains the search. */
  searched: number;
}

interface Candidate {
  name: BrowserName;
  paths: string[];
}

const WINDOWS_CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  join(homedir(), 'AppData\\Local\\Chromium\\Application\\chrome.exe'),
];

const WINDOWS_CHROMIUM = [
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  join(homedir(), 'AppData\\Local\\Chromium\\Application\\chrome.exe'),
];

const DARWIN_CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const DARWIN_CHROMIUM = ['/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Chrome.app/Contents/MacOS/Chrome'];

const LINUX_CHROME = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
];

const LINUX_CHROMIUM = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];

function candidatesFor(os: NodeJS.Platform): Candidate[] {
  switch (os) {
    case 'win32':
      return [
        { name: 'chrome', paths: WINDOWS_CHROME },
        { name: 'chromium', paths: WINDOWS_CHROMIUM },
      ];
    case 'darwin':
      return [
        { name: 'chrome', paths: DARWIN_CHROME },
        { name: 'chromium', paths: DARWIN_CHROMIUM },
      ];
    default:
      return [
        { name: 'chrome', paths: LINUX_CHROME },
        { name: 'chromium', paths: LINUX_CHROMIUM },
      ];
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

/**
 * Reads a version from the executable's own metadata.
 *
 * Windows PE files and macOS bundles expose it; Linux binaries often do not.
 * A missing version is recorded as `null` rather than guessed from the path,
 * because "unknown version" is honest and a fabricated number is not.
 */
async function readVersion(path: string): Promise<string | null> {
  try {
    const buffer = await readFile(path);
    const text = buffer.toString('latin1');
    const patterns = [
      /ProductVersion"?\s*[:=]?\s*"?(\d+\.\d+(?:\.\d+)*)/i,
      /file_version"?\s*[:=]?\s*"?(\d+\.\d+(?:\.\d+)*)/i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match?.[1]) return match[1];
    }
  } catch {
    // Unreadable metadata simply means "version unknown".
  }
  return null;
}

/** Searches the standard install locations for this platform. */
export async function detectBrowsers(os: NodeJS.Platform = platform()): Promise<BrowserSearchResult> {
  const candidates = candidatesFor(os);
  const browsers: BrowserDetection[] = [];
  let searched = 0;

  for (const candidate of candidates) {
    for (const path of candidate.paths) {
      searched += 1;
      if (browsers.some((browser) => browser.path === path)) continue;
      if (!(await exists(path))) continue;

      browsers.push({
        name: candidate.name,
        path,
        version: await readVersion(path),
      });
      break; // One working browser per family is enough.
    }
  }

  return { browsers, searched };
}

/** True when a specific browser family was found. */
export function hasBrowser(result: BrowserSearchResult, name: BrowserName): boolean {
  return result.browsers.some((browser) => browser.name === name);
}

/**
 * Test runners that genuinely need a real browser to execute.
 *
 * Deliberately conservative: only runners that launch a browser are listed.
 * A project using Vitest with jsdom, or Jest with a node environment, is not
 * blocked by the absence of Chrome, and claiming otherwise would be a false
 * BLOCKED.
 */
const BROWSER_REQUIRING_RUNNERS = [
  'karma',
  'karma-jasmine',
  'karma-chrome-launcher',
  'karma-firefox-launcher',
  'protractor',
  '@angular-devkit/build-angular',
  'cypress',
  'nightwatch',
  'webdriverio',
];

/** True when the project's dependencies indicate a browser is mandatory. */
export function requiresBrowser(dependencies: Record<string, string>): boolean {
  const all = Object.keys({ ...dependencies });
  return BROWSER_REQUIRING_RUNNERS.some((runner) => all.includes(runner));
}