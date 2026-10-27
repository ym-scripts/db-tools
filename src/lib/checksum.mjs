// SHA-256 sidecar files (<backup>.sha256), compatible with `sha256sum -c`.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function writeChecksum(file) {
  await writeFile(`${file}.sha256`, `${await sha256File(file)}  ${basename(file)}\n`);
}

/** true = matches, false = mismatch, null = no checksum file. */
export async function verifyChecksum(file) {
  if (!existsSync(`${file}.sha256`)) return null;
  const expected = (await readFile(`${file}.sha256`, 'utf8')).trim().split(/\s+/)[0];
  return expected === (await sha256File(file));
}
