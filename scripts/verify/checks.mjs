// the one definition of the verification gate. gate.mjs runs every entry, one.mjs
// runs a single one for the dev loop. ordered by phase so the top failure is the next
// thing to fix. if a gate is genuinely wrong, record why and leave it failing
import { sh, tail, exists, requireVenv, venvPython, repoPath, read } from './lib.mjs';

const COVERAGE_TARGETS = [
  'services/scheduler.ts',
  'services/validation.ts',
  'services/prompt.ts',
  'services/templates.ts',
  'services/insights.ts',
];

function vitest(project, extra = '') {
  const r = sh(`npx vitest run --project ${project} --reporter dot ${extra}`);
  return { ok: r.ok, detail: r.ok ? '' : tail(r.combined, 20) };
}

function vitestFile(rel) {
  if (!exists(rel)) return { ok: false, detail: `${rel} not written yet` };
  const r = sh(`npx vitest run --project integration --reporter dot ${rel}`);
  return { ok: r.ok, detail: r.ok ? '' : tail(r.combined, 30) };
}

function runNodeScript(rel) {
  if (!exists(rel)) return { ok: false, detail: `${rel} not written yet` };
  const r = sh(`node ${rel}`);
  return { ok: r.ok, detail: r.ok ? '' : tail(r.combined, 30) };
}

export const CHECKS = [
  {
    id: 1,
    phase: 0,
    title: 'TypeScript compiles',
    run: () => {
      const r = sh('npx tsc --noEmit');
      return { ok: r.ok, detail: r.ok ? '' : tail(r.combined, 25) };
    },
  },
  {
    id: 2,
    phase: 0,
    title: 'ESLint clean, import boundaries included',
    run: () => {
      const r = sh('npx eslint .');
      return { ok: r.ok, detail: r.ok ? '' : tail(r.combined, 25) };
    },
  },
  {
    id: 10,
    phase: 0,
    title: 'No banned strings',
    run: () => runNodeScript('scripts/verify/banned-strings.mjs'),
  },
  {
    id: 11,
    phase: 0,
    title: 'No secrets in tracked files',
    run: () => runNodeScript('scripts/verify/secrets.mjs'),
  },
  {
    id: 4,
    phase: 0,
    title: 'Integration tests pass via in-memory Repository',
    run: () => vitest('integration'),
  },
  {
    id: 5,
    phase: 0,
    title: 'no-network: full lifecycle attempts zero requests',
    run: () => {
      if (!exists('__tests__/integration/no-network.test.ts')) {
        return { ok: false, detail: '__tests__/integration/no-network.test.ts not written yet' };
      }
      const r = sh('npx vitest run --project integration --reporter dot __tests__/integration/no-network.test.ts');
      return { ok: r.ok, detail: r.ok ? '' : tail(r.combined, 25) };
    },
  },
  {
    id: 8,
    phase: 0,
    title: 'Metro bundles for iOS',
    run: () => {
      const r = sh('npx expo export --platform ios --output-dir .expo-export-check --clear');
      if (!r.ok) return { ok: false, detail: tail(r.combined, 25) };
      const lfs = sh('node scripts/verify/lfs-pointer.mjs');
      if (!lfs.ok) return { ok: false, detail: tail(lfs.combined, 15) };
      return { ok: true, detail: '' };
    },
  },
  {
    id: 3,
    phase: 1,
    title: 'Unit tests pass, >=90% line coverage on the five pure services',
    run: () => {
      // a coverage glob matching nothing does not fail, so check the targets exist
      const missing = COVERAGE_TARGETS.filter((f) => !exists(f));
      if (missing.length) {
        return { ok: false, detail: `coverage targets missing, threshold would be vacuous:\n  ${missing.join('\n  ')}` };
      }
      return vitest('unit', '--coverage');
    },
  },
  {
    id: 9,
    phase: 1,
    title: 'Cold start: 500-task fixture within budget',
    run: () => {
      if (!exists('__tests__/integration/cold-start.test.ts')) {
        return { ok: false, detail: '__tests__/integration/cold-start.test.ts not written yet' };
      }
      const r = sh('npx vitest run --project integration --reporter dot __tests__/integration/cold-start.test.ts');
      return { ok: r.ok, detail: r.ok ? '' : tail(r.combined, 25) };
    },
  },
  {
    id: 6,
    phase: 2,
    title: 'Prompt parity: TypeScript builder == train/prompt.py, >=50 fixtures',
    run: () => vitestFile('__tests__/integration/prompt-parity.test.ts'),
  },
  {
    id: 7,
    phase: 2,
    title: 'Validator parity: validation.ts == train/validate.py, >=200 fixtures',
    run: () => {
      // a hand-edited generated lexicon would make the two validators disagree in ways
      // no fixture is sure to catch
      const lexicon = sh('node scripts/verify/build-lexicon.mjs --check');
      if (!lexicon.ok) return { ok: false, detail: tail(lexicon.combined, 10) };
      return vitestFile('__tests__/integration/validator-parity.test.ts');
    },
  },
  {
    id: 13,
    phase: 2,
    title: 'Python tests pass',
    run: () => {
      const missing = requireVenv();
      if (missing) return missing;
      const r = sh(`"${venvPython()}" -m pytest train/ -q`);
      return { ok: r.ok, detail: r.ok ? '' : tail(r.combined, 25) };
    },
  },
  {
    id: 14,
    phase: 2,
    title: 'Model eval: every FINE_TUNING 5.1 metric meets its gate',
    run: () => runNodeScript('scripts/verify/model-gates.mjs'),
  },
  {
    id: 15,
    phase: 2,
    title: 'Baselines: fine-tuned beats prompted base and templates',
    run: () => runNodeScript('scripts/verify/baselines.mjs'),
  },
  {
    id: 12,
    phase: 4,
    title: 'Accessibility statics and WCAG AA token pairs',
    run: () => runNodeScript('scripts/verify/a11y.mjs'),
  },
  {
    id: 16,
    phase: 5,
    title: 'Model artifact: real, correctly sized, parity-checked',
    run: () => runNodeScript('scripts/verify/artifact.mjs'),
  },
  {
    id: 17,
    phase: 4,
    title: 'Design baseline: redesign v2 is the only design (docs/REDESIGN.md)',
    run: () => runNodeScript('scripts/verify/design-baseline.mjs'),
  },
];

// read the shipped file name from executorchRuntime.ts so these checks test what the app loads
const runtimeSource = read('services', 'executorchRuntime.ts');
const modelFileMatch = runtimeSource.match(/^const MODEL_FILE_NAME = '([^']+)';/m);
if (!modelFileMatch) {
  throw new Error('services/executorchRuntime.ts: MODEL_FILE_NAME not found; checks 8 and 16 need it');
}
export const MODEL_FILE_NAME = modelFileMatch[1];
export const MODEL_ARTIFACT = repoPath('assets', 'model', MODEL_FILE_NAME);
