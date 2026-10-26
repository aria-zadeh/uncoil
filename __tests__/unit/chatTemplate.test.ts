import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// the model was trained and evaluated with the LF template. a CRLF one tokenizes
// differently, so eval numbers would not describe what ships
const root = join(__dirname, '..', '..');
const shipped = JSON.parse(readFileSync(join(root, 'assets/model/tokenizer_config.rnejson'), 'utf8')) as {
  chat_template: string;
};

describe('shipped chat template', () => {
  it('has no carriage returns', () => {
    expect(shipped.chat_template.includes('\r')).toBe(false);
  });

  const trained = join(root, 'train/out/v12-360m/best/chat_template.jinja');
  it.skipIf(!existsSync(trained))('matches the template the model was trained with', () => {
    expect(shipped.chat_template.trim()).toBe(readFileSync(trained, 'utf8').trim());
  });
});
