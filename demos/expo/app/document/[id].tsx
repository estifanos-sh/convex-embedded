import { api } from "$convex/_generated/api";
import type { Id } from "$convex/_generated/dataModel";
import type { DOMProps } from "expo/dom";
import { Redirect, useLocalSearchParams } from "expo-router";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import DocumentEditor from "@/src/editor";
import { client } from "@/src/client";
import { useEmbeddedConnectionState } from "@/src/connection";
import { markMaterialized } from "@/src/perf";
import { documentPreview } from "@/src/preview";
import { openQuerySubscription } from "@/src/subscription";
import { documentStatus, type DocumentStatusTone } from "@/src/status";
import { colors } from "@/src/theme";
import type {
  DocumentWrite,
  EditorDocument,
  EditorReadyPayload,
  EditorSaveState,
  EditorStatusPayload,
  TextSplice,
} from "@/src/types";

const materializedIdPrefix = "documents|";
const warmEditorToken = "warm-idle";
const warmDocument: EditorDocument = { body: "", id: warmEditorToken, title: "Untitled" };

function documentOpen(
  id: string,
  signal: AbortSignal,
  onUpdate: (document: EditorDocument | null) => void,
): { close: () => void; result: Promise<EditorDocument> } {
  const subscription = openQuerySubscription(
    client,
    api.documents.read,
    { id: id as Id<"documents"> },
    {
      accept: (value) => value[0] !== undefined && value[0]._id.startsWith(materializedIdPrefix),
      onUpdate: (value) => onUpdate(value[0] ? editorDocument(value[0]) : null),
      signal,
      timeoutMessage: "This document could not be downloaded to embedded storage.",
      timeoutMs: 15_000,
    },
  );
  return {
    close: subscription.close,
    result: subscription.result.then((documents) => {
      const document = documents[0];
      if (!document) throw new Error("This document is no longer available.");
      return editorDocument(document);
    }),
  };
}

function editorDocument(document: {
  body: string;
  _id: Id<"documents">;
  title: string;
}): EditorDocument {
  return { body: document.body, id: document._id, title: document.title };
}

async function documentWrite(
  write: DocumentWrite,
): Promise<Pick<EditorDocument, "body" | "title">> {
  const updated = await client.mutation(api.documents.write, {
    id: write.id as Id<"documents">,
    splices:
      write.base === undefined
        ? write.splices
        : write.splices.map((splice) => ({ ...splice, base: write.base })),
    ...(write.title === undefined ? {} : { title: write.title }),
  });
  return { body: updated.body, title: updated.title };
}

export default function DocumentRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!id) return <Redirect href="/" />;
  return <Redirect href={{ pathname: "/", params: { document: id } }} />;
}

export type DocumentScreenHandle = {
  requestClose: () => void;
};

type DocumentScreenProps = {
  active?: boolean;
  documentId?: string;
  onClose: () => void;
  onReady?: (id: string) => void;
};

