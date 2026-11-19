export interface WidgetOptions {
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
