import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

type PackageInfo = { name: string; version: string; license?: string };

/** Notices follow the modules actually retained in the browser build, including lazy chunks. */
export function thirdPartyNotices(root: string): Plugin {
  return {
    name: 'third-party-notices',
    generateBundle(_options, bundle) {
      const directories = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const [id, module] of Object.entries(chunk.modules)) {
          if (!module.renderedLength) continue;
          const path = id.replaceAll('\\', '/').split('?')[0];
          const marker = path.lastIndexOf('/node_modules/');
          if (marker < 0) continue;
          const rest = path.slice(marker + '/node_modules/'.length).split('/');
          const name = rest.slice(0, rest[0].startsWith('@') ? 2 : 1).join('/');
          directories.add(path.slice(0, marker) + '/node_modules/' + name);
        }
      }
      const sections = [...directories].sort().map(directory => {
        const info: PackageInfo = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        const files = readdirSync(directory).filter(name => /^(licen[sc]e|notice|copying)(\.[^.]+)?$/i.test(name)).sort();
        const texts = files.map(name => `${name}\n${readFileSync(join(directory, name), 'utf8').trim()}`);
        // The published 9.6.1 npm artifact omits LICENSE; keep the verified upstream text.
        if (!files.some(name => /^licen[sc]e/i.test(name))) {
          if (info.name !== '@react-three/fiber' || info.version !== '9.6.1') {
            this.error(`Missing upstream license text for ${info.name}@${info.version}; verify its notices before distributing this build.`);
          }
          texts.push(readFileSync(join(root, 'licenses/react-three-fiber-9.6.1.txt'), 'utf8').trim());
        }
        if (info.name === 'katex') {
          texts.push(readFileSync(join(root, 'licenses/katex-fonts.txt'), 'utf8').trim());
        }
        return [`${info.name}@${info.version} (${info.license ?? 'see license text'})`, ...texts].join('\n\n');
      });
      this.emitFile({ type: 'asset', fileName: 'LICENSE', source: readFileSync(join(root, 'LICENSE'), 'utf8') });
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: [
        'Third-party notices — generated from the dependencies retained in this browser build.',
        'The project MIT license does not replace these upstream licenses. Keep this file with redistributed builds.',
        ...sections,
      ].join('\n\n' + '='.repeat(72) + '\n\n') + '\n' });
    },
  };
}
