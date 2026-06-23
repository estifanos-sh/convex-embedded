import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { Block, PartialBlock } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/ariakit";
import { useCreateBlockNote, useEditorChange } from "@blocknote/react";
import type { FunctionReference } from "convex/server";
import {
  Clock3,
  FileText,
  History,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";

import type { EmbeddedConnectionState } from "@convex-dev/embedded/browser";

import { api } from "~convex/_generated/api";
import type { Id } from "~convex/_generated/dataModel";
import { client } from "./lib/client";
import { readQuery, type QueryState } from "./lib/query";

const diffDelayMs = 90;
const draftDebounceMs = 250;
const draftMaxLatencyMs = 1000;
const createDocumentMutation = api.documents.create;
const getDocument = api.documents.get;
const listDocuments = api.documents.list;
const writeDocumentMutation = api.documents.writeBody;
const savepointDocumentMutation = api.documents.savepoint;
const historyDocumentsQuery = api.documents.history;
const revisionDocumentQuery = api.documents.revision;
const restoreDocumentMutation = api.documents.restore;
const removeDocumentMutation = api.documents.remove;

type StoredDoc = Record<string, unknown>;

type RevisionWire = {
  revId: string;
  groupId: string;
  origin: "savepoint" | "conflict" | "rejected" | "displaced" | "delete";
  status: "active" | "retained" | "acknowledged";
  createdAt: number;
  deleted: boolean;
  value?: StoredDoc;
};

type EmbeddedRev = {
  revId: string;
  rootId: string;
  origin: "edit" | "peer" | "reroot" | "set" | "savepoint";
  status: "current" | "archived" | "conflict";
  updatedTime: number;
};

type EmbeddedRevEntry = { rev: EmbeddedRev; doc: StoredDoc | null };

type DocumentDoc = {
  _creationTime: number;
  _id: Id<"documents">;
  body: string;
  slug: string;
  title: string;
  updatedAt: number;
};

type DocumentSummary = {
  _creationTime: number;
  _id: Id<"documents">;
  slug: string;
  title: string;
  updatedAt: number;
};

type Baseline = {
  body: string;
  docId: Id<"documents">;
  revId?: string;
  title: string;
};

type DiffLine = {
  key: string;
  text: string;
  type: string;
};

type DiffEdit = {
  after: DiffLine;
  before: DiffLine;
};

type DiffResult = {
  added: DiffLine[];
  changed: DiffEdit[];
  removed: DiffLine[];
  total: number;
};

type SnapshotRow =
  | { kind: "added"; line: DiffLine }
  | { kind: "changed"; after: DiffLine; before: DiffLine }
  | { kind: "removed"; line: DiffLine }
  | { kind: "same"; line: DiffLine };

type HistoryPreview = {
  body: string;
  createdAt: number;
  delta: DiffResult | null;
  rev: EmbeddedRev;
  title: string;
};

type HistoryGroup = {
  count: number;
  latestTime: number;
  earliestTime: number;
  kind: "activity" | "snapshot" | "restore" | "conflict";
  rev: EmbeddedRev;
};

const emptyBlocks: PartialBlock[] = [
  {
    type: "heading",
    props: { level: 1 },
    content: "Untitled",
  },
  { type: "paragraph", content: "" },
];

export function App(): ReactElement {
  const editor = useCreateBlockNote({ initialContent: emptyBlocks });
  const [selectedDocumentId, setSelectedDocumentId] = useState<Id<"documents"> | null>(null);
  const documentsQuery = useEmbeddedQuery<DocumentSummary[]>(
    listDocuments,
    useMemo(() => ({}), []),
  );
  const selectedDocumentQuery = useEmbeddedQuery<DocumentDoc | null>(
    getDocument,
    useMemo(() => (selectedDocumentId ? { id: selectedDocumentId } : {}), [selectedDocumentId]),
    selectedDocumentId !== null,
  );
  const connection = useConnectionState();
  const bootError =
    connection.local === "failed"
      ? (connection.localError ?? "The local store failed to start.")
      : undefined;
  const queriedDocuments = documentsQuery.query === "ready" ? documentsQuery.value : [];
  const documentsError =
    documentsQuery.query === "failed"
      ? documentsQuery.error
      : selectedDocumentQuery.query === "failed"
        ? selectedDocumentQuery.error
        : undefined;
  const [createdFallback, setCreatedFallback] = useState<DocumentDoc | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [revs, setRevs] = useState<EmbeddedRev[]>([]);
  const [preview, setPreview] = useState<HistoryPreview | null>(null);
  const [selectedHistoryRevId, setSelectedHistoryRevId] = useState<string | null>(null);
  const [currentBody, setCurrentBody] = useState(JSON.stringify(emptyBlocks));
  const [currentDelta, setCurrentDelta] = useState<DiffResult | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const diffTimerRef = useRef<number | undefined>(undefined);
  const draftTrailingTimerRef = useRef<number | undefined>(undefined);
  const draftMaxTimerRef = useRef<number | undefined>(undefined);
  const draftPendingRef = useRef<{ body: string; document: DocumentDoc } | null>(null);
  const draftBodiesRef = useRef(new Map<Id<"documents">, string>());
  const draftWriteChainRef = useRef(Promise.resolve());
  const baselineRef = useRef<Baseline | null>(null);
  const previewCacheRef = useRef(new Map<string, HistoryPreview>());
  const selectedHistoryRevIdRef = useRef<string | null>(null);
  const lastAppliedBodyRef = useRef("");
  const lastAppliedDocIdRef = useRef<Id<"documents"> | null>(null);
  const applyingRemoteRef = useRef(false);
  const documents = queriedDocuments;

  useEffect(
    () =>
      client.onRuntimeEvent((event) => {
        if (event.degradation === "deployment-mismatch" && event.error) {
          setAppError(event.error);
        }
      }),
    [],
  );

  const selectedDocument =
    selectedDocumentQuery.query === "ready"
      ? selectedDocumentQuery.value
      : createdFallback?._id === selectedDocumentId
        ? createdFallback
        : null;
  const currentTitle = selectedDocument
    ? titleFromBlocks(parseBlocks(selectedDocument.body))
    : "No document selected";
  const currentRev = useMemo(() => currentRevFromList(revs), [revs]);
  const historyGroups = useMemo(() => groupSavedRevs(revs), [revs]);

  const setBaseline = useCallback(
    (next: Baseline | null, bodyForDiff = JSON.stringify(editor.document)) => {
      baselineRef.current = next;
      setCurrentDelta(next ? nonEmptyDelta(diffBodies(next.body, bodyForDiff)) : null);
    },
    [editor],
  );

  useEffect(() => {
    if (!documents.length) return;
    if (createdFallback && documents.some((item) => item._id === createdFallback._id)) {
      setCreatedFallback(null);
    }
    setSelectedDocumentId((current) => {
      if (
        current &&
        (documents.some((item) => item._id === current) || createdFallback?._id === current)
      ) {
        return current;
      }
      return documents[0]?._id ?? createdFallback?._id ?? null;
    });
  }, [createdFallback, documents]);

  useLayoutEffect(() => {
    if (!selectedDocument) return;
    const switchingDocuments = lastAppliedDocIdRef.current !== selectedDocument._id;
    if (!switchingDocuments && selectedDocument.body === lastAppliedBodyRef.current) return;
    if (diffTimerRef.current !== undefined) window.clearTimeout(diffTimerRef.current);
    applyingRemoteRef.current = true;
    editor.replaceBlocks(editor.document, parseBlocks(selectedDocument.body));
    lastAppliedBodyRef.current = selectedDocument.body;
    if (draftPendingRef.current?.document._id !== selectedDocument._id) {
      draftBodiesRef.current.set(selectedDocument._id, selectedDocument.body);
    }
    lastAppliedDocIdRef.current = selectedDocument._id;
    setCurrentBody(selectedDocument.body);
    if (switchingDocuments) {
      setPreview(null);
      setSelectedHistoryRevId(null);
      selectedHistoryRevIdRef.current = null;
      previewCacheRef.current.clear();
      setRevs([]);
      setBaseline(null, selectedDocument.body);
      setCurrentDelta(null);
    }
    queueMicrotask(() => {
      applyingRemoteRef.current = false;
    });
  }, [editor, selectedDocument, setBaseline]);

  const refreshHistory = useCallback(
    async (resetBaseline = false) => {
      if (!selectedDocument) return;
      const result = (await client.query(historyDocumentsQuery, {
        id: selectedDocument._id,
        cursor: null,
        numItems: 256,
      })) as { page: RevisionWire[] };
      const list = sortRevs(result.page.map(revisionFromWire));
      setRevs(list);
      if (!resetBaseline) return;
      const current = currentRevFromList(list);
      if (!current) {
        setBaseline(
          {
            body: selectedDocument.body,
            docId: selectedDocument._id,
            title: titleFromBlocks(parseBlocks(selectedDocument.body)),
          },
          JSON.stringify(editor.document),
        );
        return;
      }
      const revision = (await client.query(revisionDocumentQuery, {
        id: selectedDocument._id,
        revId: current.revId,
      })) as RevisionWire | null;
      const entry = revision ? entryFromRevision(revision) : null;
      const body = documentBody(entry?.doc) ?? selectedDocument.body;
      setBaseline(
        {
          body,
          docId: selectedDocument._id,
          revId: current.revId,
          title: documentTitle(entry?.doc) ?? titleFromBlocks(parseBlocks(selectedDocument.body)),
        },
        JSON.stringify(editor.document),
      );
    },
    [editor, selectedDocument, setBaseline],
  );

  useEffect(() => {
    if (!selectedDocument) return;
    void refreshHistory(true).catch((error) => setAppError(errorMessage(error)));
  }, [selectedDocument?._id]);

  useEffect(() => {
    if (!historyOpen || !selectedDocument) return;
    void refreshHistory(false).catch((error) => setAppError(errorMessage(error)));
  }, [historyOpen, selectedDocument?._id, refreshHistory]);

  const updateCurrentDelta = useCallback((body: string) => {
    const current = baselineRef.current;
    if (!current || current.docId !== lastAppliedDocIdRef.current) {
      setCurrentDelta(null);
      return;
    }
    setCurrentDelta(nonEmptyDelta(diffBodies(current.body, body)));
  }, []);

  const writeDraftDocument = useCallback(async (document: DocumentDoc, body: string) => {
    const previousBody = draftBodiesRef.current.get(document._id) ?? document.body;
    const bodySplice = textSplice(previousBody, body);
    if (bodySplice === undefined) return;
    draftBodiesRef.current.set(document._id, body);
    lastAppliedBodyRef.current = body;
    const title = titleFromBlocks(parseBlocks(body));
    await client.mutation(writeDocumentMutation, {
      id: document._id,
      splices: [bodySplice],
      ...(title === document.title ? {} : { title }),
    });
  }, []);

  const flushDraftDocument = useCallback(() => {
    if (draftTrailingTimerRef.current !== undefined) {
      window.clearTimeout(draftTrailingTimerRef.current);
      draftTrailingTimerRef.current = undefined;
    }
    if (draftMaxTimerRef.current !== undefined) {
      window.clearTimeout(draftMaxTimerRef.current);
      draftMaxTimerRef.current = undefined;
    }
    const pending = draftPendingRef.current;
    draftPendingRef.current = null;
    if (!pending) return;
    draftWriteChainRef.current = draftWriteChainRef.current
      .then(() => writeDraftDocument(pending.document, pending.body))
      .catch((error) => setAppError(errorMessage(error)));
  }, [writeDraftDocument]);

  const settleDraftDocument = useCallback(async () => {
    flushDraftDocument();
    await draftWriteChainRef.current;
  }, [flushDraftDocument]);

  const queueDraftDocument = useCallback(
    (document: DocumentDoc, body: string) => {
      draftPendingRef.current = { body, document };
      if (draftTrailingTimerRef.current !== undefined) {
        window.clearTimeout(draftTrailingTimerRef.current);
      }
      draftTrailingTimerRef.current = window.setTimeout(flushDraftDocument, draftDebounceMs);
      if (draftMaxTimerRef.current === undefined) {
        draftMaxTimerRef.current = window.setTimeout(flushDraftDocument, draftMaxLatencyMs);
      }
    },
    [flushDraftDocument],
  );

  useEditorChange((currentEditor) => {
    if (!selectedDocument || applyingRemoteRef.current) return;
    const body = JSON.stringify(currentEditor.document);
    setCurrentBody(body);
    if (diffTimerRef.current !== undefined) window.clearTimeout(diffTimerRef.current);
    diffTimerRef.current = window.setTimeout(() => updateCurrentDelta(body), diffDelayMs);
    if (body === lastAppliedBodyRef.current) return;
    queueDraftDocument(selectedDocument, body);
  }, editor);

  useEffect(() => {
    return () => {
      if (diffTimerRef.current !== undefined) window.clearTimeout(diffTimerRef.current);
      flushDraftDocument();
    };
  }, [flushDraftDocument]);

  useEffect(() => flushDraftDocument, [flushDraftDocument, selectedDocumentId]);

  useEffect(() => {
    const flush = (): void => flushDraftDocument();
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") flushDraftDocument();
    };
    window.addEventListener("blur", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flushDraftDocument]);

  const createDocument = useCallback(async () => {
    if (documentsQuery.query !== "ready") return;
    setAppError(null);
    try {
      const created = (await client.mutation(createDocumentMutation, {})) as DocumentDoc;
      setCreatedFallback(created);
      setSelectedDocumentId(created._id);
      setSearchQuery("");
    } catch (error) {
      setAppError(errorMessage(error));
    }
  }, [documentsQuery.query]);

  const deleteDocument = useCallback(async () => {
    if (!selectedDocument) return;
    setDeleteBusy(true);
    setAppError(null);
    const selectedIndex = documents.findIndex((item) => item._id === selectedDocument._id);
    const nextDocument = documents[selectedIndex + 1] ?? documents[selectedIndex - 1] ?? null;
    try {
      await settleDraftDocument();
      await client.mutation(removeDocumentMutation, { id: selectedDocument._id });
      setSelectedDocumentId(nextDocument?._id ?? null);
      if (createdFallback?._id === selectedDocument._id) setCreatedFallback(null);
      setHistoryOpen(false);
      setDeleteOpen(false);
    } catch (error) {
      setAppError(errorMessage(error));
    } finally {
      setDeleteBusy(false);
    }
  }, [createdFallback, documents, selectedDocument, settleDraftDocument]);

  const createSnapshot = useCallback(async () => {
    if (!selectedDocument) return;
    setHistoryBusy(true);
    setAppError(null);
    try {
      const body = JSON.stringify(editor.document);
      setCurrentBody(body);
      queueDraftDocument(selectedDocument, body);
      await settleDraftDocument();
      const revision = (await client.mutation(savepointDocumentMutation, {
        id: selectedDocument._id,
      })) as RevisionWire;
      const entry = entryFromRevision(revision);
      if (entry.doc) {
        const nextPreview = previewFromEntry(entry, undefined, null);
        previewCacheRef.current.set(nextPreview.rev.revId, nextPreview);
        selectedHistoryRevIdRef.current = nextPreview.rev.revId;
        setSelectedHistoryRevId(nextPreview.rev.revId);
        setPreview(nextPreview);
        setBaseline(
          {
            body: nextPreview.body,
            docId: selectedDocument._id,
            revId: nextPreview.rev.revId,
            title: nextPreview.title,
          },
          body,
        );
      }
      await refreshHistory(false);
    } catch (error) {
      setAppError(errorMessage(error));
    } finally {
      setHistoryBusy(false);
    }
  }, [editor, queueDraftDocument, refreshHistory, selectedDocument, setBaseline, settleDraftDocument]);

  const selectRev = useCallback(
    async (rev: EmbeddedRev) => {
      if (!selectedDocument) return;
      selectedHistoryRevIdRef.current = rev.revId;
      setSelectedHistoryRevId(rev.revId);
      setAppError(null);
      const cached = previewCacheRef.current.get(rev.revId);
      if (cached) {
        setPreview(cached);
        return;
      }
      setPreview(null);
      setHistoryBusy(true);
      try {
        const revision = (await client.query(revisionDocumentQuery, {
          id: selectedDocument._id,
          revId: rev.revId,
        })) as RevisionWire | null;
        const entry = revision ? entryFromRevision(revision) : null;
        if (selectedHistoryRevIdRef.current !== rev.revId) return;
        if (!entry) {
          setPreview(null);
          setAppError(`Snapshot from ${formatTime(rev.updatedTime)} could not be loaded.`);
          return;
        }
        const nextPreview = previewFromEntry(entry, rev);
        previewCacheRef.current.set(rev.revId, nextPreview);
        setPreview(nextPreview);
      } catch (error) {
        if (selectedHistoryRevIdRef.current === rev.revId) setAppError(errorMessage(error));
      } finally {
        setHistoryBusy(false);
      }
    },
    [selectedDocument],
  );

  const restorePreview = useCallback(async () => {
    if (!selectedDocument || !preview || preview.rev.status === "current") return;
    setHistoryBusy(true);
    setAppError(null);
    let queuedRemoteReset = false;
    try {
      await settleDraftDocument();
      if (diffTimerRef.current !== undefined) {
        window.clearTimeout(diffTimerRef.current);
        diffTimerRef.current = undefined;
      }
      applyingRemoteRef.current = true;
      const restored = (await client.mutation(restoreDocumentMutation, {
        id: selectedDocument._id,
        revId: preview.rev.revId,
      })) as { document: StoredDoc; revision: RevisionWire };
      const body = documentBody(restored.document) ?? preview.body;
      editor.replaceBlocks(editor.document, parseBlocks(body));
      lastAppliedBodyRef.current = body;
      setCurrentBody(body);
      queueMicrotask(() => {
        applyingRemoteRef.current = false;
      });
      queuedRemoteReset = true;
      setBaseline(
        {
          body,
          docId: selectedDocument._id,
          revId: restored.revision.revId,
          title: documentTitle(restored.document) ?? preview.title,
        },
        body,
      );
      await refreshHistory(true);
      setPreview(null);
      setSelectedHistoryRevId(null);
      selectedHistoryRevIdRef.current = null;
    } catch (error) {
      if (!queuedRemoteReset) applyingRemoteRef.current = false;
      setAppError(errorMessage(error));
    } finally {
      setHistoryBusy(false);
    }
  }, [editor, preview, refreshHistory, selectedDocument, setBaseline, settleDraftDocument]);

  const filteredDocuments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return documents;
    return documents.filter((document) => document.title.toLowerCase().includes(query));
  }, [documents, searchQuery]);

  return (
    <div className="demoShell">
      <DebugOverlay connection={connection} />
      <main className="demoMain">
        <div className="documentsLayout">
          <aside className="panel documentsSidebar">
            <div className="searchToolbar">
              <div className="searchRow">
                <div className="searchField">
                  <Search className="shrink-0" size={15} />
                  <input
                    aria-label="Search documents"
                    className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-content-primary placeholder:text-content-tertiary focus:ring-0"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search documents"
                    type="text"
                  />
                  {searchQuery ? (
                    <button
                      className="searchClear"
                      type="button"
                      aria-label="Clear search"
                      onClick={() => setSearchQuery("")}
                    >
                      <X size={14} />
                    </button>
                  ) : null}
                </div>
                <button
                  className="createButton"
                  type="button"
                  aria-label="Create document"
                  title="New document"
                  disabled={documentsQuery.query !== "ready"}
                  onClick={() => void createDocument()}
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>

            <div className="documentList">
              {bootError ? (
                <div className="documentListEmpty">Documents unavailable — {bootError}</div>
              ) : documentsQuery.query === "loading" ? (
                <div className="documentListEmpty">Loading documents</div>
              ) : documentsQuery.query === "failed" ? (
                <div className="documentListEmpty">Documents unavailable</div>
              ) : (
                filteredDocuments.map((document) => (
                  <DocumentRow
                    key={document._id}
                    active={document._id === selectedDocumentId}
                    document={document}
                    onSelect={() => setSelectedDocumentId(document._id)}
                  />
                ))
              )}
              {documentsQuery.query === "ready" && filteredDocuments.length === 0 ? (
                <div className="documentListEmpty">
                  {searchQuery ? "No matching documents." : "No documents yet."}
                </div>
              ) : null}
            </div>

            {appError || documentsError ? (
              <div className="sidebarError">{appError ?? errorMessage(documentsError)}</div>
            ) : null}
          </aside>

          <section className="panel documentPanel">
            <header className="panelHeader">
              <div className="documentPanelTitle">
                <FileText className="shrink-0" size={15} />
                <div>
                  <h2 className="truncate">{currentTitle}</h2>
                  <p>{selectedDocument ? "Saved automatically" : "Choose a document to begin"}</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <RemoteStatus connection={connection} />
                <button
                  className="iconButton"
                  type="button"
                  aria-label="Open snapshot history"
                  disabled={!selectedDocument}
                  onClick={() => {
                    if (selectedDocument) setHistoryOpen(true);
                  }}
                  title="Snapshot history"
                >
                  <History size={16} />
                </button>
                <button
                  className="iconButton danger"
                  type="button"
                  aria-label="Delete document"
                  disabled={!selectedDocument}
                  onClick={() => setDeleteOpen(true)}
                  title="Delete document"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </header>

            <div className="documentViewport">
              {selectedDocument ? (
                <div className="editor-shell documentEnter" key={selectedDocument._id}>
                  <BlockNoteView editor={editor} data-theming-css-demo />
                </div>
              ) : (
                <EmptyDocumentState
                  query={documentsQuery.query}
                  onCreate={() => void createDocument()}
                />
              )}
            </div>
          </section>
        </div>

        {historyOpen ? (
          <HistoryModal
            busy={historyBusy}
            currentBody={currentBody}
            currentDelta={currentDelta}
            currentRev={currentRev}
            currentTitle={currentTitle}
            error={appError}
            preview={preview}
            groups={historyGroups}
            selectedRevId={selectedHistoryRevId}
            onClose={() => setHistoryOpen(false)}
            onRefresh={() => void refreshHistory(true)}
            onRestore={() => void restorePreview()}
            onCreateSnapshot={() => void createSnapshot()}
            onSelect={(rev) => void selectRev(rev)}
            onSelectCurrent={() => {
              selectedHistoryRevIdRef.current = null;
              setSelectedHistoryRevId(null);
              setPreview(null);
              setAppError(null);
            }}
          />
        ) : null}
        {deleteOpen && selectedDocument ? (
          <DeleteDialog
            busy={deleteBusy}
            title={titleFromBlocks(parseBlocks(selectedDocument.body))}
            onCancel={() => setDeleteOpen(false)}
            onConfirm={() => void deleteDocument()}
          />
        ) : null}
      </main>
    </div>
  );
}

