import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const collect = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`SBOM command exited with status ${code}`));
      }
    });
  });

const main = async () => {
  const output = await collect('npm', ['sbom', '--package-lock-only', '--sbom-format', 'cyclonedx']);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/sbom.cdx.json', output);
  console.log('Generated artifacts/sbom.cdx.json');
};

main();
