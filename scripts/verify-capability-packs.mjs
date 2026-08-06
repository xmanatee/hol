import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { listCapabilityPacks } from '../src/runtime/capabilityPacks.js';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const main = async () => {
  const packs = listCapabilityPacks();
  const ids = new Set();

  for (const pack of packs) {
    if (ids.has(pack.id)) {
      throw new Error(`Duplicate capability pack id: ${pack.id}`);
    }
    ids.add(pack.id);

    if (
      pack.schemaVersion !== 1 ||
      !pack.version ||
      !pack.label ||
      !pack.activation ||
      !pack.budget ||
      typeof pack.required !== 'boolean' ||
      pack.totalBytes !== pack.assets.reduce((total, asset) => total + asset.bytes, 0)
    ) {
      throw new Error(`Capability pack ${pack.id} has incomplete runtime metadata`);
    }

    for (const asset of pack.assets) {
      if (
        !asset.kind ||
        !asset.mediaType ||
        !asset.license ||
        !asset.source ||
        !asset.io ||
        !asset.sha256 ||
        !asset.bytes
      ) {
        throw new Error(`Capability asset ${asset.id} has incomplete provenance metadata`);
      }

      const path = fileURLToPath(asset.url);
      const [contents, fileStat] = await Promise.all([readFile(path), stat(path)]);
      if (fileStat.size !== asset.bytes) {
        throw new Error(`${asset.id} size mismatch: expected ${asset.bytes}, received ${fileStat.size}`);
      }
      const digest = sha256(contents);
      if (digest !== asset.sha256) {
        throw new Error(`${asset.id} SHA-256 mismatch: expected ${asset.sha256}, received ${digest}`);
      }
    }
  }

  console.log(
    `Verified ${packs.length} capability packs and ${packs.flatMap((pack) => pack.assets).length} assets`,
  );
};

main();