function useEmbeddedQuery<T>(
  query: FunctionReference<"query">,
  args: Record<string, unknown>,
  active = true,
): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ query: "loading" });
  const argsKey = JSON.stringify(args);

  useEffect(() => {
    if (!active) {
      setState({ query: "loading" });
      return;
    }
    setState({ query: "loading" });
    const watch = client.watchQuery(query, args);
    const read = () => setState(readQuery(() => watch.localQueryResult() as T | undefined));
    const unsubscribe = watch.onUpdate(read);
    read();
    return unsubscribe;
  }, [active, argsKey, query]);

  return state;
}

function useConnectionState(): EmbeddedConnectionState {
  const [state, setState] = useState<EmbeddedConnectionState>(() => client.connectionState());
  useEffect(() => {
    let active = true;
    let timer: number | undefined = window.setInterval(sync, 500);
    const unsubscribe = client.onRuntimeEvent(sync);
    sync();
    return () => {
      active = false;
      unsubscribe();
      if (timer !== undefined) window.clearInterval(timer);
    };
    function sync(): void {
      if (!active) return;
      const next = client.connectionState();
      setState(next);
      if (next.local !== "starting" && timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    }
  }, []);
  return state;
}

const debugEnabled =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");

function DebugOverlay(props: { connection: EmbeddedConnectionState }): ReactElement | null {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!debugEnabled) return;
    return client.subscribeInternalEvents((event) => {
      const stamp = new Date().toISOString().slice(11, 23);
      const summary = JSON.stringify(event).slice(0, 160);
      setLines((prior) => [...prior.slice(-19), `${stamp} ${summary}`]);
    });
  }, []);
  if (!debugEnabled) return null;
  const { connection } = props;
  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        maxHeight: "45vh",
        overflowY: "auto",
        background: "rgba(0,0,0,0.88)",
        color: "#7fdc7f",
        font: "10px/1.35 monospace",
        padding: "6px 8px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      <div style={{ color: "#fff" }}>
        {`local=${connection.local} remote=${connection.remote} localError=${connection.localError ?? "-"} remoteError=${connection.remote === "error" ? connection.remoteError : "-"} ua=${navigator.userAgent.slice(0, 80)}`}
      </div>
      {lines.map((line, index) => (
        <div key={index}>{line}</div>
      ))}
    </div>
  );
}

