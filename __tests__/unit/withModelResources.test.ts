// the plugin is what lets the model exceed Metro's ~512 MB asset cap. which files it adds
// and the path Xcode gets for each are pure, so they are tested here without a prebuild
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

interface ModelResource {
  name: string;
  absolutePath: string;
  filepath: string;
}

interface PluginModule {
  resolveModelResources: (args: {
    projectRoot: string;
    platformProjectRoot: string;
    files?: unknown;
    listDir?: (dir: string) => string[];
    fileExists?: (file: string) => boolean;
  }) => ModelResource[];
  MODEL_DIR: string;
  MODEL_EXT: string;
  GROUP_NAME: string;
}

// require(), not import: the plugin is CommonJS that Expo loads at prebuild, and it
// requires expo/config-plugins lazily so this pulls in no Xcode tooling
const requireCjs = createRequire(import.meta.url);
const plugin = requireCjs('../../plugins/withModelResources.js') as PluginModule;

const PROJECT_ROOT = path.join(path.sep, 'repo');
const PLATFORM_ROOT = path.join(PROJECT_ROOT, 'ios');
const MODEL_DIR = path.join(PROJECT_ROOT, 'assets', 'model');

const DIRECTORY = [
  'LICENSE-SmolLM2.txt',
  'tether-base-bf16.pte',
  'tether-135m-8da4w.pte',
  'tokenizer.rnejson',
  'tokenizer_config.rnejson',
];

function resolve(files?: unknown, listing: string[] = DIRECTORY) {
  return plugin.resolveModelResources({
    projectRoot: PROJECT_ROOT,
    platformProjectRoot: PLATFORM_ROOT,
    files,
    listDir: (dir) => (dir === MODEL_DIR ? listing : []),
    fileExists: (file) => listing.includes(path.basename(file)),
  });
}

describe('resolveModelResources', () => {
  it('writes the path relative to ios/, so a "<group>" file reference resolves', () => {
    const [resource] = resolve(['tether-135m-8da4w.pte']);
    // Xcode resolves a "<group>" reference against the directory holding the .xcodeproj
    expect(resource.filepath).toBe('../assets/model/tether-135m-8da4w.pte');
    expect(resource.name).toBe('tether-135m-8da4w.pte');
    expect(resource.absolutePath).toBe(path.join(MODEL_DIR, 'tether-135m-8da4w.pte'));
  });

  it('adds only the named files, not every export sitting in the directory', () => {
    // the directory collects candidate exports, over a gigabyte of unused weights, hence the explicit list
    expect(resolve(['tether-135m-8da4w.pte']).map((r) => r.name)).toEqual(['tether-135m-8da4w.pte']);
  });

  it('falls back to every .pte in the directory, sorted, when no list is given', () => {
    // readdir order is filesystem-defined, and an unstable pbxproj makes every prebuild a spurious diff
    expect(resolve(undefined).map((r) => r.name)).toEqual([
      'tether-135m-8da4w.pte',
      'tether-base-bf16.pte',
    ]);
  });

  it('returns nothing rather than throwing when the directory is empty', () => {
    expect(resolve(undefined, [])).toEqual([]);
  });

  it('fails loudly on a file that is not there', () => {
    // skipping would build an app that launches with no model
    expect(() => resolve(['tether-360m-bf16.pte'])).toThrow(/does not exist/);
  });

  it('rejects a name that is not a .pte', () => {
    expect(() => resolve(['tokenizer.rnejson'])).toThrow(/not a \.pte file/);
  });

  it('rejects a path, so the option cannot point outside assets/model/', () => {
    // the LFS rule and the pointer check both assume the artifact lives in one directory
    expect(() => resolve(['../../elsewhere/model.pte'])).toThrow(/are names inside/);
  });

  it('rejects a files option that is not an array of non-empty strings', () => {
    expect(() => resolve('tether-135m-8da4w.pte')).toThrow(/must be an array/);
    expect(() => resolve([''])).toThrow(/non-empty file name/);
    expect(() => resolve([42])).toThrow(/non-empty file name/);
  });

  it('files the resources under the same Xcode group expo-asset uses', () => {
    expect(plugin.GROUP_NAME).toBe('Resources');
    expect(plugin.MODEL_EXT).toBe('.pte');
    expect(plugin.MODEL_DIR).toBe(path.join('assets', 'model'));
  });
});