export const DocumentScreen = forwardRef<DocumentScreenHandle, DocumentScreenProps>(
  function DocumentScreen({ active = true, documentId: id, onClose, onReady }, ref) {
    const connection = useEmbeddedConnectionState();
    const [document, setDocument] = useState<EditorDocument | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editorToken, setEditorToken] = useState(warmEditorToken);
    const [loading, setLoading] = useState(true);
    const [readyEditorToken, setReadyEditorToken] = useState("");
    const [applicationActive, setApplicationActive] = useState(AppState.currentState === "active");
    const [placeholderVisible, setPlaceholderVisible] = useState(true);
    const [webViewCrash, setWebViewCrash] = useState<string | null>(null);
    const [title, setTitle] = useState("Untitled");
    const [titleRevision, setTitleRevision] = useState(0);
    const [titleFocused, setTitleFocused] = useState(false);
    const [editorStatus, setEditorStatus] = useState<EditorStatusPayload | null>(null);
    const [closeRequest, setCloseRequest] = useState(0);
    const [focusBodyRequest, setFocusBodyRequest] = useState(0);
    const [retryRequest, setRetryRequest] = useState(0);
    const activeEditorTokenRef = useRef("");
    const documentRef = useRef<EditorDocument | null>(null);
    const loadedDocumentIdRef = useRef<string | null>(null);
    const latestTitlesRef = useRef(new Map<string, string>());
    const readAbortRef = useRef<AbortController | null>(null);
    const readGenerationRef = useRef(0);
    const readSubscriptionRef = useRef<(() => void) | null>(null);
    const titleRevisionRef = useRef(0);

    const applyDocumentUpdate = useCallback((generation: number, value: EditorDocument | null) => {
      if (readGenerationRef.current !== generation) return;
      if (value === null) {
        documentRef.current = null;
        setDocument(null);
        setError("This document is no longer available.");
        return;
      }

      const previous = documentRef.current;
      const localTitle = latestTitlesRef.current.get(value.id);
      const titleCanFollowRemote =
        previous?.id === value.id && (localTitle === previous.title || localTitle === value.title);
      documentRef.current = value;
      loadedDocumentIdRef.current = value.id;
      setDocument(value);
      if (titleCanFollowRemote) {
        latestTitlesRef.current.set(value.id, value.title);
        setTitle(value.title);
      }
    }, []);

    const closeDocumentRead = useCallback(() => {
      readGenerationRef.current += 1;
      readAbortRef.current?.abort();
      readAbortRef.current = null;
      readSubscriptionRef.current?.();
      readSubscriptionRef.current = null;
    }, []);

    const read = useCallback(() => {
      const generation = readGenerationRef.current + 1;
      readGenerationRef.current = generation;
      readAbortRef.current?.abort();
      readSubscriptionRef.current?.();
      readSubscriptionRef.current = null;
      const readAbort = new AbortController();
      readAbortRef.current = readAbort;
      activeEditorTokenRef.current = "";
      setReadyEditorToken("");
      setPlaceholderVisible(true);
      setEditorStatus(null);
      setTitleFocused(false);
      setWebViewCrash(null);
      if (!id) {
        setDocument(null);
        setError("This document link is missing an id.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      const subscription = documentOpen(id, readAbort.signal, (value) =>
        applyDocumentUpdate(generation, value),
      );
      readSubscriptionRef.current = subscription.close;
      void subscription.result
        .then((value) => {
          if (readGenerationRef.current !== generation) {
            subscription.close();
            return;
          }
          markMaterialized(id);
          const token = `${value.id}:${generation}`;
          activeEditorTokenRef.current = token;
          loadedDocumentIdRef.current = value.id;
          documentRef.current = value;
          latestTitlesRef.current.set(value.id, value.title);
          titleRevisionRef.current = 0;
          setTitle(value.title);
          setTitleRevision(0);
          setEditorToken(token);
          setDocument(value);
        })
        .catch((reason: unknown) => {
          if (readGenerationRef.current === generation && !isAbortError(reason)) {
            setError(errorMessage(reason));
          }
        })
        .finally(() => {
          if (readGenerationRef.current === generation) setLoading(false);
        });
    }, [applyDocumentUpdate, id]);

    const retainDocumentRead = useCallback(() => {
      if (!id) return;
      const generation = readGenerationRef.current + 1;
      readGenerationRef.current = generation;
      readAbortRef.current?.abort();
      readSubscriptionRef.current?.();
      const readAbort = new AbortController();
      readAbortRef.current = readAbort;
      const subscription = documentOpen(id, readAbort.signal, (value) =>
        applyDocumentUpdate(generation, value),
      );
      readSubscriptionRef.current = subscription.close;
      void subscription.result.catch((reason: unknown) => {
        if (readGenerationRef.current === generation && !isAbortError(reason)) {
          setError(errorMessage(reason));
        }
      });
    }, [applyDocumentUpdate, id]);

    useEffect(() => {
      if (!active || !id) {
        closeDocumentRead();
        return;
      }
      if (loadedDocumentIdRef.current === id && activeEditorTokenRef.current) {
        retainDocumentRead();
      } else {
        read();
      }
      return closeDocumentRead;
    }, [active, closeDocumentRead, id, read, retainDocumentRead]);

    useEffect(() => {
      const subscription = AppState.addEventListener("change", (state) => {
        setApplicationActive(state === "active");
      });
      return () => subscription.remove();
    }, []);

    const editorFailed = useCallback((token: string, message: string) => {
      if (activeEditorTokenRef.current === token) setWebViewCrash(message);
    }, []);
    const editorReady = useCallback(
      async (payload: EditorReadyPayload) => {
        if (activeEditorTokenRef.current === payload.token) {
          if (document) latestTitlesRef.current.set(document.id, payload.title);
          titleRevisionRef.current = payload.titleRevision;
          setTitle(payload.title);
          setTitleRevision(payload.titleRevision);
          setEditorStatus(payload);
          setReadyEditorToken(payload.token);
          setPlaceholderVisible(false);
          if (id) onReady?.(id);
        }
      },
      [document, id, onReady],
    );
    const editorStatusChanged = useCallback(async (token: string, payload: EditorStatusPayload) => {
      if (activeEditorTokenRef.current !== token) return;
      if (payload.titleRevision < titleRevisionRef.current) return;
      setEditorStatus(payload);
    }, []);
    const editorDocumentWrite = useCallback(
      async (splice: TextSplice, base: string): Promise<Pick<EditorDocument, "body" | "title">> => {
        const current = documentRef.current;
        if (!current) throw new Error("Document not found.");
        const desiredTitle = latestTitlesRef.current.get(current.id);
        const titleChanged = desiredTitle !== undefined && desiredTitle !== current.title;
        try {
          return await documentWrite({
            id: current.id,
            splices: [splice],
            base,
            ...(titleChanged ? { title: desiredTitle } : {}),
          });
        } catch (error: unknown) {
          console.error("The embedded document write failed.", error);
          throw error;
        }
      },
      [],
    );
    const inertDocumentWrite = useCallback(
      async (): Promise<Pick<EditorDocument, "body" | "title">> => ({
        body: "",
        title: "Untitled",
      }),
      [],
    );

    useEffect(() => {
      if (!document || !editorToken || readyEditorToken === editorToken || webViewCrash) return;
      const timeout = setTimeout(() => {
        editorFailed(
          editorToken,
          "The editor did not finish opening. Check the Metro connection and try again.",
        );
      }, 30_000);
      return () => clearTimeout(timeout);
    }, [document, editorFailed, editorToken, readyEditorToken, webViewCrash]);

    const dom = useMemo<DOMProps>(
      () => ({
        automaticallyAdjustContentInsets: false,
        bounces: true,
        contentInsetAdjustmentBehavior: "never",
        nestedScrollEnabled: false,
        onContentProcessDidTerminate: () => {
          editorFailed(
            editorToken,
            "The editor process stopped. Recent local drafts are recovered when possible.",
          );
        },
        onError: (event) => {
          editorFailed(editorToken, `The editor could not load: ${event.nativeEvent.description}`);
        },
        onHttpError: (event) => {
          editorFailed(
            editorToken,
            `The editor request failed with HTTP ${event.nativeEvent.statusCode}.`,
          );
        },
        onRenderProcessGone: () => {
          editorFailed(
            editorToken,
            "The editor process stopped. Recent local drafts are recovered when possible.",
          );
        },
        overScrollMode: "never",
        scrollEnabled: true,
        style: styles.webView,
      }),
      [editorFailed, editorToken],
    );

    const switchingDocument = document !== null && document.id !== id;
    const materializedDocument =
      document && document.id.startsWith(materializedIdPrefix) ? document : null;
    const showPlaceholder = placeholderVisible;
    const visibleError = webViewCrash ?? error;
    useEffect(() => {
      if (visibleError && id) onReady?.(id);
    }, [id, onReady, visibleError]);
    const preview = useMemo(
      () => (document && !switchingDocument ? documentPreview(document.body) : ""),
      [document, switchingDocument],
    );
    const writeTitle = useCallback(
      (value: string) => {
        const revision = titleRevisionRef.current + 1;
        titleRevisionRef.current = revision;
        if (document) latestTitlesRef.current.set(document.id, value);
        setTitle(value);
        setTitleRevision(revision);
        setEditorStatus((status) => ({
          error: null,
          recoveryUnavailable: status?.recoveryUnavailable ?? false,
          state: "dirty",
          titleRevision: revision,
        }));
      },
      [document],
    );
    const requestClose = useCallback(() => {
      Keyboard.dismiss();
      setTitleFocused(false);
      const settledTitle = title.trim() || "Untitled";
      if (settledTitle !== title) writeTitle(settledTitle);
      if (document && !switchingDocument && activeEditorTokenRef.current) {
        void documentWrite({ id: document.id, splices: [], title: settledTitle }).catch(
          (reason: unknown) => {
            console.error("The document title could not be flushed while closing.", reason);
          },
        );
        setCloseRequest((value) => value + 1);
      }
      onClose();
    }, [document, onClose, switchingDocument, title, visibleError, writeTitle]);
    useImperativeHandle(ref, () => ({ requestClose }), [requestClose]);
    const settleTitle = useCallback(() => {
      const settledTitle = title.trim() || "Untitled";
      if (settledTitle !== title) writeTitle(settledTitle);
    }, [title, writeTitle]);
    const retryEditor = useCallback(() => {
      if (visibleError) {
        read();
        return;
      }
      setRetryRequest((value) => value + 1);
    }, [read, visibleError]);
    const headerState: EditorSaveState | "opening" = visibleError
      ? "error"
      : (editorStatus?.state ?? "opening");
    const editorActive =
      active &&
      applicationActive &&
      !loading &&
      !switchingDocument &&
      !titleFocused &&
      !visibleError;
    return (
      <View style={styles.page}>
        <EditorHeader
          connection={connection}
          editable={
            Boolean(document) &&
            !loading &&
            activeEditorTokenRef.current === editorToken &&
            readyEditorToken === editorToken &&
            !visibleError
          }
          onBack={requestClose}
          onFocus={() => setTitleFocused(true)}
          onRetry={retryEditor}
          onSubmit={() => {
            settleTitle();
            setTitleFocused(false);
            setFocusBodyRequest((value) => value + 1);
          }}
          onTitleChange={writeTitle}
          onTitleEnd={() => {
            settleTitle();
            setTitleFocused(false);
          }}
          state={headerState}
          title={title}
          retryLabel={visibleError ? "Retry opening editor" : "Retry save"}
        />
        {visibleError ? (
          <View style={styles.errorPage}>
            <View style={styles.state}>
              <View style={styles.errorCard}>
                <Text selectable style={styles.eyebrow}>
                  Convex embedded
                </Text>
                <Text selectable style={styles.stateTitle}>
                  Editor unavailable
                </Text>
                <Text selectable style={styles.errorCopy}>
                  {visibleError}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={read}
                  style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
                >
                  <Text style={styles.retryLabel}>Open again</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.editorStage}>
            <View
              accessibilityElementsHidden={showPlaceholder}
              importantForAccessibility={showPlaceholder ? "no-hide-descendants" : "auto"}
              style={styles.editorFrame}
            >
              <DocumentEditor
                active={materializedDocument ? editorActive : false}
                closeRequest={closeRequest}
                document={materializedDocument ?? warmDocument}
                documentWrite={materializedDocument ? editorDocumentWrite : inertDocumentWrite}
                dom={dom}
                editorReady={editorReady}
                editorStatusChanged={editorStatusChanged}
                editorToken={editorToken}
                focusBodyRequest={focusBodyRequest}
                retryRequest={retryRequest}
                title={title}
                titleRevision={titleRevision}
              />
            </View>
            {showPlaceholder ? (
              <View
                accessibilityLabel="Opening the local document"
                accessibilityRole="progressbar"
                accessible
                importantForAccessibility="yes"
                pointerEvents="auto"
                style={styles.placeholder}
              >
                <View style={styles.placeholderBody}>
                  {preview ? (
                    <Text numberOfLines={8} style={styles.placeholderCopy}>
                      {preview}
                    </Text>
                  ) : (
                    <>
                      <View style={styles.placeholderLine} />
                      <View style={[styles.placeholderLine, styles.placeholderLineShort]} />
                    </>
                  )}
                </View>
              </View>
            ) : null}
          </View>
        )}
      </View>
    );
  },
);