function RemoteStatus(props: { connection: EmbeddedConnectionState }): ReactElement | null {
  const { connection } = props;
  if (connection.remote === "disabled") return null;
  const remoteError = connection.remote === "error" ? connection.remoteError : undefined;
  const label =
    connection.remote === "ready"
      ? "Synced"
      : connection.remote === "starting"
        ? "Connecting"
        : connection.remote === "closed"
          ? "Offline"
          : "Sync error";
  return (
    <span
      className={`syncStatus syncStatus--${connection.remote}`}
      title={remoteError ?? label}
      aria-label={remoteError ? `Sync error: ${remoteError}` : label}
    >
      <span className="syncDot" aria-hidden="true" />
      {label}
    </span>
  );
}

function DocumentRow(props: {
  active: boolean;
  document: DocumentSummary;
  onSelect: () => void;
}): ReactElement {
  return (
    <button
      className={["documentRow", props.active ? "active" : ""].join(" ")}
      type="button"
      onClick={props.onSelect}
      title={props.document.title}
    >
      <FileText className="shrink-0 text-content-tertiary" size={15} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{props.document.title}</span>
        <span className="block truncate text-xs text-content-tertiary">
          {formatTime(props.document.updatedAt)}
        </span>
      </span>
    </button>
  );
}

function DeleteDialog(props: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
}): ReactElement {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !props.busy) props.onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.busy, props.onCancel]);

  return (
    <div
      className="dialogBackdrop"
      role="presentation"
      onMouseDown={props.busy ? undefined : props.onCancel}
    >
      <div
        aria-describedby="delete-document-description"
        aria-labelledby="delete-document-title"
        aria-modal="true"
        className="deleteDialog"
        role="alertdialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="deleteDialogIcon">
          <Trash2 size={18} />
        </div>
        <div>
          <h2 id="delete-document-title">Delete this document?</h2>
          <p id="delete-document-description">
            “{props.title}” will be permanently removed from this workspace.
          </p>
        </div>
        <div className="deleteDialogActions">
          <button
            ref={cancelRef}
            className="textButton"
            type="button"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            className="dangerButton"
            type="button"
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy ? <Loader2 className="animate-spin" size={14} /> : <Trash2 size={14} />}
            {props.busy ? "Deleting" : "Delete document"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyDocumentState(props: {
  query: QueryState<unknown>["query"];
  onCreate: () => void;
}): ReactElement {
  const loading = props.query === "loading";
  const failed = props.query === "failed";
  return (
    <div className="emptyDocumentState">
      <div>
        <FileText size={18} />
        <h1>
          {loading
            ? "Loading documents"
            : failed
              ? "Documents unavailable"
              : "No document selected"}
        </h1>
        <p>
          {loading
            ? "Checking the local store."
            : failed
              ? "The local store could not be read."
              : "Create a document to start writing locally."}
        </p>
        {props.query === "ready" ? (
          <button className="primaryCommand" type="button" onClick={props.onCreate}>
            <Plus size={15} />
            New document
          </button>
        ) : null}
      </div>
    </div>
  );
}

function HistoryModal(props: {
  busy: boolean;
  currentBody: string;
  currentDelta: DiffResult | null;
  currentRev: EmbeddedRev | null;
  currentTitle: string;
  error: string | null;
  onClose: () => void;
  onCreateSnapshot: () => void;
  onRefresh: () => void;
  onRestore: () => void;
  onSelect: (rev: EmbeddedRev) => void;
  onSelectCurrent: () => void;
  preview: HistoryPreview | null;
  groups: HistoryGroup[];
  selectedRevId: string | null;
}): ReactElement {
  const viewingDraft = props.selectedRevId === null;
  const loadingSelectedVersion =
    props.selectedRevId !== null && props.preview === null && props.busy;
  const canRestore = props.preview !== null && props.preview.rev.status !== "current";
  const detailTitle = props.preview?.title ?? props.currentTitle;
  const detailBody = props.preview?.body ?? props.currentBody;
  const detailTime = props.preview
    ? `Snapshot from ${formatTime(props.preview.createdAt)}`
    : loadingSelectedVersion
      ? "Loading snapshot"
      : props.currentDelta
        ? "Live local document with snapshot changes"
        : "Live local document";

  return (
    <div className="historyModal" role="dialog" aria-modal="true" aria-label="Snapshot history">
      <div className="historyModalShell panel">
        <div className="historyPreview">
          <div className="panelHeader">
            <div>
              <h2>{detailTitle}</h2>
              <p>{detailTime}</p>
            </div>
          </div>
          <div className="historyPreviewBody">
            {loadingSelectedVersion ? (
              <div className="historyLoading">
                <Loader2 className="animate-spin" size={16} />
                Loading snapshot
              </div>
            ) : (
              <SnapshotDocument body={detailBody} delta={null} />
            )}
          </div>
        </div>

        <aside className="historySidebar">
          <div className="panelHeader">
            <div>
              <h2>Snapshot history</h2>
              <p>
                {props.groups.length} {props.groups.length === 1 ? "entry" : "entries"}
              </p>
            </div>
            <button
              className="iconButton"
              type="button"
              aria-label="Close snapshot history"
              onClick={props.onClose}
            >
              <X size={16} />
            </button>
          </div>

          <div className="historyToolbar">
            <button
              className="primaryCommand"
              type="button"
              disabled={props.busy}
              onClick={props.onCreateSnapshot}
            >
              {props.busy ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}
              Create snapshot
            </button>
            <button
              className="iconButton"
              type="button"
              onClick={props.onRefresh}
              aria-label="Refresh history"
              title="Refresh"
            >
              <History size={15} />
            </button>
          </div>

          <div className="historyRows">
            {props.error ? <div className="historyError">{props.error}</div> : null}
            <p className="historyGroupLabel">Live</p>
            <button
              className={["historyRow", viewingDraft ? "active" : ""].join(" ")}
              type="button"
              onClick={props.onSelectCurrent}
            >
              <FileText size={15} />
              <span>
                <strong>{props.currentDelta ? "Local edits" : "Current document"}</strong>
                <small>
                  {props.currentDelta
                    ? diffSummary(props.currentDelta)
                    : props.currentRev
                      ? `Updated ${formatTime(props.currentRev.updatedTime)}`
                      : "No snapshot baseline yet"}
                </small>
              </span>
            </button>

            <p className="historyGroupLabel">Snapshots</p>
            <div>
              {props.groups.map((group) => (
                <button
                  key={group.rev.revId}
                  type="button"
                  className={[
                    "historyRow",
                    props.selectedRevId === group.rev.revId ? "active" : "",
                  ].join(" ")}
                  onClick={() => props.onSelect(group.rev)}
                >
                  {group.kind === "activity" ? <Clock3 size={15} /> : <Save size={15} />}
                  <span>
                    <strong>{historyGroupTitle(group)}</strong>
                    <small>{historyGroupSubtitle(group)}</small>
                  </span>
                </button>
              ))}
              {props.groups.length === 0 ? <p className="historyEmpty">No snapshots yet.</p> : null}
            </div>
          </div>

          <div className="historyActions">
            {canRestore ? (
              <button
                className="primaryCommand"
                type="button"
                disabled={props.busy}
                onClick={props.onRestore}
              >
                <RotateCcw size={15} />
                Restore snapshot
              </button>
            ) : (
              <p>
                {props.selectedRevId === null
                  ? "Select a snapshot to preview or restore it."
                  : loadingSelectedVersion
                    ? "Loading selected snapshot."
                    : "Selected snapshot could not be restored."}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SnapshotDocument(props: { body: string; delta: DiffResult | null }): ReactElement {
  if (props.delta) {
    return (
      <article className="mx-auto max-w-3xl px-8 py-12 md:px-12">
        {snapshotRows(props.body, props.delta).map((row, index) => (
          <SnapshotDiffRow key={snapshotRowKey(row, index)} row={row} />
        ))}
      </article>
    );
  }

  return (
    <article className="mx-auto max-w-3xl px-8 py-12 md:px-12">
      {parseBlocks(props.body).map((block, index) => (
        <SnapshotBlock key={snapshotKey(block, index)} block={block} depth={0} />
      ))}
    </article>
  );
}

function SnapshotDiffRow(props: { row: SnapshotRow }): ReactElement {
  if (props.row.kind === "changed") {
    return (
      <div className="snapshotDiffRow changed">
        <SnapshotLine line={props.row.before} marker="-" tone="removed" />
        <SnapshotLine line={props.row.after} marker="+" tone="added" />
      </div>
    );
  }
  if (props.row.kind === "added") {
    return (
      <div className="snapshotDiffRow added">
        <SnapshotLine line={props.row.line} marker="+" tone="added" />
      </div>
    );
  }
  if (props.row.kind === "removed") {
    return (
      <div className="snapshotDiffRow removed">
        <SnapshotLine line={props.row.line} marker="-" tone="removed" />
      </div>
    );
  }
  return <SnapshotLine line={props.row.line} marker="" tone="same" />;
}

function SnapshotLine(props: {
  line: DiffLine;
  marker: "" | "+" | "-";
  tone: string;
}): ReactElement {
  const content = props.line.text || `Empty ${props.line.type}`;
  const isHeading = props.line.type === "heading";
  const isBullet = props.line.type === "bulletListItem";
  return (
    <div
      className={[
        "snapshotLine",
        isHeading ? "heading" : "",
        isBullet ? "bullet" : "",
        props.tone,
      ].join(" ")}
    >
      <span>{props.marker}</span>
      <div>
        {isHeading ? (
          <h1>{content}</h1>
        ) : isBullet ? (
          <p>
            <span>•</span>
            {content}
          </p>
        ) : (
          <p>{content}</p>
        )}
      </div>
    </div>
  );
}

function SnapshotBlock(props: { block: PartialBlock | Block; depth: number }): ReactElement {
  const text = blockText(props.block);
  const type = String(props.block.type ?? "paragraph");
  const children = (props.block as { children?: unknown }).children;
  const nested = Array.isArray(children) ? (children as readonly (PartialBlock | Block)[]) : [];

  let content: ReactElement;
  if (type === "heading") {
    const level = headingLevel(props.block);
    const Tag: "h1" | "h2" | "h3" = level <= 1 ? "h1" : level === 2 ? "h2" : "h3";
    const className =
      level <= 1
        ? "mb-8 mt-1 font-display text-4xl font-bold leading-tight text-content-primary md:text-5xl"
        : "mb-4 mt-8 font-display text-2xl font-bold leading-tight text-content-primary";
    content = <Tag className={className}>{text || "Untitled"}</Tag>;
  } else if (type === "bulletListItem") {
    content = (
      <div className="mb-2 flex gap-3 text-[1.05rem] leading-8 text-content-secondary">
        <span className="mt-0.5 text-content-tertiary">•</span>
        <p>{text}</p>
      </div>
    );
  } else {
    content = <p className="mb-4 text-[1.05rem] leading-8 text-content-secondary">{text}</p>;
  }

  return (
    <div style={{ marginLeft: props.depth ? props.depth * 18 : undefined }}>
      {content}
      {nested.map((child, index) => (
        <SnapshotBlock key={snapshotKey(child, index)} block={child} depth={props.depth + 1} />
      ))}
    </div>
  );
}

function snapshotKey(block: PartialBlock | Block, index: number): string {
  const id = (block as { id?: unknown }).id;
  return typeof id === "string" ? id : `snapshot:${index}`;
}

function headingLevel(block: PartialBlock | Block): number {
  const level = (block as { props?: { level?: unknown } }).props?.level;
  return typeof level === "number" ? level : 1;
}

function snapshotRows(body: string, delta: DiffResult): SnapshotRow[] {
  const added = new Set(delta.added.map((line) => line.key));
  const changed = new Map(delta.changed.map((edit) => [edit.after.key, edit]));
  const rows: SnapshotRow[] = flattenBlocks(parseBlocks(body)).map((line) => {
    const edit = changed.get(line.key);
    if (edit) return { kind: "changed", before: edit.before, after: edit.after };
    if (added.has(line.key)) return { kind: "added", line };
    return { kind: "same", line };
  });
  rows.push(...delta.removed.map((line) => ({ kind: "removed" as const, line })));
  return rows;
}

function snapshotRowKey(row: SnapshotRow, index: number): string {
  if (row.kind === "changed") return `changed:${row.after.key}`;
  return `${row.kind}:${row.line.key}:${index}`;
}

function sortRevs(list: readonly EmbeddedRev[]): EmbeddedRev[] {
  return [...list].sort((a, b) => b.updatedTime - a.updatedTime);
}

function revisionFromWire(revision: RevisionWire): EmbeddedRev {
  const conflict =
    revision.origin === "conflict" ||
    revision.origin === "rejected" ||
    revision.origin === "displaced";
  return {
    revId: revision.revId,
    rootId: revision.groupId,
    origin:
      revision.origin === "savepoint"
        ? "savepoint"
        : revision.origin === "displaced"
          ? "set"
          : "reroot",
    status: revision.status === "active" ? "current" : conflict ? "conflict" : "archived",
    updatedTime: revision.createdAt,
  };
}

function entryFromRevision(revision: RevisionWire): EmbeddedRevEntry {
  return {
    rev: revisionFromWire(revision),
    doc: revision.deleted ? null : (revision.value ?? null),
  };
}

function currentRevFromList(list: readonly EmbeddedRev[]): EmbeddedRev | null {
  return list.find((rev) => rev.status === "current") ?? null;
}

function groupSavedRevs(list: readonly EmbeddedRev[]): HistoryGroup[] {
  const saved = list.filter((rev) => rev.status !== "current");
  const groups: HistoryGroup[] = [];
  for (const rev of saved) {
    const previous = groups[groups.length - 1];
    const kind = revGroupKind(rev);
    if (
      kind === "activity" &&
      previous &&
      previous.kind === "activity" &&
      previous.rev.rootId === rev.rootId
    ) {
      previous.count += 1;
      previous.earliestTime = rev.updatedTime;
      continue;
    }
    groups.push({
      count: 1,
      latestTime: rev.updatedTime,
      earliestTime: rev.updatedTime,
      kind,
      rev,
    });
  }
  return groups;
}

function revGroupKind(rev: EmbeddedRev): HistoryGroup["kind"] {
  if (rev.status === "conflict") return "conflict";
  if (rev.origin === "edit" || rev.origin === "peer") return "activity";
  if (rev.origin === "reroot" || rev.origin === "set") return "restore";
  return "snapshot";
}

function historyGroupTitle(group: HistoryGroup): string {
  switch (group.kind) {
    case "activity":
      return group.count > 1 ? `${group.count} edits` : "Edit";
    case "conflict":
      return "Conflict copy";
    case "restore":
      return "Restored version";
    default:
      return "Snapshot";
  }
}

function historyGroupSubtitle(group: HistoryGroup): string {
  if (group.kind === "activity" && group.count > 1) {
    const earliest = formatTime(group.earliestTime);
    const latest = formatTime(group.latestTime);
    return earliest === latest ? latest : `${earliest} – ${latest}`;
  }
  return formatTime(group.latestTime);
}

function previewFromEntry(
  entry: EmbeddedRevEntry,
  fallback?: EmbeddedRev,
  delta: DiffResult | null = null,
): HistoryPreview {
  const body = documentBody(entry.doc) ?? JSON.stringify(emptyBlocks);
  const title = documentTitle(entry.doc) || titleFromBlocks(parseBlocks(body));
  return {
    body,
    createdAt: fallback?.updatedTime ?? entry.rev.updatedTime,
    delta,
    rev: fallback ?? entry.rev,
    title,
  };
}

function documentBody(doc: StoredDoc | null | undefined): string | null {
  const body = docField(doc, "body");
  return typeof body === "string" ? body : null;
}

function documentTitle(doc: StoredDoc | null | undefined): string | null {
  const title = docField(doc, "title");
  return typeof title === "string" ? title : null;
}

function docField(doc: StoredDoc | null | undefined, field: string): unknown {
  return doc ? (doc as Record<string, unknown>)[field] : undefined;
}

function parseBlocks(body: string): PartialBlock[] {
  try {
    const parsed = JSON.parse(body) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as PartialBlock[]) : emptyBlocks;
  } catch {
    return emptyBlocks;
  }
}

function diffBodies(beforeBody: string, afterBody: string): DiffResult {
  return diffBlocks(parseBlocks(beforeBody), parseBlocks(afterBody));
}

function diffBlocks(
  before: readonly (PartialBlock | Block)[],
  after: readonly (PartialBlock | Block)[],
): DiffResult {
  const beforeLines = flattenBlocks(before);
  const afterLines = flattenBlocks(after);
  const useKeys =
    beforeLines.every((line) => !line.key.startsWith("pos:")) &&
    afterLines.every((line) => !line.key.startsWith("pos:"));
  return useKeys ? keyedDiff(beforeLines, afterLines) : positionalDiff(beforeLines, afterLines);
}

function keyedDiff(before: DiffLine[], after: DiffLine[]): DiffResult {
  const beforeByKey = new Map(before.map((line) => [line.key, line]));
  const afterByKey = new Map(after.map((line) => [line.key, line]));
  const added = after.filter((line) => !beforeByKey.has(line.key));
  const removed = before.filter((line) => !afterByKey.has(line.key));
  const changed = after.flatMap((line) => {
    const previous = beforeByKey.get(line.key);
    return previous && !sameLine(previous, line) ? [{ before: previous, after: line }] : [];
  });
  return { added, changed, removed, total: added.length + changed.length + removed.length };
}

function positionalDiff(before: DiffLine[], after: DiffLine[]): DiffResult {
  const added: DiffLine[] = [];
  const removed: DiffLine[] = [];
  const changed: DiffEdit[] = [];
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    const previous = before[index];
    const next = after[index];
    if (previous === undefined && next !== undefined) added.push(next);
    else if (previous !== undefined && next === undefined) removed.push(previous);
    else if (previous !== undefined && next !== undefined && !sameLine(previous, next)) {
      changed.push({ before: previous, after: next });
    }
  }
  return { added, changed, removed, total: added.length + changed.length + removed.length };
}

function flattenBlocks(blocks: readonly (PartialBlock | Block)[], prefix = ""): DiffLine[] {
  return blocks.flatMap((block, index) => {
    const rawId = (block as { id?: unknown }).id;
    const key = typeof rawId === "string" ? rawId : `pos:${prefix}${index}`;
    const line = {
      key,
      text: blockText(block).trim(),
      type: String(block.type ?? "paragraph"),
    };
    const children = (block as { children?: unknown }).children;
    const nested = Array.isArray(children)
      ? flattenBlocks(children as readonly (PartialBlock | Block)[], `${prefix}${index}.`)
      : [];
    return [line, ...nested];
  });
}

function sameLine(before: DiffLine, after: DiffLine): boolean {
  return before.text === after.text && before.type === after.type;
}

function nonEmptyDelta(delta: DiffResult): DiffResult | null {
  return delta.total > 0 ? delta : null;
}

function diffSummary(delta: DiffResult): string {
  const parts = [
    delta.added.length ? `${delta.added.length} added` : "",
    delta.changed.length ? `${delta.changed.length} edited` : "",
    delta.removed.length ? `${delta.removed.length} removed` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "No changes";
}

function textSplice(
  before: string,
  after: string,
): { delete: number; index: number; insert: string } | undefined {
  if (before === after) return undefined;
  const beforeChars = Array.from(before);
  const afterChars = Array.from(after);
  let prefix = 0;
  const prefixLimit = Math.min(beforeChars.length, afterChars.length);
  while (prefix < prefixLimit && beforeChars[prefix] === afterChars[prefix]) prefix += 1;

  let suffix = 0;
  const suffixLimit = Math.min(beforeChars.length - prefix, afterChars.length - prefix);
  while (
    suffix < suffixLimit &&
    beforeChars[beforeChars.length - 1 - suffix] === afterChars[afterChars.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    delete: beforeChars.length - prefix - suffix,
    index: prefix,
    insert: afterChars.slice(prefix, afterChars.length - suffix).join(""),
  };
}

function titleFromBlocks(blocks: readonly (PartialBlock | Block)[]): string {
  for (const block of blocks) {
    const text = blockText(block).trim();
    if (text) return text.slice(0, 90);
  }
  return "Untitled";
}

function blockText(block: PartialBlock | Block): string {
  const content = "content" in block ? block.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "text" in item) {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
