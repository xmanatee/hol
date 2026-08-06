import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateAnnotatedVisionFixtureManifest } from '../src/cv/annotatedVisionFixtureManifest.js';
import { listCapabilityPacks } from '../src/runtime/capabilityPacks.js';

const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'ISC',
  'MIT',
  'MPL-2.0',
]);
const annotatedManifestPath = fileURLToPath(
  new URL('../tests/fixtures/annotated-vision/manifest.json', import.meta.url),
);

const main = async () => {
  const sbom = JSON.parse(await readFile('artifacts/sbom.cdx.json', 'utf8'));
  const rejected = [];
  for (const component of sbom.components || []) {
    const records = component.licenses || [];
    if (records.length === 0) {
      rejected.push(component.name + '@' + component.version + ': missing license');
    }
    for (const record of records) {
      const license = record.license?.id || record.license?.name || record.expression;
      if (!ALLOWED_LICENSES.has(license)) {
        rejected.push(component.name + '@' + component.version + ': ' + (license || 'missing license'));
      }
    }
  }

  for (const asset of listCapabilityPacks().flatMap((pack) => pack.assets)) {
    if (!ALLOWED_LICENSES.has(asset.license)) {
      rejected.push(asset.id + ': ' + asset.license);
    }
  }

  const annotatedManifest = validateAnnotatedVisionFixtureManifest(
    JSON.parse(await readFile(annotatedManifestPath, 'utf8')),
  );
  for (const fixture of annotatedManifest.fixtures) {
    for (const [component, provenance] of Object.entries(fixture.provenance)) {
      if (!ALLOWED_LICENSES.has(provenance.license)) {
        rejected.push(`${fixture.id}/${component}: ${provenance.license}`);
      }
    }
  }

  if (rejected.length) {
    throw new Error('Non-approved dependency licenses:\n' + rejected.join('\n'));
  }
  console.log(
    'Verified open-source licenses for ' +
      (sbom.components?.length || 0) +
      ' dependency components, all capability assets, and all annotated benchmark fixtures',
  );
};

main();
