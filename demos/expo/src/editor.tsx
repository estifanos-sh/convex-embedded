"use dom";

import { BlockNoteView } from "@blocknote/ariakit";
import "@blocknote/ariakit/style.css";
import { useBlockNoteEditor, useCreateBlockNote, useEditorState } from "@blocknote/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import "./editor.css";
import {
  documentWrite as createDocumentWrite,
  documentBlocks,
  draftFingerprint,
  isEmptyTable,
  recoveryDecode,
  recoveryDecision,
  recoveryEncode,
  recoveryRecord,
  sameDraft,
  titleRecoveryDecision,
  titleRecoveryRecord,
} from "./text";
import type {
  EditorDocument,
  EditorDraft,
  EditorProps,
  EditorSaveState,
  EditorStatusPayload,
} from "./types";

const writeDelayMs = 40;
const writeMaxLatencyMs = 160;
const editorDelayMs = 16;
const editorMaxLatencyMs = 80;

type DocumentEditorProps = EditorProps & {
  dom?: import("expo/dom").DOMProps;
};

export default function DocumentEditor(props: DocumentEditorProps) {
  return <InteractiveDocument {...props} key={props.editorToken} />;
}

function InteractiveDocument({
  active,
  closeRequest,
  document,
  documentWrite,
  editorReady,
  editorStatusChanged,
  editorToken,
  focusBodyRequest,
  retryRequest,
  title,
  titleRevision,
}: DocumentEditorProps) {
  const [initial] = useState(() => readRecovery(document));
  const [initialPersistedFingerprint] = useState(() =>
    draftFingerprint({ body: document.body, title: document.title }),
  );
  const [initialTitleRevision] = useState(() =>
    initial.draft.title === title ? titleRevision : titleRevision + 1,
  );
  const editor = useCreateBlockNote({
    initialContent: documentBlocks(initial.draft.body, initial.draft.title),
  });
  const [saveState, setSaveState] = useState<EditorSaveState>(
    initial.recovered ? "recovered" : "saved",
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false);
  const [nativeTitleReady, setNativeTitleReady] = useState(false);
  const desiredRef = useRef(initial.draft);
  const persistedRef = useRef<EditorDraft>({ body: document.body, title: document.title });
  const persistedFingerprintRef = useRef(initialPersistedFingerprint);
  const titleRef = useRef(initial.draft.title);
  const actionRef = useRef(documentWrite);
  const editorReadyRef = useRef(editorReady);
  const editorStatusChangedRef = useRef(editorStatusChanged);
  const saveStateRef = useRef(saveState);
  const saveErrorRef = useRef(saveError);
  const recoveryUnavailableRef = useRef(recoveryUnavailable);
  const appliedTitleRevisionRef = useRef(initialTitleRevision);
  const previousCloseRequestRef = useRef(closeRequest);
  const previousFocusBodyRequestRef = useRef(focusBodyRequest);
  const previousRetryRequestRef = useRef(retryRequest);
  const lastStatusRef = useRef("");
  const statusTaskRef = useRef<Promise<void>>(Promise.resolve());
  const trailingTimerRef = useRef<number | undefined>(undefined);
  const maxTimerRef = useRef<number | undefined>(undefined);
  const editorCancelRef = useRef<(() => void) | undefined>(undefined);
  const editorMaxTimerRef = useRef<number | undefined>(undefined);
  const inFlightRef = useRef<Promise<EditorDraft> | null>(null);
  const flushAfterFlightRef = useRef(false);
  const applyingNativeRef = useRef(false);
  const pendingExternalRef = useRef<EditorDraft | null>(null);
  const lastWriteStartedRef = useRef(0);
  const flushRef = useRef<() => void>(() => undefined);
  const flushRecoveryRef = useRef<() => void>(() => undefined);
  const flushEditorRef = useRef<() => void>(() => undefined);
  actionRef.current = documentWrite;
  editorReadyRef.current = editorReady;
  editorStatusChangedRef.current = editorStatusChanged;
  saveStateRef.current = saveState;
  saveErrorRef.current = saveError;
  recoveryUnavailableRef.current = recoveryUnavailable;

  const replaceDraft = useCallback(
    (draft: EditorDraft) => {
      editorCancelRef.current?.();
      if (editorMaxTimerRef.current !== undefined) window.clearTimeout(editorMaxTimerRef.current);
      editorCancelRef.current = undefined;
      editorMaxTimerRef.current = undefined;
      applyingNativeRef.current = true;
      titleRef.current = draft.title;
      editor.replaceBlocks(editor.document, documentBlocks(draft.body, draft.title));
      queueMicrotask(() => {
        applyingNativeRef.current = false;
      });
    },
    [editor],
  );

  useEffect(() => {
    let cancelled = false;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const status = statusPayload(
          saveStateRef.current,
          saveErrorRef.current,
          recoveryUnavailableRef.current,
          appliedTitleRevisionRef.current,
        );
        lastStatusRef.current = statusKey(status);
        void editorReadyRef
          .current({
            ...status,
            title: initial.draft.title,
            token: editorToken,
          })
          .then(() => {
            if (!cancelled) setNativeTitleReady(true);
          })
          .catch((error: unknown) => {
            console.error("The native editor-ready action failed.", error);
          });
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [editorToken, initial.draft.title]);

  const clearTimers = useCallback(() => {
    if (trailingTimerRef.current !== undefined) window.clearTimeout(trailingTimerRef.current);
    if (maxTimerRef.current !== undefined) window.clearTimeout(maxTimerRef.current);
    trailingTimerRef.current = undefined;
    maxTimerRef.current = undefined;
  }, []);

  const scheduleWrite = useCallback(() => {
    if (trailingTimerRef.current !== undefined) window.clearTimeout(trailingTimerRef.current);
    trailingTimerRef.current = window.setTimeout(() => flushRef.current(), writeDelayMs);
    if (maxTimerRef.current === undefined) {
      maxTimerRef.current = window.setTimeout(() => flushRef.current(), writeMaxLatencyMs);
    }
  }, []);

  const flushRecovery = useCallback(() => {
    const persisted = persistedRef.current;
    const desired = desiredRef.current;
    if (sameDraft(persisted, desired)) {
      deleteRecovery(document.id);
      setRecoveryUnavailable(false);
      return;
    }
    setRecoveryUnavailable(!writeRecovery(document.id, persistedFingerprintRef.current, desired));
  }, [document.id]);
  flushRecoveryRef.current = flushRecovery;

  const flush = useCallback(() => {
    clearTimers();
    flushEditorRef.current();
    if (inFlightRef.current) {
      flushAfterFlightRef.current = true;
      return;
    }

    const persisted = persistedRef.current;
    const desired = desiredRef.current;
    if (sameDraft(persisted, desired)) {
      deleteRecovery(document.id);
      setRecoveryUnavailable(false);
      setSaveState("saved");
      setSaveError(null);
      return;
    }

    const remainingDelay = lastWriteStartedRef.current + writeDelayMs - Date.now();
    if (remainingDelay > 0) {
      trailingTimerRef.current = window.setTimeout(() => flushRef.current(), remainingDelay);
      return;
    }

    const write = createDocumentWrite(document.id, persisted, desired);
    if (!write) return;

    setSaveState("saving");
    setSaveError(null);
    lastWriteStartedRef.current = Date.now();
    const written = desired;
    const task = actionRef.current(write);
    inFlightRef.current = task;
    void task
      .then(() => {
        const external = pendingExternalRef.current;
        pendingExternalRef.current = null;
        const settled = external ?? written;
        persistedRef.current = settled;
        persistedFingerprintRef.current = draftFingerprint(settled);
        if (external) {
          desiredRef.current = external;
          replaceDraft(external);
        }
        flushEditorRef.current();
        if (sameDraft(desiredRef.current, settled)) {
          deleteRecovery(document.id);
          setRecoveryUnavailable(false);
          setSaveState("saved");
        } else {
          flushRecoveryRef.current();
          setSaveState("dirty");
        }
      })
      .catch((error: unknown) => {
        flushRecoveryRef.current();
        setSaveState("error");
        setSaveError(errorMessage(error));
      })
      .finally(() => {
        inFlightRef.current = null;
        const needsWrite = !sameDraft(persistedRef.current, desiredRef.current);
        if (needsWrite && flushAfterFlightRef.current) scheduleWrite();
        flushAfterFlightRef.current = false;
      });
  }, [clearTimers, document.id, replaceDraft, scheduleWrite]);
  flushRef.current = flush;

  const queueDraft = useCallback(
    (draft: EditorDraft) => {
      desiredRef.current = draft;
      setSaveState("dirty");
      setSaveError(null);
      flushRecoveryRef.current();
      scheduleWrite();
    },
    [scheduleWrite],
  );

  const queueNativeTitle = useCallback(
    (nextTitle: string) => {
      desiredRef.current = { ...desiredRef.current, title: nextTitle };
      setSaveState("dirty");
      setSaveError(null);
      if (!writeTitleRecovery(document.id, persistedRef.current.title, nextTitle)) {
        setRecoveryUnavailable(true);
      }
      scheduleWrite();
    },
    [document.id, scheduleWrite],
  );

  const writeEditorDraft = useCallback(() => {
    const body = JSON.stringify(editor.document);
    queueDraft({ body, title: titleRef.current });
  }, [editor, queueDraft]);

  const flushEditor = useCallback(() => {
    if (editorCancelRef.current === undefined && editorMaxTimerRef.current === undefined) {
      return;
    }
    editorCancelRef.current?.();
    if (editorMaxTimerRef.current !== undefined) window.clearTimeout(editorMaxTimerRef.current);
    editorCancelRef.current = undefined;
    editorMaxTimerRef.current = undefined;
    writeEditorDraft();
  }, [writeEditorDraft]);
  flushEditorRef.current = flushEditor;

  const queueEditor = useCallback(() => {
    if (applyingNativeRef.current) return;
    setSaveState("dirty");
    setSaveError(null);
    editorCancelRef.current?.();
    const trailing = window.setTimeout(() => {
      editorCancelRef.current = undefined;
      flushEditorRef.current();
    }, editorDelayMs);
    editorCancelRef.current = () => window.clearTimeout(trailing);
    if (editorMaxTimerRef.current === undefined) {
      editorMaxTimerRef.current = window.setTimeout(
        () => flushEditorRef.current(),
        editorMaxLatencyMs,
      );
    }
  }, []);

  useEffect(() => {
    if (!nativeTitleReady || !initial.recovered) return;
    flushRecoveryRef.current();
    scheduleWrite();
  }, [initial.recovered, nativeTitleReady, scheduleWrite]);

  useEffect(() => {
    const flushPending = (): void => {
      flushEditorRef.current();
      flushRecoveryRef.current();
      flushRef.current();
    };
    const onPageHide = (): void => flushPending();
    const onVisibilityChange = (): void => {
      if (globalThis.document.visibilityState === "hidden") flushPending();
    };
    globalThis.addEventListener("pagehide", onPageHide);
    globalThis.document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      globalThis.removeEventListener("pagehide", onPageHide);
      globalThis.document.removeEventListener("visibilitychange", onVisibilityChange);
      flushPending();
    };
  }, []);

  useEffect(() => {
    if (active) return;
    if (globalThis.document.activeElement instanceof HTMLElement) {
      globalThis.document.activeElement.blur();
    }
    flushEditorRef.current();
    flushRecoveryRef.current();
    flushRef.current();
  }, [active]);

  useEffect(() => {
    if (!nativeTitleReady) return;
    if (titleRevision <= appliedTitleRevisionRef.current) return;
    appliedTitleRevisionRef.current = titleRevision;
    titleRef.current = title;
    const titleBlock = editor.document.at(0);
    if (titleBlock) {
      editor.updateBlock(titleBlock, { content: title });
      queueNativeTitle(title);
    }
  }, [editor, nativeTitleReady, queueNativeTitle, title, titleRevision]);

  useEffect(() => {
    if (!nativeTitleReady) return;
    const incoming = { body: document.body, title: document.title };
    if (sameDraft(incoming, persistedRef.current)) return;
    if (inFlightRef.current !== null) {
      pendingExternalRef.current = incoming;
      return;
    }

    persistedRef.current = incoming;
    persistedFingerprintRef.current = draftFingerprint(incoming);
    desiredRef.current = incoming;
    replaceDraft(incoming);
    deleteRecovery(document.id);
    setRecoveryUnavailable(false);
    setSaveError(null);
    setSaveState("saved");
  }, [document.body, document.id, document.title, nativeTitleReady, replaceDraft]);

  useEffect(() => {
    if (!nativeTitleReady) return;
    const status = statusPayload(
      saveState,
      saveError,
      recoveryUnavailable,
      appliedTitleRevisionRef.current,
    );
    const key = statusKey(status);
    if (lastStatusRef.current === key) return;
    lastStatusRef.current = key;
    statusTaskRef.current = statusTaskRef.current
      .then(() => editorStatusChangedRef.current(editorToken, status))
      .catch((error: unknown) => {
        console.error("The native editor-status action failed.", error);
      });
  }, [editorToken, nativeTitleReady, recoveryUnavailable, saveError, saveState]);

  useEffect(() => {
    if (!nativeTitleReady) return;
    if (previousFocusBodyRequestRef.current === focusBodyRequest) return;
    previousFocusBodyRequestRef.current = focusBodyRequest;
    let bodyBlock = editor.document.at(1);
    if (!bodyBlock) {
      const titleBlock = editor.document.at(0);
      if (titleBlock) {
        editor.insertBlocks([{ type: "paragraph", content: "" }], titleBlock, "after");
        bodyBlock = editor.document.at(1);
      }
    }
    if (bodyBlock) editor.setTextCursorPosition(bodyBlock, "start");
    editor.focus();
  }, [editor, focusBodyRequest, nativeTitleReady]);

  useEffect(() => {
    if (previousRetryRequestRef.current === retryRequest) return;
    previousRetryRequestRef.current = retryRequest;
    flushEditorRef.current();
    flushRecoveryRef.current();
    flushRef.current();
  }, [retryRequest]);

  useEffect(() => {
    if (previousCloseRequestRef.current === closeRequest) return;
    previousCloseRequestRef.current = closeRequest;
    flushEditorRef.current();
    flushRecoveryRef.current();
    flushRef.current();
  }, [closeRequest]);

  const deleteEmptyTable = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Backspace" || event.nativeEvent.isComposing) return;
      const selection = editor.prosemirrorState.selection;
      if (!selection.empty || selection.$from.parentOffset !== 0) return;
      let isFirstCell = false;
      for (let depth = selection.$from.depth; depth >= 2; depth -= 1) {
        const role = selection.$from.node(depth).type.spec.tableRole;
        if (role !== "cell" && role !== "header_cell") continue;
        const rowDepth = depth - 1;
        const tableDepth = depth - 2;
        isFirstCell =
          selection.$from.node(rowDepth).type.spec.tableRole === "row" &&
          selection.$from.node(tableDepth).type.spec.tableRole === "table" &&
          selection.$from.index(rowDepth) === 0 &&
          selection.$from.index(tableDepth) === 0;
        break;
      }
      if (!isFirstCell) return;
      const block = editor.getTextCursorPosition().block;
      if (!isEmptyTable(block)) return;

      event.preventDefault();
      event.stopPropagation();
      let target = editor.getNextBlock(block)?.id;
      if (!target) {
        target = editor.insertBlocks([{ type: "paragraph", content: "" }], block, "after")[0]?.id;
      }
      editor.removeBlocks([block]);
      if (target) editor.setTextCursorPosition(target, "start");
      editor.focus();
    },
    [editor],
  );

  return (
    <main className="editorPage">
      <article className="documentSheet">
        {saveError ? (
          <button className="recoveryNotice" type="button" onClick={() => flushRef.current()}>
            <strong>
              {recoveryUnavailable
                ? "Draft is still open in this editor."
                : "Draft kept on this device."}
            </strong>
            <span>{saveError} Tap to retry.</span>
          </button>
        ) : initial.recovered && saveState !== "saved" ? (
          <p className="recoveryNotice recoveryNotice--calm" role="status">
            <strong>Recovered local draft.</strong>
            <span>Saving it back to embedded storage.</span>
          </p>
        ) : null}

        <div className="editorCanvas" onKeyDownCapture={deleteEmptyTable}>
          <BlockNoteView
            editor={editor}
            emojiPicker={false}
            filePanel={false}
            formattingToolbar
            linkToolbar
            onChange={queueEditor}
            sideMenu={false}
            slashMenu
            tableHandles={false}
            theme="dark"
          >
            <TableDeleteButton />
          </BlockNoteView>
        </div>
      </article>
    </main>
  );
}

