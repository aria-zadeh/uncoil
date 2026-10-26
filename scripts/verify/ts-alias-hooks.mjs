// resolves the `@/` alias for plain `node` runs. node strips TS types but ignores
// tsconfig `paths`, and this lets verify scripts import services/templates.ts directly.
// keep it identical to the tsconfig mapping, `@/* -> ./*`
import { statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolvePath(import.meta.dirname, '..', '..');
const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '.cjs'];

// existsSync is true for directories, and `@/types` resolving to the directory
// throws ERR_UNSUPPORTED_DIR_IMPORT
function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function firstExisting(base) {
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (isFile(candidate)) return candidate;
  }
  for (const extension of EXTENSIONS) {
    if (extension === '') continue;
    const candidate = join(base, `index${extension}`);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (!specifier.startsWith('@/')) return next(specifier, context);

  const target = firstExisting(join(ROOT, specifier.slice(2)));
  if (target === null) {
    throw new Error(`cannot resolve ${specifier} under ${ROOT}`);
  }
  return next(pathToFileURL(target).href, context);
}
