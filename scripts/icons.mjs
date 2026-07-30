/**
 * Rasterises icons/icon.svg into the PNG sizes the manifest asks for.
 *
 *   npm run icons
 *
 * The PNGs are committed, so a normal `npm run build` never needs this and the
 * extension keeps its "no dependencies" property. Run it only after editing the
 * SVG.
 *
 * `sharp` is borrowed from a sibling project in this workspace rather than added
 * to package.json, which is how the other extensions here do it. If it cannot be
 * found the script says so and changes nothing; the existing PNGs stay valid.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.dirname(root);

/** Sibling projects that are known to carry a sharp install. */
const CANDIDATES = ['personal-website', 'pdf-explainer', 'grt-bus-time', 'pagepack-extension'];

function loadSharp() {
  for (const project of CANDIDATES) {
    try {
      const require = createRequire(path.join(workspace, project, 'package.json'));
      return require('sharp');
    } catch {
      // Try the next one.
    }
  }
  throw new Error(
    'icons: could not find a sharp install in any sibling project ' +
      `(looked in ${CANDIDATES.join(', ')}). Install it somewhere in the workspace, ` +
      'or re-export the PNGs by hand. The committed PNGs are still fine.',
  );
}

const sharp = loadSharp();
const svg = readFileSync(path.join(root, 'icons', 'icon.svg'));

// 16 and 32 for the toolbar, 48 for the extensions page, 128 for the store
// listing and the install prompt. Density is raised so the vector is sampled
// well above the target size before it is reduced.
for (const size of [16, 32, 48, 128]) {
  const file = `icon-${size}.png`;
  const info = await sharp(svg, { density: 512 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(path.join(root, 'icons', file));
  console.log(`${file}: ${info.width}x${info.height}, ${(info.size / 1024).toFixed(1)} kB`);
}
