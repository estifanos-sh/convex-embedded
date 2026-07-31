import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { Block, PartialBlock } from "@blocknote/core";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/ariakit";
import {
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
  useEditorChange,
} from "@blocknote/react";
import type { FunctionReference } from "convex/server";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  Cloud,
  CloudOff,
  FileText,
  History,
  Loader2,
  Paperclip,
  Pin,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import {
  createConvexEmbeddedUploadFetch,
  type EmbeddedConnectionState,
} from "@convex-dev/embedded/browser";
import { createTextField } from "@convex-dev/embedded/internal/text";
import type { TextFieldWriter } from "@convex-dev/embedded/internal/text";

import { api } from "~convex/_generated/api";
import type { Id } from "~convex/_generated/dataModel";
import { pinned as pinnedDocumentsQuery, toggle as togglePinMutation } from "~local/pins";
import {
  expanded as expandedDocumentsQuery,
  toggleExpanded as toggleExpandedMutation,
} from "~local/view";
import { client, subscribeBrowserDebug } from "./lib/client";
import { readQuery, type QueryState } from "./lib/query";

const diffDelayMs = 90;
const createDocumentMutation = api.documents.write;
const getDocument = api.documents.read;
const listDocuments = api.documents.read;
const writeDocumentMutation = api.documents.write;
const savepointDocumentMutation = api.rev.savepoint;
const historyDocumentsQuery = api.remote.history;
const revisionDocumentQuery = api.remote.revision;
const restoreDocumentMutation = api.remote.restore;
const removeDocumentMutation = api.documents.del;
const fileAttachMutation = api.files.attach;
const fileUploadUrlMutation = api.files.generateUploadUrl;
const fileHostedUrlQuery = api.remote.hostedUrl;
const fileUrlQuery = api.files.resolve;
const embeddedFilePath = "/__convex_embedded/file/";
const uploadFetch = createConvexEmbeddedUploadFetch(client);

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

type UploadNotice = {
  fileName: string;
  phase: "saving" | "local" | "syncing" | "synced" | "failed";
  token?: string;
};

type SlashPaletteState = { blockId: string; query: string; x: number; y: number };
type SlashPaletteItem = ReturnType<typeof getDefaultReactSlashMenuItems>[number];
type MediaBlockType = "audio" | "file" | "image" | "video";
type PendingUploadBlock = {
  blockId: string;
  documentId: Id<"documents">;
  type: MediaBlockType;
};

