// mirrors venvPythonRelative() in scripts/verify/lib.mjs, which typed tests cannot import
export const VENV_PYTHON =
  process.platform === 'win32' ? 'train/.venv/Scripts/python.exe' : 'train/.venv/bin/python';
