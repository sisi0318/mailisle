import { createServer, type Socket, type AddressInfo } from 'node:net';
import { once } from 'node:events';

// A local SASL endpoint: capture the bytes sent by ImapFlow/Nodemailer, never deliver mail externally.
export async function oauthMailServer() {
  const sockets = new Set<Socket>();
  const logins: { protocol: string; user: string; token: string }[] = [];
  const messages: string[] = [];
  let rejectAuth = false;
  const servers = (['imap', 'smtp'] as const).map(protocol => createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.write(protocol === 'imap' ? '* OK local OAuth test server\r\n' : '220 local OAuth SMTP\r\n');
    let pending = ''; let idleTag = ''; let data: string[] | undefined;
    socket.on('data', chunk => {
      pending += chunk.toString();
      let end: number;
      while ((end = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 2);
        if (data) {
          if (line === '.') { messages.push(data.join('\r\n')); data = undefined; socket.write('250 queued locally\r\n'); }
          else data.push(line);
          continue;
        }
        const auth = /^(?:(\S+) AUTHENTICATE|AUTH) XOAUTH2 (\S+)$/.exec(line);
        if (auth) {
          const decoded = Buffer.from(auth[2], 'base64').toString();
          const fields = /^user=([^\x01]+)\x01auth=Bearer ([^\x01]+)\x01\x01$/.exec(decoded);
          if (fields) logins.push({ protocol, user: fields[1], token: fields[2] });
          socket.write(fields && !rejectAuth ? auth[1] ? `${auth[1]} OK authenticated\r\n` : '235 2.7.0 authenticated\r\n'
            : auth[1] ? `${auth[1]} NO auth rejected\r\n` : '535 5.7.8 auth rejected\r\n');
          continue;
        }
        if (protocol === 'smtp') {
          if (/^EHLO /.test(line)) socket.write('250-local\r\n250 AUTH XOAUTH2\r\n');
          else if (line === 'DATA') { data = []; socket.write('354 send data\r\n'); }
          else if (line === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('250 OK\r\n');
          continue;
        }
        if (line === 'DONE') { socket.write(`${idleTag} OK IDLE done\r\n`); continue; }
        const [tag, command] = line.split(' ');
        if (command === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1 AUTH=XOAUTH2 SASL-IR IDLE\r\n${tag} OK capability\r\n`);
        else if (command === 'LIST' || command === 'LSUB') socket.write(`* LIST (\\Inbox) "/" "INBOX"\r\n${tag} OK list\r\n`);
        else if (command === 'SELECT' || command === 'EXAMINE') socket.write(`* FLAGS (\\Seen)\r\n* 0 EXISTS\r\n* OK [UIDVALIDITY 1]\r\n* OK [UIDNEXT 1]\r\n${tag} OK [READ-WRITE] selected\r\n`);
        else if (command === 'UID' && line.includes(' SEARCH')) socket.write(`* SEARCH\r\n${tag} OK searched\r\n`);
        else if (command === 'IDLE') { idleTag = tag; socket.write('+ idling\r\n'); }
        else if (command === 'LOGOUT') socket.end(`* BYE\r\n${tag} OK logout\r\n`);
        else socket.write(`${tag} OK done\r\n`);
      }
    });
  }));
  for (const server of servers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  return { logins, messages, imapPort: (servers[0].address() as AddressInfo).port, smtpPort: (servers[1].address() as AddressInfo).port,
    rejectAuthentication(value: boolean) { rejectAuth = value; },
    async close() { for (const socket of sockets) socket.destroy(); await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); } };
}
