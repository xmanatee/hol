import { readFile } from 'node:fs/promises';
import { getCapabilityAsset } from '../src/runtime/capabilityPacks.js';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;

const main = async () => {
  const asset = getCapabilityAsset('face', 'hol-face-meshopt');
  const bytes = await readFile(new URL(asset.url));
  if (bytes.readUInt32LE(0) !== GLB_MAGIC || bytes.readUInt32LE(16) !== JSON_CHUNK) {
    throw new Error('Head asset is not a valid binary glTF 2.0 file');
  }

  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(
    bytes
      .subarray(20, 20 + jsonLength)
      .toString()
      .replace(/\0+$/, ''),
  );
  const morphMesh = document.meshes.find((mesh) => mesh.primitives?.[0]?.targets?.length === 52);
  if (!morphMesh || morphMesh.extras?.targetNames?.length !== 52) {
    throw new Error('Head asset must preserve all 52 named facial morph targets');
  }
  if (!document.extensionsRequired?.includes('EXT_meshopt_compression')) {
    throw new Error('Head asset must use required Meshopt compression');
  }

  console.log(`Verified compressed head asset: ${bytes.length} bytes, 52 morph targets`);
};

main();
