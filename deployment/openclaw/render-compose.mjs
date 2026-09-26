import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('./', import.meta.url);
const files = Object.fromEntries(['index.mjs', 'openclaw.plugin.json', 'package.json'].map(name => [name, readFileSync(new URL('channel-policy/' + name, root), 'utf8')]));
const install = `        const policyFiles = ${JSON.stringify(files)};\n        fs.mkdirSync(dir + '/threesixty-channel-policy', {recursive: true});\n        for (const [name, body] of Object.entries(policyFiles)) fs.writeFileSync(dir + '/threesixty-channel-policy/' + name, body);`;
const rendered = readFileSync(new URL('compose.template.yaml', root), 'utf8').replace('        // CHANNEL_POLICY_PLUGIN_FILES', install);
writeFileSync(new URL('compose.yaml', root), rendered);
