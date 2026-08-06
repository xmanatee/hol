import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const productionAssetUrl = ({ label, pattern, minBytes = 0, maxBytes = Number.MAX_SAFE_INTEGER }) => {
  const assetsDirectory = resolve(process.cwd(), 'dist/assets');
  const matches = readdirSync(assetsDirectory)
    .filter((name) => pattern.test(name))
    .filter((name) => {
      const bytes = statSync(resolve(assetsDirectory, name)).size;
      return bytes >= minBytes && bytes <= maxBytes;
    });
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label} production asset, found ${matches.length}`);
  }
  return `/assets/${matches[0]}`;
};
