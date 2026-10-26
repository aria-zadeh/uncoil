import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const EXECUTORCH_RUNTIME_PATH = 'services/executorchRuntime.ts';

// executorchRuntime.ts's imports must never be usable in Node. the resource fetcher is not
// aliased: its extensionless re-export already fails Node's ESM resolver. if a release
// fixes that, this test fails and the package needs a real alias entry
describe('react-native-executorch and friends are unreachable from the Node test graph', () => {
  it('react-native-executorch throws the labelled platform stub', async () => {
    await expect(import('react-native-executorch')).rejects.toThrow(/platform module imported in a Node test/);
  });

  it('expo-file-system throws the labelled platform stub', async () => {
    await expect(import('expo-file-system')).rejects.toThrow(/platform module imported in a Node test/);
  });

  it('expo-asset throws the labelled platform stub', async () => {
    await expect(import('expo-asset')).rejects.toThrow(/platform module imported in a Node test/);
  });

  it('react-native-executorch-expo-resource-fetcher throws -- upstream, not aliased, but never silently importable', async () => {
    await expect(import('react-native-executorch-expo-resource-fetcher')).rejects.toThrow();
  });
});

// executorchRuntime.ts cannot be imported here, so read it as text and check the wiring.
// the .pte is too big for a Metro asset (one JS string, capped at 0x1fffffe8 bytes), so it
// ships as a bundle resource named by a file:// path, which bundledModelUri checks
describe('every model source reaching the library is guarded', () => {
  const source = readFileSync(EXECUTORCH_RUNTIME_PATH, 'utf8');

  it.each(['TOKENIZER_SOURCE', 'TOKENIZER_CONFIG_SOURCE'])('%s is passed through assertBundledSource before use', (name) => {
    expect(source).toMatch(new RegExp(`assertBundledSource\\(${name},`));
  });

  it('the model program is named by a bundle path, never by a require()', () => {
    expect(source).toMatch(/bundledModelUri\(MODEL_FILE_NAME\)/);
    expect(source).not.toMatch(/require\('\.\.\/assets\/model\/[^']*\.pte'\)/);
  });

  it('bundledModelUri rejects anything that is not a file:// path', () => {
    expect(source).toMatch(/uri\.startsWith\('file:\/\/'\)/);
  });

  it('fromCustomModel is called with the guarded locals, not the raw module-level constants', () => {
    expect(source).toMatch(/fromCustomModel\(modelSource, tokenizerSource, tokenizerConfigSource\)/);
  });
});
