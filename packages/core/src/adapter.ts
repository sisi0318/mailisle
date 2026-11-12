import type { Address, Cursor, Folder, FolderRole, MailFlags, MailMetadata, FlagUpdate, MoveReceipt, SendInput } from '@mail/shared';
import type { OutgoingAttachment } from './uploads';

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
  listFolders(): Promise<{ path: string; name: string; role: FolderRole; delimiter?: string | null }[]>;
  sync(folder: Folder, sink: SyncSink): Promise<{ cursor: Cursor; uids: number[] }>;
  source(folder: Folder, uid: number): Promise<Buffer>;
  bodyText(folder: Folder, uid: number): Promise<string>;
  copyRecipients(folder: Folder, uid: number): Promise<Address[]>;
  flags(folder: Folder, uid: number, update: FlagUpdate): Promise<void>;
  markAllRead(folder: Folder): Promise<{ uidValidity: string; uidNext: number }>;
  createFolder(name: string, parent?: Folder): Promise<string>;
  deleteFolder(folder: Folder): Promise<void>;
  move(folder: Folder, uid: number, destination: string): Promise<MoveReceipt>;
  send(input: SendInput, sentPath?: string, attachments?: OutgoingAttachment[]): Promise<{ messageId: string; warning?: string }>;
  watchInbox(onChange: () => void, onError: (error: Error) => void): Promise<() => void>;
}
