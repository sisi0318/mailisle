import type { Cursor, Folder, FolderRole, MailFlags, MailMetadata, FlagUpdate, MoveReceipt, SendInput } from '@mail/shared';

export type SyncSink = {
  knownUids: number[];
  begin(uidValidity: string): void;
  messages(records: MailMetadata[]): void;
  flags(records: MailFlags[]): void;
};

export interface MailAdapter {
  connect(): Promise<void>;
  verifySmtp(): Promise<void>;
  close(): Promise<void>;
  listFolders(): Promise<{ path: string; name: string; role: FolderRole }[]>;
  sync(folder: Folder, sink: SyncSink): Promise<{ cursor: Cursor; uids: number[] }>;
  source(folder: Folder, uid: number): Promise<Buffer>;
  flags(folder: Folder, uid: number, update: FlagUpdate): Promise<void>;
  move(folder: Folder, uid: number, destination: string): Promise<MoveReceipt>;
  send(input: SendInput, sentPath?: string): Promise<{ messageId: string; warning?: string }>;
  watchInbox(onChange: () => void, onError: (error: Error) => void): Promise<() => void>;
}
