const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// layers depend downward only:
//   app/ -> components/ -> utils/
//   app/ -> store/ -> services/ -> data/ -> types/
// no-restricted-imports matches the raw specifier, so escaping relative imports
// are banned and every cross-directory import goes through `@/`

const SOURCE_DIRS = [
  'app/**/*.{ts,tsx}',
  'components/**/*.{ts,tsx}',
  'services/**/*.{ts,tsx}',
  'store/**/*.{ts,tsx}',
  'data/**/*.{ts,tsx}',
  'types/**/*.{ts,tsx}',
  'utils/**/*.{ts,tsx}',
  'hooks/**/*.{ts,tsx}',
  'assets/**/*.{ts,tsx}',
];

const ESCAPING_RELATIVE = {
  group: ['../*', '../../*', '../../../*', '../../../../*'],
  message:
    'Escaping relative imports are banned so layer boundaries are checkable. Use the @/ alias.',
};

// flat config does not merge options for one rule across config objects, the last
// match wins. so the executorch `paths` go through zone() and each file set sets
// no-restricted-imports exactly once
const EXECUTORCH_PATHS = [
  {
    name: 'react-native-executorch',
    message:
      'Only services/executorchRuntime.ts may import the inference runtime. Call it through services/generation.ts.',
  },
  {
    name: 'react-native-executorch-expo-resource-fetcher',
    message: 'Only services/executorchRuntime.ts may import the resource fetcher.',
  },
];

