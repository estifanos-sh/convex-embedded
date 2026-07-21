"use dom";

import { BlockNoteView } from "@blocknote/ariakit";
import "@blocknote/ariakit/style.css";
import { useCreateBlockNote } from "@blocknote/react";
import { useCallback, useEffect, useRef, useState } from "react";

import "./editor.css";
import {
  documentWrite as createDocumentWrite,
  documentBlocks,
  draftFingerprint,
  normalizeDocumentDraft,
  recoveryDecode,
  recoveryDecision,
  recoveryEncode,
  recoveryRecord,
  sameDraft,
  titleFromBlocks,
} from "./text";
import type { EditorDocument, EditorDraft, EditorProps } from "./types";

const writeDelayMs = 250;
const writeMaxLatencyMs = 1_000;
const editorDelayMs = 100;
const editorMaxLatencyMs = 500;

type SaveState = "dirty" | "error" | "recovered" | "saved" | "saving";

type DocumentEditorProps = EditorProps & {
  dom?: import("expo/dom").DOMProps;
};

export default function DocumentEditor(props: DocumentEditorProps) {
  return <InteractiveDocument {...props} key={props.editorToken} />;
}

function InteractiveDocument({
  active,
  document,
  documentWrite,
  editorReady,
  editorToken,
}: DocumentEditorProps) {
  const [initial] = useState(() => {
    const recovered = readRecovery(document);
    const draft = normalizeDocumentDraft(recovered.draft);
    return { ...recovered, draft, normalized: draft.body !== recovered.draft.body };
  });
  const [initialPersistedFingerprint] = useState(() =>
    draftFingerprint({ body: document.body, title: document.title }),
  );
  const editor = useCreateBlockNote({
    initialContent: documentBlocks(initial.draft.body, initial.draft.title),
  });
  const [title, setTitle] = useState(initial.draft.title);
  const [saveState, setSaveState] = useState<SaveState>(
    initial.recovered ? "recovered" : initial.normalized ? "dirty" : "saved",
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false);
  const desiredRef = useRef(initial.draft);
  const persistedRef = useRef<EditorDraft>({ body: document.body, title: document.title });
  const persistedFingerprintRef = useRef(initialPersistedFingerprint);
  const actionRef = useRef(documentWrite);
  const editorReadyRef = useRef(editorReady);
  const trailingTimerRef = useRef<number | undefined>(undefined);
  const maxTimerRef = useRef<number | undefined>(undefined);
  const editorCancelRef = useRef<(() => void) | undefined>(undefined);
  const editorMaxTimerRef = useRef<number | undefined>(undefined);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const flushAfterFlightRef = useRef(false);
  const lastWriteStartedRef = useRef(0);
  const flushRef = useRef<() => void>(() => undefined);
  const flushRecoveryRef = useRef<() => void>(() => undefined);
  const flushEditorRef = useRef<() => void>(() => undefined);
  actionRef.current = documentWrite;
  editorReadyRef.current = editorReady;

  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        void editorReadyRef.current(editorToken).catch((error: unknown) => {
          console.error("The native editor-ready action failed.", error);
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [editorToken]);

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
    const task = actionRef.current(write);
    inFlightRef.current = task;
    void task
      .then(() => {
        persistedRef.current = desired;
        persistedFingerprintRef.current = draftFingerprint(desired);
        if (sameDraft(desiredRef.current, desired)) {
          deleteRecovery(document.id);
          setRecoveryUnavailable(false);
          setSaveState("saved");
        } else {
          // The native baseline moved while a newer draft was pending. Rewrite recovery now so an
          // app termination cannot leave a record keyed to the stale baseline and discard that draft.
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
  }, [clearTimers, document.id, scheduleWrite]);
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

  const writeEditorDraft = useCallback(() => {
    const body = JSON.stringify(editor.document);
    const nextTitle = titleFromBlocks(editor.document);
    setTitle(nextTitle);
    queueDraft({ body, title: nextTitle });
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
    setSaveState("dirty");
    setSaveError(null);
    editorCancelRef.current?.();
    const trailing = window.setTimeout(() => {
      editorCancelRef.current = undefined;
      if (typeof window.requestIdleCallback !== "function") {
        flushEditorRef.current();
        return;
      }
      const idle = window.requestIdleCallback(() => flushEditorRef.current(), {
        timeout: editorMaxLatencyMs,
      });
      editorCancelRef.current = () => window.cancelIdleCallback(idle);
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
    if (initial.recovered || initial.normalized) {
      flushRecoveryRef.current();
      scheduleWrite();
    }
  }, [initial.normalized, initial.recovered, scheduleWrite]);

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

  const writeTitle = useCallback(
    (value: string) => {
      setTitle(value);
      const titleBlock = editor.document.at(0);
      if (titleBlock) editor.updateBlock(titleBlock, { content: value });
    },
    [editor],
  );

  const settleTitle = useCallback(() => {
    if (title.trim()) return;
    writeTitle("Untitled");
  }, [title, writeTitle]);

  return (
    <main className="editorPage">
      <article className="documentSheet">
        <header className="documentHeader">
          <div className="documentTitle">
            <label className="titleLabel" htmlFor="document-title">
              Document title
            </label>
            <input
              id="document-title"
              className="titleInput"
              enterKeyHint="next"
              maxLength={90}
              placeholder="Untitled"
              value={title}
              onBlur={settleTitle}
              onChange={(event) => writeTitle(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                const bodyBlock = editor.document.at(1);
                if (bodyBlock) editor.setTextCursorPosition(bodyBlock, "start");
                editor.focus();
              }}
            />
          </div>
          <div className="documentStatus">
            {saveState === "error" ? (
              <button
                className={`saveState saveState--${saveState}`}
                type="button"
                onClick={() => flushRef.current()}
              >
                <span aria-hidden="true" />
                {saveLabel(saveState)}
              </button>
            ) : (
              <span
                aria-live="polite"
                className={`saveState saveState--${saveState}`}
                role="status"
              >
                <span aria-hidden="true" />
                {saveLabel(saveState)}
              </span>
            )}
          </div>
        </header>

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

        <div className="editorCanvas">
          <BlockNoteView
            editor={editor}
            emojiPicker={false}
            filePanel={false}
            formattingToolbar
            linkToolbar
            onChange={queueEditor}
            sideMenu={false}
            slashMenu={false}
            tableHandles={false}
            theme="dark"
          />
        </div>
      </article>
    </main>
  );
}

function readRecovery(document: EditorDocument): { draft: EditorDraft; recovered: boolean } {
  const native = { body: document.body, title: document.title };
  try {
    const encoded = globalThis.localStorage.getItem(recoveryKey(document.id));
    if (!encoded) return { draft: native, recovered: false };
    const decision = recoveryDecision(native, recoveryDecode(encoded) ?? JSON.parse(encoded));
    if (decision.remove) deleteRecovery(document.id);
    return { draft: decision.draft, recovered: decision.recovered };
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
  try {
    globalThis.localStorage.removeItem(recoveryKey(id));
  } catch {
    // Recovery is best effort and must never interrupt editing.
  }
}

function recoveryKey(id: string): string {
  return `convex-embedded:draft:${id}`;
}

function saveLabel(state: SaveState): string {
  if (state === "dirty") return "Unsaved";
  if (state === "error") return "Retry save";
  if (state === "recovered") return "Recovered";
  if (state === "saving") return "Saving";
  return "Saved";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