function EditorHeader({
  connection,
  editable,
  onBack,
  onFocus,
  onRetry,
  onSubmit,
  onTitleChange,
  onTitleEnd,
  retryLabel,
  state,
  title,
}: {
  connection: ReturnType<typeof useEmbeddedConnectionState>;
  editable: boolean;
  onBack: () => void;
  onFocus: () => void;
  onRetry: () => void;
  onSubmit: () => void;
  onTitleChange: (value: string) => void;
  onTitleEnd: () => void;
  retryLabel: string;
  state: EditorSaveState | "opening";
  title: string;
}) {
  const status = documentStatus(state, connection);
  const color = statusColor(status.tone);
  return (
    <View style={styles.editorHeader}>
      <Pressable
        accessibilityLabel="Back to documents"
        accessibilityRole="button"
        hitSlop={8}
        onPress={onBack}
        style={({ pressed }) => [styles.headerBack, pressed && styles.headerBackPressed]}
      >
        <Text allowFontScaling={false} style={styles.headerBackLabel}>
          ‹
        </Text>
      </Pressable>
      <TextInput
        accessibilityLabel="Document title"
        autoCapitalize="sentences"
        editable={editable}
        enterKeyHint="next"
        maxLength={90}
        onChangeText={onTitleChange}
        onEndEditing={onTitleEnd}
        onFocus={onFocus}
        onSubmitEditing={onSubmit}
        placeholder="Untitled"
        placeholderTextColor={colors.content.tertiary}
        returnKeyType="next"
        selectionColor={colors.accent}
        submitBehavior="blurAndSubmit"
        style={[styles.headerTitleInput, !editable && styles.headerTitleDisabled]}
        value={title}
      />
      {state === "error" ? (
        <Pressable
          accessibilityLabel={retryLabel}
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => [
            styles.headerStatus,
            styles.headerStatusActive,
            pressed && styles.headerStatusPressed,
          ]}
        >
          <EditorStatusContent color={color} label={status.label} />
        </Pressable>
      ) : (
        <View
          accessibilityLabel={status.accessibilityLabel}
          accessibilityLiveRegion="polite"
          accessibilityRole="text"
          accessible
          style={[styles.headerStatus, status.emphasized && styles.headerStatusActive]}
        >
          <EditorStatusContent color={color} label={status.label} />
        </View>
      )}
    </View>
  );
}

