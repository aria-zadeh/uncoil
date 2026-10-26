import { defineConfig } from 'vitest/config';

// vitest, not jest-expo, so nothing mocks react native for us. every platform
// specifier resolves to a module that throws on import and names its importer.
// a working stub would let a platform leak grow until it only fails on device
const FORBIDDEN_IN_NODE = new URL('./__tests__/stubs/platform-forbidden.ts', import.meta.url).pathname;

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [
      { find: /^react-native$/, replacement: FORBIDDEN_IN_NODE },
      { find: /^react-native\//, replacement: FORBIDDEN_IN_NODE },
      // also catches the resource fetcher, but that package never reaches the alias (below)
      { find: /^react-native-(?!executorch$)/, replacement: FORBIDDEN_IN_NODE },
      { find: /^expo(-.*)?$/, replacement: FORBIDDEN_IN_NODE },
      { find: /^@expo\//, replacement: FORBIDDEN_IN_NODE },
      { find: /^@react-native-async-storage\//, replacement: FORBIDDEN_IN_NODE },
      { find: /^@react-navigation\//, replacement: FORBIDDEN_IN_NODE },
      { find: /^react-native-executorch$/, replacement: FORBIDDEN_IN_NODE },
      { find: /^nativewind$/, replacement: FORBIDDEN_IN_NODE },
    ],
  },
  // react-native-executorch-expo-resource-fetcher@0.9.1 does an extensionless
  // `export * from './ResourceFetcher'`. metro accepts it, node's ESM resolver does
  // not, and vite crashes reading the package before any alias or inline option
  // applies. importing it in node still always throws, which is all we need.
  // executorchPlatformIsolation.test.ts fails if a fixed version starts resolving
  test: {
    // forks, not threads: the no-network test replaces globals, and thread workers
    // share one global object across files
    pool: 'forks',
    environment: 'node',
    clearMocks: true,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['__tests__/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'integration', include: ['__tests__/integration/**/*.test.ts'] },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      // checks.mjs asserts these five files exist, since a glob matching nothing
      // would make the threshold pass vacuously
      include: [
        'services/scheduler.ts',
        'services/validation.ts',
        'services/prompt.ts',
        'services/templates.ts',
        'services/insights.ts',
      ],
      thresholds: {
        // per file so one well-covered module cannot carry the rest
        perFile: true,
        lines: 90,
      },
    },
  },
});