const uploadAccept = "image/*,audio/*,video/*,application/pdf,text/plain";
const mediaUploadAccept: Record<MediaBlockType, string> = {
  audio: "audio/*",
  file: "*/*",
  image: "image/*",
  video: "video/*",
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
  const [selectedDocumentId, setSelectedDocumentId] = useState<Id<"documents"> | null>(null);
  const selectedDocumentIdRef = useRef(selectedDocumentId);
  selectedDocumentIdRef.current = selectedDocumentId;
  const [appError, setAppError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<UploadNotice | null>(null);
  const uploadNoticeRef = useRef<UploadNotice | null>(null);
  const uploadVerifyRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadBlockRef = useRef<PendingUploadBlock | null>(null);
  const documentPanelRef = useRef<HTMLElement | null>(null);
  const slashFrameRef = useRef<number | undefined>(undefined);
  const writeUploadNotice = useCallback((notice: UploadNotice | null) => {
    uploadNoticeRef.current = notice;
    setUploadNotice(notice);
  }, []);
  const uploadFile = useCallback(
    async (file: File): Promise<string> => {
      uploadVerifyRef.current = null;
      const documentId = selectedDocumentIdRef.current;
      if (documentId === null) throw new Error("Choose a document before attaching a file.");
      if (file.size > 8 * 1024 * 1024) throw new Error("Choose a file smaller than 8 MB.");
      writeUploadNotice({ fileName: file.name, phase: "saving" });
      try {
        const uploadUrl = (await client.mutation(fileUploadUrlMutation, {})) as string;
        const response = await uploadFetch(uploadUrl, {
          body: file,
          headers: { "content-type": file.type || "application/octet-stream" },
          method: "POST",
        });
        if (!response.ok) throw new Error(await uploadResponseError(response));
        const { storageId } = (await response.json()) as { storageId: string };
        if (selectedDocumentIdRef.current !== documentId) {
          throw new Error("The active document changed before the file was attached.");
        }
        const token = crypto.randomUUID();
        await client.mutation(fileAttachMutation, {
          contentType: file.type || "application/octet-stream",
          documentId,
          name: file.name,
          size: file.size,
          storageId: storageId as Id<"_storage">,
          token,
        });
        writeUploadNotice({ fileName: file.name, phase: "local", token });
        return `${embeddedFilePath}${encodeURIComponent(token)}`;
      } catch (error) {
        writeUploadNotice({ fileName: file.name, phase: "failed" });
        throw error;
      }
    },
    [writeUploadNotice],
  );
  const resolveFileUrl = useCallback(async (url: string) => {
    const token = embeddedFileToken(url);
    if (token === null) return url;
    const resolved = (await client.query(fileUrlQuery, { token })) as string | null;
    if (resolved !== null && isLocalFileUrl(resolved)) return resolved;
    const hosted = new URL("/attachment", globalThis.location.origin);
    hosted.searchParams.set("token", token);
    return hosted.href;
  }, []);
  const editor = useCreateBlockNote({ initialContent: emptyBlocks, resolveFileUrl, uploadFile });
  const [slashPalette, setSlashPalette] = useState<SlashPaletteState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashItems = useMemo(
    () =>
      slashPalette
        ? filterSuggestionItems(getDefaultReactSlashMenuItems(editor), slashPalette.query)
        : [],
    [editor, slashPalette],
  );
  const [mobilePane, setMobilePane] = useState<"documents" | "editor">("documents");
  const documentsQuery = useEmbeddedQuery<DocumentSummary[]>(
    listDocuments,
    useMemo(() => ({}), []),
  );
  const selectedDocumentQuery = useEmbeddedQuery<DocumentDoc[]>(
    getDocument,
    useMemo(() => (selectedDocumentId ? { id: selectedDocumentId } : {}), [selectedDocumentId]),
    selectedDocumentId !== null,
  );
  const pinnedQuery = usePinnedDocumentIds();
  const pinnedIds = useMemo(
    () => new Set(pinnedQuery.query === "ready" ? pinnedQuery.value : []),
    [pinnedQuery],
  );
  const togglePin = useCallback(async (documentId: Id<"documents">) => {
    try {
      await client.mutation(togglePinMutation, { documentId });
    } catch (error) {
      setAppError(errorMessage(error));
    }
  }, []);
  const expandedQuery = useExpandedDocumentIds();
  const expandedIds = useMemo(
    () => new Set(expandedQuery.query === "ready" ? expandedQuery.value : []),
    [expandedQuery],
  );
  const toggleExpanded = useCallback(async (documentId: Id<"documents">) => {
    try {
      await client.mutation(toggleExpandedMutation, { documentId });
    } catch (error) {
      setAppError(errorMessage(error));
    }
  }, []);
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
  const diffTimerRef = useRef<number | undefined>(undefined);
  const fieldRef = useRef<TextFieldWriter | null>(null);
  const settlingRef = useRef(false);
  const queryDocsRef = useRef(new Map<Id<"documents">, { body: string; title: string }>());
  const desiredBodyRef = useRef("");
  const baselineRef = useRef<Baseline | null>(null);
  const previewCacheRef = useRef(new Map<string, HistoryPreview>());
  const selectedHistoryRevIdRef = useRef<string | null>(null);
  const snapshotPendingRef = useRef(false);
  const lastAppliedBodyRef = useRef("");
  const lastAppliedDocIdRef = useRef<Id<"documents"> | null>(null);
  const applyingRemoteRef = useRef(false);
  const documents = queriedDocuments;
  const orderedDocuments = useMemo(() => {
    if (pinnedIds.size === 0) return documents;
    return [
      ...documents.filter((document) => pinnedIds.has(document._id)),
      ...documents.filter((document) => !pinnedIds.has(document._id)),
    ];
  }, [documents, pinnedIds]);

  useEffect(
    () =>
      client.onRuntimeEvent((event) => {
        if (event.degradation === "deployment-mismatch" && event.error) {
          setAppError(event.error);
        }
      }),
    [],
  );

  useEffect(
    () =>
      client.subscribeInternalEvents((event) => {
        if (event.type !== "remote" || event.tick === undefined) return;
        const pending = event.tick.pending?.uploads;
        if (pending === undefined) return;
        const current = uploadNoticeRef.current;
        if (current === null || current.phase === "failed" || current.phase === "synced") return;
        if (pending > 0 && current.phase === "local") {
          writeUploadNotice({ ...current, phase: "syncing" });
          return;
        }
        if (
          event.status === "idle" &&
          pending === 0 &&
          current.phase !== "saving" &&
          current.token !== undefined &&
          uploadVerifyRef.current !== current.token
        ) {
          const { fileName, token } = current;
          uploadVerifyRef.current = token;
          void client
            .query(fileHostedUrlQuery, { token })
            .then((url) => {
              if (typeof url !== "string" || uploadNoticeRef.current?.token !== token) return;
              writeUploadNotice({ fileName, phase: "synced", token });
            })
            .catch(() => {
              if (uploadVerifyRef.current === token) uploadVerifyRef.current = null;
            });
        }
      }),
    [writeUploadNotice],
  );

  const selectedQueryDocument =
    selectedDocumentQuery.query === "ready" ? (selectedDocumentQuery.value[0] ?? null) : null;
  const selectedDocument =
    selectedQueryDocument?._id === selectedDocumentId
      ? selectedQueryDocument
      : createdFallback?._id === selectedDocumentId
        ? createdFallback
        : null;
  const selectedDocumentPending =
    selectedDocumentId !== null &&
    (selectedDocumentQuery.query === "loading" ||
      (selectedQueryDocument !== null && selectedQueryDocument._id !== selectedDocumentId));
  const keepsPreviousEditor =
    selectedDocumentPending && lastAppliedDocIdRef.current !== null && selectedDocument === null;
  const selectedSummary = documents.find((document) => document._id === selectedDocumentId);
  const currentTitle = selectedDocument
    ? titleFromBlocks(parseBlocks(selectedDocument.body))
    : selectedDocumentPending
      ? (selectedSummary?.title ?? titleFromBlocks(editor.document))
      : "No document selected";
  const titleBlock = editor.document.at(0);
  const editableTitle =
    (selectedDocument || keepsPreviousEditor) && titleBlock ? blockText(titleBlock) : currentTitle;
  const currentRev = useMemo(() => currentRevFromList(revs), [revs]);
  const historyGroups = useMemo(() => groupSavedRevs(revs), [revs]);
  const historyConnected = connection.remote === "ready" || connection.remote === "connected";

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
      return orderedDocuments[0]?._id ?? createdFallback?._id ?? null;
    });
  }, [createdFallback, documents, orderedDocuments]);

  useLayoutEffect(() => {
    editor.isEditable = selectedDocument !== null;
  }, [editor, selectedDocument !== null]);

  useLayoutEffect(() => {
    if (!selectedDocument) return;
    queryDocsRef.current.set(selectedDocument._id, {
      body: selectedDocument.body,
      title: selectedDocument.title,
    });
    const switchingDocuments = lastAppliedDocIdRef.current !== selectedDocument._id;
    if (!switchingDocuments && selectedDocument.body === lastAppliedBodyRef.current) return;
    if (diffTimerRef.current !== undefined) window.clearTimeout(diffTimerRef.current);
    applyingRemoteRef.current = true;
    editor.replaceBlocks(editor.document, parseBlocks(selectedDocument.body));
    lastAppliedBodyRef.current = selectedDocument.body;
    if (!switchingDocuments) fieldRef.current?.adopt(selectedDocument.body);
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
    if (!selectedDocument || !historyOpen || !historyConnected) return;
    void refreshHistory(true).catch((error) => setAppError(errorMessage(error)));
  }, [historyConnected, historyOpen, refreshHistory, selectedDocument]);

  useEffect(() => {
    if (!selectedDocument || !historyOpen || !historyConnected) return;
    const watch = client.watchQuery(historyDocumentsQuery, {
      id: selectedDocument._id,
      cursor: null,
      numItems: 256,
    });
    const read = () => {
      try {
        const result = watch.localQueryResult() as { page: RevisionWire[] } | undefined;
        if (result) setRevs(sortRevs(result.page.map(revisionFromWire)));
      } catch (error) {
        setAppError(errorMessage(error));
      }
    };
    const unsubscribe = watch.onUpdate(read);
    read();
    return unsubscribe;
  }, [historyConnected, historyOpen, selectedDocument]);

  const updateCurrentDelta = useCallback((body: string) => {
    const current = baselineRef.current;
    if (!current || current.docId !== lastAppliedDocIdRef.current) {
      setCurrentDelta(null);
      return;
    }
    setCurrentDelta(nonEmptyDelta(diffBodies(current.body, body)));
  }, []);

  useLayoutEffect(() => {
    if (selectedDocumentId === null) return;
    const docId = selectedDocumentId;
    const field = createTextField<DocumentDoc>({
      read: () => queryDocsRef.current.get(docId)?.body ?? "",
      write: async (splice, base) => {
        const body = desiredBodyRef.current;
        lastAppliedBodyRef.current = body;
        const title = titleFromBlocks(parseBlocks(body));
        const stored = queryDocsRef.current.get(docId);
        return (await client.mutation(writeDocumentMutation, {
          id: docId,
          splices: [{ index: splice.index, delete: splice.delete, insert: splice.insert, base }],
          ...(stored && title === stored.title ? {} : { title }),
        })) as DocumentDoc;
      },
      extract: (result) => result.body,
    });
    fieldRef.current = field;
    return () => {
      field.flush();
      field.close();
      if (fieldRef.current === field) fieldRef.current = null;
    };
  }, [editor, selectedDocumentId]);

  const settleDraftDocument = useCallback(async () => {
    await fieldRef.current?.settle();
  }, []);

  const watchSettle = useCallback(() => {
    const field = fieldRef.current;
    if (field === null || settlingRef.current) return;
    if (!field.isDirty && !field.isSettling) return;
    settlingRef.current = true;
    void field
      .settle()
      .catch((error: unknown) => setAppError(errorMessage(error)))
      .finally(() => {
        settlingRef.current = false;
      });
  }, []);

  const updateSlashPalette = useCallback(
    (currentEditor: typeof editor) => {
      const query = slashQueryFromEditor(currentEditor);
      if (slashFrameRef.current !== undefined) window.cancelAnimationFrame(slashFrameRef.current);
      if (query === null) {
        setSlashPalette(null);
        return;
      }
      const blockId = currentEditor.getTextCursorPosition().block.id;
      slashFrameRef.current = window.requestAnimationFrame(() => {
        const panel = documentPanelRef.current?.getBoundingClientRect();
        const selection = window.getSelection();
        const cursor =
          selection && selection.rangeCount > 0
            ? selection.getRangeAt(0).getBoundingClientRect()
            : undefined;
        const panelWidth = panel?.width ?? window.innerWidth;
        const panelHeight = panel?.height ?? window.innerHeight;
        const x = Math.max(
          12,
          Math.min(
            (cursor?.left ?? (panel?.left ?? 0) + 48) - (panel?.left ?? 0),
            panelWidth - 372,
          ),
        );
        const y = Math.max(
          70,
          Math.min(
            (cursor?.bottom ?? (panel?.top ?? 0) + 120) - (panel?.top ?? 0) + 8,
            panelHeight - 340,
          ),
        );
        setSlashPalette((current) => {
          if (current?.query !== query || current.blockId !== blockId) setSlashIndex(0);
          return { blockId, query, x, y };
        });
      });
    },
    [editor],
  );

  const runSlashItem = useCallback(
    (item: SlashPaletteItem) => {
      const block =
        (slashPalette ? editor.getBlock(slashPalette.blockId) : undefined) ??
        editor.getTextCursorPosition().block;
      editor.setTextCursorPosition(block);
      setSlashPalette(null);
      const menu = editor.dictionary.slash_menu;
      const mediaType: MediaBlockType | null =
        item.title === menu.image.title
          ? "image"
          : item.title === menu.video.title
            ? "video"
            : item.title === menu.audio.title
              ? "audio"
              : item.title === menu.file.title
                ? "file"
                : null;
      if (mediaType !== null) {
        const documentId = selectedDocumentIdRef.current;
        if (documentId === null) return;
        editor.updateBlock(block, { content: "" });
        pendingUploadBlockRef.current = { blockId: block.id, documentId, type: mediaType };
        const input = uploadInputRef.current;
        if (input !== null) {
          input.accept = mediaUploadAccept[mediaType];
          input.click();
        }
        return;
      }
      if (slashPalette?.query) editor.updateBlock(block, { content: "/" });
      item.onItemClick();
    },
    [editor, slashPalette],
  );

  useEffect(() => {
    if (slashPalette === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashPalette(null);
      } else if (event.key === "ArrowDown" && slashItems.length > 0) {
        event.preventDefault();
        setSlashIndex((current) => (current + 1) % slashItems.length);
      } else if (event.key === "ArrowUp" && slashItems.length > 0) {
        event.preventDefault();
        setSlashIndex((current) => (current - 1 + slashItems.length) % slashItems.length);
      } else if (event.key === "Enter" && slashItems[slashIndex]) {
        event.preventDefault();
        runSlashItem(slashItems[slashIndex]);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [runSlashItem, slashIndex, slashItems, slashPalette]);

  useEditorChange((currentEditor) => {
    if (!selectedDocument || applyingRemoteRef.current) return;
    updateSlashPalette(currentEditor);
    const body = JSON.stringify(currentEditor.document);
    setCurrentBody(body);
    if (diffTimerRef.current !== undefined) window.clearTimeout(diffTimerRef.current);
    diffTimerRef.current = window.setTimeout(() => updateCurrentDelta(body), diffDelayMs);
    if (body === lastAppliedBodyRef.current) return;
    desiredBodyRef.current = body;
    fieldRef.current?.queue(body);
    watchSettle();
  }, editor);

  useEffect(() => {
    return () => {
      if (diffTimerRef.current !== undefined) window.clearTimeout(diffTimerRef.current);
      if (slashFrameRef.current !== undefined) window.cancelAnimationFrame(slashFrameRef.current);
    };
  }, []);

  useEffect(() => {
    const flush = (): void => fieldRef.current?.flush();
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") fieldRef.current?.flush();
    };
    window.addEventListener("blur", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const createDocument = useCallback(async () => {
    if (documentsQuery.query !== "ready") return;
    setAppError(null);
    try {
      const created = (await client.mutation(createDocumentMutation, {})) as DocumentDoc;
      setCreatedFallback(created);
      setSelectedDocumentId(created._id);
      setMobilePane("editor");
      setSearchQuery("");
    } catch (error) {
      setAppError(errorMessage(error));
    }
  }, [documentsQuery.query]);

  const insertUploadedFile = useCallback(
    async (file: File) => {
      if (!selectedDocument) return;
      const pendingBlock = pendingUploadBlockRef.current;
      const documentId = pendingBlock?.documentId ?? selectedDocument._id;
      const anchor = pendingBlock === null ? editor.getTextCursorPosition().block : null;
      setAppError(null);
      try {
        const url = await uploadFile(file);
        if (selectedDocumentIdRef.current !== documentId) {
          throw new Error("The active document changed before the file was inserted.");
        }
        if (pendingBlock !== null) {
          editor.updateBlock(pendingBlock.blockId, {
            type: pendingBlock.type,
            props: { name: file.name, url },
          } as PartialBlock);
          return;
        }
        const type = file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("audio/")
            ? "audio"
            : file.type.startsWith("video/")
              ? "video"
              : "file";
        editor.insertBlocks(
          [
            {
              type,
              props: { name: file.name, url },
            } as PartialBlock,
          ],
          anchor!,
          "after",
        );
      } catch (error) {
        setAppError(errorMessage(error));
      } finally {
        pendingUploadBlockRef.current = null;
        if (uploadInputRef.current) {
          uploadInputRef.current.accept = uploadAccept;
          uploadInputRef.current.value = "";
        }
      }
    },
    [editor, selectedDocument, uploadFile],
  );

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
      setMobilePane(nextDocument ? "editor" : "documents");
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
    if (!selectedDocument || snapshotPendingRef.current) return;
    snapshotPendingRef.current = true;
    setHistoryBusy(true);
    setAppError(null);
    try {
      const body = JSON.stringify(editor.document);
      setCurrentBody(body);
      desiredBodyRef.current = body;
      fieldRef.current?.queue(body);
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
      snapshotPendingRef.current = false;
      setHistoryBusy(false);
    }
  }, [editor, refreshHistory, selectedDocument, setBaseline, settleDraftDocument]);

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
    return query
      ? orderedDocuments.filter((document) => document.title.toLowerCase().includes(query))
      : orderedDocuments;
  }, [orderedDocuments, searchQuery]);
  const uploadBusy = uploadNotice?.phase === "saving";

  return (
    <div className="demoShell">
      <DebugOverlay connection={connection} />
      <main className="demoMain">
        <div className="documentsLayout" data-mobile-pane={mobilePane}>
          <aside className="panel documentsSidebar">
            <div className="searchToolbar">
              <div className="searchRow">
                <div className="searchField">
                  <Search className="shrink-0" size={15} />
                  <input
                    aria-label="Search documents"
                    className="mobileSearchInput min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-content-primary placeholder:text-content-tertiary focus:ring-0"
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
                  disabled={documentsQuery.query !== "ready" || uploadBusy}
                  onClick={() => void createDocument()}
                >
                  <Plus size={16} />
                </button>
              </div>
              {pinnedIds.size > 0 ? (
                <div className="pinnedCount">
                  <Pin className="shrink-0" size={12} />
                  {pinnedIds.size} pinned on this device
                </div>
              ) : null}
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
                    expanded={expandedIds.has(document._id)}
                    pinned={pinnedIds.has(document._id)}
                    onSelect={() => {
                      if (uploadBusy) return;
                      setSelectedDocumentId(document._id);
                      setMobilePane("editor");
                    }}
                    onToggleExpanded={() => void toggleExpanded(document._id)}
                    onTogglePin={() => void togglePin(document._id)}
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

          <section ref={documentPanelRef} className="panel documentPanel">
            <header className="panelHeader">
              <button
                className="iconButton mobileBack"
                type="button"
                aria-label="Back to documents"
                disabled={uploadBusy}
                onClick={() => setMobilePane("documents")}
              >
                <ArrowLeft size={18} />
              </button>
              <div className="documentPanelTitle">
                <FileText className="shrink-0" size={15} />
                <div>
                  <input
                    className="documentTitleInput"
                    aria-label="Document title"
                    disabled={!selectedDocument}
                    placeholder="Untitled"
                    title={currentTitle}
                    value={editableTitle}
                    onBlur={() => {
                      const first = editor.document.at(0);
                      if (first && !blockText(first).trim()) {
                        editor.updateBlock(first, { content: "Untitled" });
                      }
                    }}
                    onChange={(event) => {
                      const first = editor.document.at(0);
                      if (first) editor.updateBlock(first, { content: event.currentTarget.value });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.currentTarget.blur();
                        return;
                      }
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      const bodyBlock = editor.document.at(1);
                      if (bodyBlock) {
                        editor.setTextCursorPosition(bodyBlock, "start");
                        editor.focus();
                      }
                    }}
                  />
                </div>
              </div>
              <div className="flex items-center gap-1">
                <RemoteStatus connection={connection} />
                <input
                  ref={uploadInputRef}
                  className="sr-only"
                  type="file"
                  accept={uploadAccept}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) void insertUploadedFile(file);
                  }}
                />
                <button
                  className="iconButton"
                  type="button"
                  aria-label="Attach a file"
                  disabled={!selectedDocument || uploadBusy}
                  onClick={() => {
                    pendingUploadBlockRef.current = null;
                    const input = uploadInputRef.current;
                    if (input !== null) {
                      input.accept = uploadAccept;
                      input.click();
                    }
                  }}
                  title="Attach a file offline"
                >
                  {uploadNotice?.phase === "saving" ? (
                    <Loader2 className="animate-spin" size={16} />
                  ) : (
                    <Paperclip size={16} />
                  )}
                </button>
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
                  {historyGroups.length > 0 ? (
                    <span className="historyBadge">{historyGroups.length}</span>
                  ) : null}
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

            {slashPalette ? (
              <div
                className="commandPalette"
                role="listbox"
                aria-label="Block commands"
                style={{ left: slashPalette.x, top: slashPalette.y }}
              >
                {slashItems.length > 0 ? (
                  slashItems.map((item, index) => (
                    <div className="commandPaletteEntry" key={`${item.group}:${item.title}`}>
                      {index === 0 || slashItems[index - 1]?.group !== item.group ? (
                        <div className="commandPaletteGroup">{item.group}</div>
                      ) : null}
                      <button
                        className="commandPaletteItem"
                        type="button"
                        role="option"
                        aria-selected={index === slashIndex}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => runSlashItem(item)}
                      >
                        <span className="commandPaletteIcon">{item.icon}</span>
                        <span className="commandPaletteCopy">
                          <strong>{item.title}</strong>
                          {item.subtext ? <small>{item.subtext}</small> : null}
                        </span>
                        {item.badge ? <kbd>{item.badge}</kbd> : null}
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="commandPaletteEmpty">No matching commands</div>
                )}
              </div>
            ) : null}

            {uploadNotice ? <UploadStatus notice={uploadNotice} connection={connection} /> : null}

            <div className="documentViewport">
              {selectedDocument || keepsPreviousEditor ? (
                <div
                  aria-busy={selectedDocumentPending}
                  className="editor-shell documentEnter"
                  key={selectedDocument?._id ?? lastAppliedDocIdRef.current}
                >
                  <BlockNoteView
                    editor={editor}
                    data-theming-css-demo
                    emojiPicker={false}
                    filePanel={false}
                    formattingToolbar={false}
                    linkToolbar={false}
                    sideMenu={false}
                    slashMenu={false}
                    tableHandles={false}
                    theme="dark"
                  />
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
            error={
              historyConnected ? appError : "Snapshot history becomes available when connected."
            }
            preview={preview}
            groups={historyGroups}
            selectedRevId={selectedHistoryRevId}
            onClose={() => setHistoryOpen(false)}
            onRefresh={() => {
              if (historyConnected) void refreshHistory(true);
            }}
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

function usePinnedDocumentIds(): QueryState<Id<"documents">[]> {
  const [state, setState] = useState<QueryState<Id<"documents">[]>>({ query: "loading" });

  useEffect(() => {
    const watch = client.watchQuery(pinnedDocumentsQuery, {});
    const read = () => setState(readQuery(() => watch.localQueryResult()));
    const unsubscribe = watch.onUpdate(read);
    read();
    return unsubscribe;
  }, []);

  return state;
}

function useExpandedDocumentIds(): QueryState<Id<"documents">[]> {
  const [state, setState] = useState<QueryState<Id<"documents">[]>>({ query: "loading" });

  useEffect(() => {
    const watch = client.watchQuery(expandedDocumentsQuery, {});
    const read = () => setState(readQuery(() => watch.localQueryResult()));
    const unsubscribe = watch.onUpdate(read);
    read();
    return unsubscribe;
  }, []);

  return state;
}

function useConnectionState(): EmbeddedConnectionState {
  const [state, setState] = useState<EmbeddedConnectionState>(() => client.connectionState());
  useEffect(() => {
    let active = true;
    let timer: number | undefined = window.setInterval(sync, 500);
    const unsubscribe = client.subscribeEvents((event) => {
      if (event.type === "remote" || event.type === "runtime") sync();
    });
    const onFocus = (): void => sync();
    const onPageShow = (): void => sync();
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") sync();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    sync();
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
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
  const [lines, setLines] = useState<string[]>(() =>
    (globalThis.__CONVEX_EMBEDDED_DEBUG_EVENTS__ ?? []).slice(-20).map(debugLine),
  );
  useEffect(() => {
    if (!debugEnabled) return;
    const unsubscribeInternal = client.subscribeInternalEvents((event) => {
      const stamp = new Date().toISOString().slice(11, 23);
      const summary = JSON.stringify(event).slice(0, 160);
      setLines((prior) => [...prior.slice(-19), `${stamp} ${summary}`]);
    });
    const unsubscribeBrowser = subscribeBrowserDebug((event) => {
      setLines((prior) => [...prior.slice(-19), debugLine(event)]);
    });
    return () => {
      unsubscribeInternal();
      unsubscribeBrowser();
    };
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

function debugLine(event: { detail?: unknown; phase: string; source: string }): string {
  const stamp = new Date().toISOString().slice(11, 23);
  const detail = event.detail === undefined ? "" : ` ${JSON.stringify(event.detail).slice(0, 180)}`;
  return `${stamp} [${event.source}] ${event.phase}${detail}`;
}

function UploadStatus(props: {
  connection: EmbeddedConnectionState;
  notice: UploadNotice;
}): ReactElement {
  const { connection, notice } = props;
  const offline = connection.remote === "offline" || connection.remote === "closed";
  const label =
    notice.phase === "saving"
      ? "Saving locally"
      : notice.phase === "local"
        ? offline
          ? "Saved offline · queued"
          : "Saved locally · queued"
        : notice.phase === "syncing"
          ? "Uploading to Convex"
          : notice.phase === "synced"
            ? "Available everywhere"
            : "Upload failed";
  return (
    <div className={`uploadStatus uploadStatus--${notice.phase}`} role="status">
      {notice.phase === "saving" || notice.phase === "syncing" ? (
        <Loader2 className="animate-spin" size={15} />
      ) : notice.phase === "failed" ? (
        <TriangleAlert size={15} />
      ) : (
        <CircleCheck size={15} />
      )}
      <span>
        <strong>{label}</strong>
        <small>{notice.fileName}</small>
      </span>
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
      : connection.remote === "connected"
        ? "Online"
        : connection.remote === "offline"
          ? "Offline"
          : connection.remote === "starting"
            ? "Connecting"
            : connection.remote === "closed"
              ? "Offline"
              : "Sync error";
  const icon =
    connection.remote === "ready" || connection.remote === "connected" ? (
      <Cloud size={15} strokeWidth={2} />
    ) : connection.remote === "starting" ? (
      <Loader2 className="animate-spin" size={15} />
    ) : connection.remote === "offline" || connection.remote === "closed" ? (
      <CloudOff size={15} strokeWidth={2} />
    ) : (
      <TriangleAlert size={15} />
    );
  return (
    <span
      className={`syncStatus syncStatus--${connection.remote}`}
      title={remoteError ?? label}
      aria-label={remoteError ? `Sync error: ${remoteError}` : label}
      role="status"
    >
      <span className="syncStatusIcon" aria-hidden="true">
        {icon}
      </span>
      <span className="syncStatusLabel">{label}</span>
    </span>
  );
}

function DocumentRow(props: {
  active: boolean;
  document: DocumentSummary;
  expanded: boolean;
  pinned: boolean;
  onSelect: () => void;
  onToggleExpanded: () => void;
  onTogglePin: () => void;
}): ReactElement {
  return (
    <div className={["documentRow", props.active ? "active" : ""].join(" ")}>
      <button
        className="documentRowSelect"
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
          {props.expanded ? (
            <span className="block truncate text-xs text-content-tertiary">
              /{props.document.slug}
            </span>
          ) : null}
        </span>
      </button>
      <button
        className={["documentRowExpand", props.expanded ? "active" : ""].join(" ")}
        type="button"
        aria-label={props.expanded ? "Collapse document details" : "Expand document details"}
        aria-expanded={props.expanded}
        title={props.expanded ? "Hide details on this device" : "Show details on this device"}
        onClick={props.onToggleExpanded}
      >
        {props.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      <button
        className={["documentRowPin", props.pinned ? "active" : ""].join(" ")}
        type="button"
        aria-label={props.pinned ? "Unpin document" : "Pin document"}
        aria-pressed={props.pinned}
        title={props.pinned ? "Unpin from this device" : "Pin to this device"}
        onClick={props.onTogglePin}
      >
        <Pin size={14} />
      </button>
    </div>
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

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onClose();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [props.onClose]);

  return (
    <div
      className="historyModal"
      role="dialog"
      aria-modal="true"
      aria-label="Snapshot history"
      onPointerDown={(event) => {
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest(".historyModalShell")) props.onClose();
      }}
    >
      <div className="historyModalBackdrop" aria-hidden="true" onClick={props.onClose} />
      <div
        className="historyModalShell panel"
        data-mobile-view={props.selectedRevId === null ? "list" : "preview"}
      >
        <div className="historyPreview">
          <div className="panelHeader">
            <button
              className="iconButton mobileHistoryPreviewBack"
              type="button"
              aria-label="Back to snapshot history"
              onClick={props.onSelectCurrent}
            >
              <ArrowLeft size={18} />
            </button>
            <div className="historyPreviewTitle">
              <h2>{detailTitle}</h2>
              <p>{detailTime}</p>
            </div>
            {canRestore ? (
              <button
                className="iconButton mobileHistoryRestore"
                type="button"
                disabled={props.busy}
                aria-label="Restore snapshot"
                onClick={props.onRestore}
              >
                <RotateCcw size={17} />
              </button>
            ) : null}
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

function slashQueryFromEditor(editor: {
  getTextCursorPosition(): { block: Block };
}): string | null {
  try {
    const text = blockText(editor.getTextCursorPosition().block);
    const match = /^\/([^\n]*)$/.exec(text);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(value);
}

function embeddedFileToken(url: string): string | null {
  const path = (() => {
    try {
      return new URL(url, globalThis.location?.origin).pathname;
    } catch {
      return url;
    }
  })();
  if (!path.startsWith(embeddedFilePath)) return null;
  try {
    return decodeURIComponent(path.slice(embeddedFilePath.length));
  } catch {
    return null;
  }
}

function isLocalFileUrl(url: string): boolean {
  return url.startsWith("blob:") || url.startsWith("data:");
}

async function uploadResponseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {}
  return `File upload failed with status ${response.status}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