function zone(files, groups, { paths = [], ignores } = {}) {
  const config = {
    files,
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [ESCAPING_RELATIVE, ...groups], ...(paths.length ? { paths } : {}) },
      ],
    },
  };
  if (ignores) config.ignores = ignores;
  return config;
}

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      'dist/*',
      '.expo/*',
      '.expo-export-check/*',
      'node_modules/*',
      // any venv under train/, matching .gitignore's `train/.venv*/`
      'train/.venv*/*',
      'train/out/*',
      'train/data/*',
      'ios/*',
      'android/*',
    ],
  },

  zone(
    ['app/**/*.{ts,tsx}'],
    [
      {
        group: ['@/data', '@/data/*'],
        message: 'app/ may not touch persistence. Read through a store.',
      },
      {
        group: ['@/services', '@/services/*'],
        message:
          'app/ may not import services. ARCHITECTURE.md section 7 allows components/, store/, utils/, types/ only; a derivation in a screen is business logic in a screen.',
      },
    ],
    { paths: EXECUTORCH_PATHS },
  ),

  zone(
    ['components/**/*.{ts,tsx}'],
    [
      {
        group: ['@/store', '@/store/*'],
        message:
          'components/ take props and are testable in isolation. Screens connect them to state.',
      },
      { group: ['@/services', '@/services/*'], message: 'components/ may import utils/ and types/ only.' },
      { group: ['@/data', '@/data/*'], message: 'components/ may import utils/ and types/ only.' },
    ],
    { paths: EXECUTORCH_PATHS },
  ),

  zone(
    ['store/**/*.{ts,tsx}'],
    [
      { group: ['@/app', '@/app/*'], message: 'Dependencies point downward. store/ may not import app/.' },
      { group: ['@/components', '@/components/*'], message: 'Dependencies point downward. store/ may not import components/.' },
    ],
    { paths: EXECUTORCH_PATHS },
  ),

  // executorchRuntime.ts is the only file allowed to import the runtime. these two
  // are exempt from `paths` only and still get the services/ layer rules
  zone(
    ['services/**/*.{ts,tsx}'],
    [
      { group: ['@/app', '@/app/*'], message: 'services/ may import data/, types/ and utils/ only.' },
      { group: ['@/components', '@/components/*'], message: 'services/ may import data/, types/ and utils/ only.' },
      { group: ['@/store', '@/store/*'], message: 'services/ may import data/, types/ and utils/ only.' },
    ],
    { paths: EXECUTORCH_PATHS, ignores: ['services/generation.ts', 'services/executorchRuntime.ts'] },
  ),
  zone(['services/generation.ts', 'services/executorchRuntime.ts'], [
    { group: ['@/app', '@/app/*'], message: 'services/ may import data/, types/ and utils/ only.' },
    { group: ['@/components', '@/components/*'], message: 'services/ may import data/, types/ and utils/ only.' },
    { group: ['@/store', '@/store/*'], message: 'services/ may import data/, types/ and utils/ only.' },
  ]),

  zone(
    ['data/**/*.{ts,tsx}'],
    [
      { group: ['@/app', '@/app/*'], message: 'data/ may import types/ only.' },
      { group: ['@/components', '@/components/*'], message: 'data/ may import types/ only.' },
      { group: ['@/store', '@/store/*'], message: 'data/ may import types/ only.' },
      { group: ['@/services', '@/services/*'], message: 'data/ may import types/ only.' },
      { group: ['@/utils', '@/utils/*'], message: 'data/ may import types/ only.' },
    ],
    { paths: EXECUTORCH_PATHS },
  ),

  // pure services load types/ in node tests, so it imports nothing at all
  zone(
    ['types/**/*.{ts,tsx}'],
    [
      { group: ['@/*'], message: 'types/ is the leaf. It imports nothing.' },
      { group: ['react-native', 'react-native/*', 'expo-*', '@expo/*', 'react', 'zustand'], message: 'types/ is the leaf. It imports nothing.' },
    ],
    { paths: EXECUTORCH_PATHS },
  ),

  // hooks/ does not exist yet. a leaf, like utils/
  zone(
    ['hooks/**/*.{ts,tsx}'],
    [
      { group: ['@/app', '@/app/*'], message: 'hooks/ is a leaf layer.' },
      { group: ['@/components', '@/components/*'], message: 'hooks/ is a leaf layer.' },
      { group: ['@/store', '@/store/*'], message: 'hooks/ is a leaf layer.' },
      { group: ['@/services', '@/services/*'], message: 'hooks/ is a leaf layer.' },
      { group: ['@/data', '@/data/*'], message: 'hooks/ is a leaf layer.' },
    ],
    { paths: EXECUTORCH_PATHS },
  ),

  zone(
    ['utils/**/*.{ts,tsx}'],
    [
      { group: ['@/app', '@/app/*'], message: 'utils/ is a leaf layer.' },
      { group: ['@/components', '@/components/*'], message: 'utils/ is a leaf layer.' },
      { group: ['@/store', '@/store/*'], message: 'utils/ is a leaf layer.' },
      { group: ['@/services', '@/services/*'], message: 'utils/ is a leaf layer.' },
      { group: ['@/data', '@/data/*'], message: 'utils/ is a leaf layer.' },
    ],
    { paths: EXECUTORCH_PATHS },
  ),

  zone(
    ['assets/**/*.{ts,tsx}'],
    [
      { group: ['@/app', '@/app/*'], message: 'assets/ is a leaf layer.' },
      { group: ['@/components', '@/components/*'], message: 'assets/ is a leaf layer.' },
      { group: ['@/store', '@/store/*'], message: 'assets/ is a leaf layer.' },
      { group: ['@/services', '@/services/*'], message: 'assets/ is a leaf layer.' },
      { group: ['@/data', '@/data/*'], message: 'assets/ is a leaf layer.' },
    ],
    { paths: EXECUTORCH_PATHS },
  ),

  {
    files: SOURCE_DIRS,
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'The app makes zero network requests. PRD.md section 8.' },
        { name: 'XMLHttpRequest', message: 'The app makes zero network requests. PRD.md section 8.' },
        { name: 'WebSocket', message: 'The app makes zero network requests. PRD.md section 8.' },
        { name: 'EventSource', message: 'The app makes zero network requests. PRD.md section 8.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'navigator', property: 'sendBeacon', message: 'The app makes zero network requests.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Alert'][callee.property.name='alert']",
          message: 'No Alert.alert. Use the Modal component so behaviour is consistent and testable. ARCHITECTURE.md section 9.',
        },
      ],
    },
  },
]);
