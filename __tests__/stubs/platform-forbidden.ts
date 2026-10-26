// every RN, Expo and ExecuTorch specifier resolves here in Node tests and throws on import,
// so a platform dependency in a pure module fails here instead of on device
const trace = new Error('platform module imported in a Node test').stack ?? '(no stack available)';

throw new Error(
  [
    'A platform module was imported inside the Node test run.',
    '',
    'Pure services and stores must not reach React Native, Expo, AsyncStorage or',
    'the inference runtime. Stores take a Repository; generation takes a backend.',
    '',
    'Import trace:',
    trace,
  ].join('\n'),
);

export {};
