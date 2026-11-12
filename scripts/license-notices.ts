import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import supplements from '../legal/supplements.json';

type Package = { name: string; paths: string[]; license: string; author?: string; homepage?: string };
type Component = { name: string; version: string; license: string; author: string; homepage?: string; notice: string };
const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'apps/web/public/legal');

async function main() {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const groups = JSON.parse(input) as Record<string, Package[]> & { error?: { message: string } };
  if (groups.error) throw new Error(groups.error.message);
  const packages = Object.values(groups).flat() as Package[];
  if (!packages.length) throw new Error('未取得生产依赖的许可信息');
  await mkdir(output, { recursive: true });
  const components: Component[] = []; const allNotices: string[] = [];
  const seen = new Set<string>();
  for (const pkg of packages.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    for (const path of pkg.paths) {
      const metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as { version: string };
      const id = `${pkg.name}@${metadata.version}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const files = await licenseFiles(path);
      const extra = supplements.find(item => item.name === pkg.name && item.version === metadata.version);
      const license = extra?.license ?? pkg.license;
      const parts = [`${id}\nLicense: ${license}\nAuthor(s): ${pkg.author ?? 'See included notices'}\n${pkg.homepage ?? ''}`];
      for (const file of files) parts.push(`--- ${relative(path, file).replaceAll('\\', '/')} ---\n${await readFile(file, 'utf8')}`);
      if (!files.length && !extra) throw new Error(`${id} 缺少许可文件，请核对上游并补充 legal/supplements.json`);
      if (extra) {
        parts.push(`Source: ${extra.source}\n${await readFile(join(root, 'legal', extra.file), 'utf8')}`);
      }
      if (pkg.name === 'dompurify') parts.push((await readFile(join(path, 'dist/purify.js'), 'utf8')).split('\n')[0]);
      const notice = `component-${createHash('sha256').update(id).digest('hex').slice(0, 16)}.txt`;
      const text = parts.join('\n\n');
      await writeFile(join(output, notice), text);
      components.push({ name: pkg.name, version: metadata.version, license, author: pkg.author ?? '', homepage: webLink(pkg.homepage), notice });
      allNotices.push(text);
      if (pkg.name === 'better-sqlite3') {
        const header = await readFile(join(path, 'deps/sqlite3/sqlite3.h'), 'utf8');
        const version = header.match(/#define SQLITE_VERSION\s+"([^"]+)"/)?.[1];
        if (!version) throw new Error('无法识别随 better-sqlite3 分发的 SQLite 版本');
        const sqliteNotice = `SQLite ${version}\nhttps://sqlite.org/copyright.html\nBundled with ${id}\n\n${header.slice(0, header.indexOf('** This header file'))}`;
        const sqliteFile = `sqlite-${version}.txt`;
        await writeFile(join(output, sqliteFile), sqliteNotice);
        components.push({ name: 'SQLite', version, license: 'Public Domain', author: 'SQLite contributors', homepage: 'https://sqlite.org/copyright.html', notice: sqliteFile });
        allNotices.push(sqliteNotice);
      }
    }
  }
  const thunderbird = `${await readFile(join(root, 'legal/THUNDERBIRD.md'), 'utf8')}\n\n${await readFile(join(root, 'legal/MPL-2.0.txt'), 'utf8')}`;
  await writeFile(join(output, 'thunderbird.txt'), thunderbird);
  components.push({ name: 'Thunderbird OAuth 配置摘录', version: 'MailIsle adaptation', license: 'MPL-2.0', author: 'Mozilla / Thunderbird contributors', homepage: 'https://www.thunderbird.net/', notice: 'thunderbird.txt' });
  allNotices.push(thunderbird);
  await copyFile(join(root, 'packages/core/src/oauth-presets.ts'), join(output, 'oauth-presets.ts.txt'));
  await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE.txt'));
  await copyFile(join(root, 'NOTICE'), join(output, 'NOTICE.txt'));
  await writeFile(join(output, 'index.json'), JSON.stringify({ components }));
  await writeFile(join(output, 'THIRD-PARTY-NOTICES.txt'), `${await readFile(join(root, 'NOTICE'), 'utf8')}\n\n${allNotices.join('\n\n========================================\n\n')}`);
  console.log(`已生成 ${components.length} 项上游组件声明。`);
}

async function licenseFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) files.push(...await licenseFiles(join(directory, entry.name)));
    else if (entry.isFile() && /(^|[.\-_])(licen[cs]e|copying|notice|copyright)([.\-_]|$)/i.test(entry.name)) files.push(join(directory, entry.name));
  }
  return files.sort();
}
function webLink(value?: string) {
  if (!value) return undefined;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
await main();