function TableDeleteButton() {
  const editor = useBlockNoteEditor();
  const block = useEditorState({
    editor,
    selector: ({ editor }) => {
      const selected = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
      return selected.length === 1 && selected[0]?.type === "table" ? selected[0] : undefined;
    },
  });
  const deleteTable = useCallback(() => {
    if (!block) return;
    let target = editor.getNextBlock(block)?.id;
    if (!target) {
      target = editor.insertBlocks([{ type: "paragraph", content: "" }], block, "after")[0]?.id;
    }
    editor.removeBlocks([block]);
    if (target) editor.setTextCursorPosition(target, "start");
    editor.focus();
  }, [block, editor]);

  if (!block) return null;
  return (
    <button
      aria-label="Delete table"
      className="tableDeleteButton"
      onClick={deleteTable}
      onPointerDown={(event) => event.preventDefault()}
      type="button"
    >
      <TrashIcon />
      <span>Delete table</span>
    </button>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20">
      <path
        d="M5 7h14M9 7V4h6v3m2 0-.7 13H7.7L7 7m3 4v5m4-5v5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function readRecovery(document: EditorDocument): { draft: EditorDraft; recovered: boolean } {
  const native = { body: document.body, title: document.title };
  try {
    const encoded = globalThis.localStorage.getItem(recoveryKey(document.id));
    const decision = encoded
      ? recoveryDecision(native, recoveryDecode(encoded) ?? JSON.parse(encoded))
      : { draft: native, recovered: false, remove: false };
    if (decision.remove) deleteBodyRecovery(document.id);
    const titleDecision = titleRecoveryDecision(native.title, readTitleRecovery(document.id));
    if (titleDecision.remove) deleteTitleRecovery(document.id);
    if (!titleDecision.recovered) {
      return { draft: decision.draft, recovered: decision.recovered };
    }
    return {
      draft: { ...decision.draft, title: titleDecision.title },
      recovered: true,
    };
  } catch {
    deleteRecovery(document.id);
  }
  return { draft: native, recovered: false };
}

function writeRecovery(id: string, base: string, draft: EditorDraft): boolean {
  try {
    const recovery = recoveryRecord(base, draft);
    globalThis.localStorage.setItem(recoveryKey(id), recoveryEncode(recovery));
    return true;
  } catch {
    // Native embedded storage remains authoritative when WebView storage is unavailable.
    return false;
  }
}

function deleteRecovery(id: string): void {
  deleteBodyRecovery(id);
  deleteTitleRecovery(id);
}

function deleteBodyRecovery(id: string): void {
  try {
    globalThis.localStorage.removeItem(recoveryKey(id));
  } catch {
    // Recovery is best effort and must never interrupt editing.
  }
}

function writeTitleRecovery(id: string, baseTitle: string, title: string): boolean {
  try {
    globalThis.localStorage.setItem(
      titleRecoveryKey(id),
      JSON.stringify(titleRecoveryRecord(baseTitle, title)),
    );
    return true;
  } catch {
    return false;
  }
}

function readTitleRecovery(id: string): unknown {
  try {
    const encoded = globalThis.localStorage.getItem(titleRecoveryKey(id));
    if (!encoded) return undefined;
    return JSON.parse(encoded) as unknown;
  } catch {
    deleteTitleRecovery(id);
    return undefined;
  }
}

function deleteTitleRecovery(id: string): void {
  try {
    globalThis.localStorage.removeItem(titleRecoveryKey(id));
  } catch {
    // Recovery is best effort and must never interrupt editing.
  }
}

function recoveryKey(id: string): string {
  return `convex-embedded:draft:${id}`;
}

function titleRecoveryKey(id: string): string {
  return `convex-embedded:title:${id}`;
}

function statusPayload(
  state: EditorSaveState,
  error: string | null,
  recoveryUnavailable: boolean,
  titleRevision: number,
): EditorStatusPayload {
  return { error, recoveryUnavailable, state, titleRevision };
}

function statusKey(status: EditorStatusPayload): string {
  return `${status.state}\u0000${status.error ?? ""}\u0000${status.recoveryUnavailable ? "1" : "0"}\u0000${status.titleRevision}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
