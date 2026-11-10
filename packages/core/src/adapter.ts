import type { Cursor, Folder, FolderRole, MailMetadata, FlagUpdate, SendInput } from '@mail/shared';

export interface MailAdapter {
  connect(): Promise<void>;
  verifySmtp(): Promise<void>;
  close(): Promise<void>;
  listFolders(): Promise<{ path: string; name: string; role: FolderRole }[]>;
  sync(folder: Folder, begin: (validity: string) => void, batch: (records: MailMetadata[]) => void): Promise<{ cursor: Cursor; uids: number[] }>;
  source(folder: Folder, uid: number): Promise<Buffer>;
  flags(folder: Folder, uid: number, update: FlagUpdate): Promise<void>;
  move(folder: Folder, uid: number, destination: string): Promise<void>;
  send(input: SendInput, sentPath?: string): Promise<{ messageId: string; warning?: string }>;
  watchInbox(onChange: () => void, onError: (error: Error) => void): Promise<() => void>;
}