function EditorStatusContent({ color, label }: { color: string; label: string }) {
  return (
    <>
      <View style={[styles.headerStatusDot, { backgroundColor: color }]} />
      <Text numberOfLines={1} style={styles.headerStatusLabel}>
        {label}
      </Text>
    </>
  );
}

function statusColor(tone: DocumentStatusTone): string {
  if (tone === "error") return colors.content.error;
  if (tone === "idle") return colors.content.tertiary;
  if (tone === "progress") return "#63a8f8";
  if (tone === "warning") return "#e6e2a8";
  return "#b4ec92";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.background.secondary,
  },
  webView: {
    flex: 1,
    backgroundColor: colors.background.secondary,
  },
  editorStage: {
    flex: 1,
    backgroundColor: colors.background.secondary,
  },
  errorPage: {
    flex: 1,
    backgroundColor: colors.background.secondary,
  },
  editorFrame: {
    flex: 1,
  },
  placeholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background.secondary,
  },
  editorHeader: {
    minHeight: 56,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.background.secondary,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerBack: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  headerBackPressed: {
    backgroundColor: colors.background.tertiary,
  },
  headerBackLabel: {
    marginTop: -2,
    color: colors.content.primary,
    fontSize: 34,
    fontWeight: "300",
    lineHeight: 40,
  },
  headerTitleInput: {
    minWidth: 0,
    height: 40,
    flex: 1,
    color: colors.content.primary,
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: -0.2,
    lineHeight: 24,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  headerTitleDisabled: {
    opacity: 0.82,
  },
  headerStatus: {
    minWidth: 64,
    minHeight: 32,
    paddingHorizontal: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 7,
    borderRadius: 999,
  },
  headerStatusActive: {
    paddingHorizontal: 9,
    backgroundColor: colors.background.tertiary,
  },
  headerStatusPressed: {
    opacity: 0.72,
  },
  headerStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  headerStatusLabel: {
    color: colors.content.secondary,
    fontSize: 11,
    fontWeight: "600",
  },
  placeholderBody: {
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 16,
  },
  placeholderCopy: {
    color: colors.content.primary,
    fontSize: 16,
    lineHeight: 26.5,
  },
  placeholderLine: {
    width: "82%",
    height: 12,
    backgroundColor: colors.background.tertiary,
    borderRadius: 4,
  },
  placeholderLineShort: {
    width: "58%",
  },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
    backgroundColor: colors.background.secondary,
  },
  errorCard: {
    width: "100%",
    maxWidth: 440,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.background.secondary,
    padding: 20,
  },
  eyebrow: {
    color: colors.content.tertiary,
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  stateTitle: {
    color: colors.content.primary,
    fontSize: 22,
    fontWeight: "600",
  },
  errorCopy: {
    color: colors.content.error,
    fontSize: 13,
    lineHeight: 19,
  },
  retry: {
    alignSelf: "flex-start",
    marginTop: 6,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.3)",
    borderRadius: 8,
    backgroundColor: colors.accent,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  retryPressed: {
    opacity: 0.78,
  },
  retryLabel: {
    color: colors.content.primary,
    fontSize: 13,
    fontWeight: "600",
  },
});
