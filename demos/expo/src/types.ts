export type TextSplice = {
  delete: number;
  index: number;
  insert: string;
};

export type EditorDocument = {
  body: string;
  id: string;
  title: string;
};

export type EditorDraft = Pick<EditorDocument, "body" | "title">;

export type DocumentWrite = {
  id: string;
  splices: TextSplice[];
  title?: string;
};

export type DocumentWriteAction = (write: DocumentWrite) => Promise<void>;

export type EditorSaveState = "dirty" | "error" | "recovered" | "saved" | "saving";

export type EditorStatusPayload = {
  error: string | null;
  recoveryUnavailable: boolean;
  state: EditorSaveState;
  titleRevision: number;
};

export type EditorReadyPayload = EditorStatusPayload & {
  title: string;
  token: string;
};

export type EditorProps = {
  active: boolean;
  closeRequest: number;
  document: EditorDocument;
  documentWrite: DocumentWriteAction;
  editorReady: (payload: EditorReadyPayload) => Promise<void>;
  editorStatusChanged: (token: string, payload: EditorStatusPayload) => Promise<void>;
  editorToken: string;
  focusBodyRequest: number;
  retryRequest: number;
  title: string;
  titleRevision: number;
};
