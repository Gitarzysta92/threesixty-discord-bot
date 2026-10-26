import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('./', import.meta.url);
const plugins = { 'channel-policy': 'threesixty-channel-policy', 'kuma-status': 'threesixty-kuma-status' };
const install = Object.entries(plugins).map(([source, target]) => {
  const files = Object.fromEntries(['index.mjs', 'openclaw.plugin.json', 'package.json']
    .map(name => [name, readFileSync(new URL(`${source}/${name}`, root)).toString('base64')]));
  return `        fs.mkdirSync(dir + '/${target}', {recursive: true});\n        for (const [name, body] of Object.entries(${JSON.stringify(files)})) fs.writeFileSync(dir + '/${target}/' + name, Buffer.from(body, 'base64'));`;
}).join('\n');
const rendered = readFileSync(new URL('compose.template.yaml', root), 'utf8').replace('        // LOCAL_PLUGIN_FILES', install);
writeFileSync(new URL('compose.yaml', root), rendered);
