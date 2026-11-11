import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { changeMasterPassword } from './password-change';

async function main() {
  const envFile = resolve('.env');
  const env = parseEnv(readFileSync(envFile, 'utf8'));
  await requireStopped(env.MAIL_HOST || '127.0.0.1', Number(env.MAIL_PORT || 3000));
  const generated = process.argv.includes('--generate');
  const password = generated ? randomBytes(24).toString('base64url') : await promptPassword();
  const entryDir = dirname(fileURLToPath(import.meta.url));
  const migrations = existsSync(join(entryDir, 'migrations')) ? join(entryDir, 'migrations') : resolve('packages/db/migrations');
  const result = await changeMasterPassword(envFile, migrations, password);
  console.log(`已重新加密 ${result.accounts} 个邮箱的凭据，邮件和草稿保留。`);
  console.log(`新密码已写入 ${envFile}。${generated ? '请在本机打开该文件查看，不会在终端打印密码。' : ''}`);
  console.log(`旧数据库与配置已备份到 ${result.backupDir}。现在可以重新启动信屿。`);
}

async function promptPassword() {
  if (!process.stdin.isTTY) throw new Error('请在本机交互终端运行，或使用 --generate 生成随机密码');
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stdout.write('新主密码（输入不回显）：'); const password = await prompt.question('');
    process.stdout.write('\n再次输入：'); const confirm = await prompt.question(''); process.stdout.write('\n');
    if (password !== confirm) throw new Error('两次密码不一致，未修改数据库');
    return password;
  } finally { prompt.close(); }
}

async function requireStopped(host: string, port: number) {
  const target = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const listening = await new Promise<boolean>(resolveListening => {
    const socket = createConnection({ host: target, port, timeout: 1000 });
    socket.once('connect', () => { socket.destroy(); resolveListening(true); });
    socket.once('error', () => resolveListening(false));
    socket.once('timeout', () => { socket.destroy(); resolveListening(false); });
  });
  if (listening) throw new Error('请先停止信屿后再修改主密码，避免运行中的进程继续写入旧密钥加密的凭据');
}

void main().catch(error => { console.error(error.message); process.exitCode = 1; });
