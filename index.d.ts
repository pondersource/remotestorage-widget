/** App-owned guest documents, including data outside the remoteStorage cache. */
export interface GuestData {
  export(): Promise<{ filename: string; type: string; body: BlobPart }>;
  /** Resolve only after validation and local persistence complete. */
  import(file: File): Promise<void | { message?: string }>;
  accept?: string;
  /** Return false to cancel connection without losing the guest session. */
  beforeConnect?(): Promise<boolean | void>;
}
export interface WidgetOptions {
  guestData?: GuestData;
  lwsOpenID?: { issuer: string; clientId: string; redirectUri: string; idTokenSigningAlg?: string };
  solidProviders?: { providers?: { name: string; authURL: string }[]; allowAnyProvider?: boolean };
  leaveOpen?: boolean;
  autoCloseAfter?: number;
  skipInitial?: boolean;
  logging?: boolean;
  modalBackdrop?: boolean | 'onlySmallScreens';
}
export default class Widget {
  constructor(remoteStorage: unknown, options?: WidgetOptions);
  attach(element?: string | HTMLElement): void;
  destroy(): void;
  open(): void;
  close(): void;
  toggle(): void;
  static SOLID_COMMUNITY: { name: string; authURL: string };
  static INRUPT: { name: string; authURL: string };
}
