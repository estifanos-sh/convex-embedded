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

export type EditorProps = {
  active: boolean;
  closeEditor: () => Promise<void>;
  document: EditorDocument;
  documentWrite: DocumentWriteAction;
  editorReady: (token: string) => Promise<void>;
  editorToken: string;
};
