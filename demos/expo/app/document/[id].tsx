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
import { documentPreview } from "@/src/preview";
import { colors } from "@/src/theme";
import type {
  DocumentWrite,
  EditorDocument,
  EditorReadyPayload,
  EditorSaveState,
  EditorStatusPayload,
} from "@/src/types";

async function documentRead(id: string): Promise<EditorDocument | null> {
  const document = await client.query(api.documents.get, { id: id as Id<"documents"> });
  if (!document) return null;
  return {
    body: document.body,
    id: document._id,
    title: document.title,
  };
}

async function documentWrite(write: DocumentWrite): Promise<void> {
  await client.mutation(api.documents.writeBody, {
    id: write.id as Id<"documents">,
    splices: write.splices,
    ...(write.title === undefined ? {} : { title: write.title }),
  });
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
    const [document, setDocument] = useState<EditorDocument | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editorToken, setEditorToken] = useState("");
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
    const latestTitlesRef = useRef(new Map<string, string>());
    const readGenerationRef = useRef(0);
    const titleRevisionRef = useRef(0);

    const read = useCallback(() => {
      const generation = readGenerationRef.current + 1;
      readGenerationRef.current = generation;
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
      void documentRead(id)
        .then((value) => {
          if (readGenerationRef.current !== generation) return;
          if (!value) {
            setError("Document not found in embedded storage.");
            return;
          }
          const token = `${value.id}:${generation}`;
          activeEditorTokenRef.current = token;
          latestTitlesRef.current.set(value.id, value.title);
          titleRevisionRef.current = 0;
          setTitle(value.title);
          setTitleRevision(0);
          setEditorToken(token);
          setDocument(value);
        })
        .catch((reason: unknown) => {
          if (readGenerationRef.current === generation) setError(errorMessage(reason));
        })
        .finally(() => {
          if (readGenerationRef.current === generation) setLoading(false);
        });
    }, [id]);

    useEffect(() => {
      read();
      return () => {
        readGenerationRef.current += 1;
        activeEditorTokenRef.current = "";
      };
    }, [read]);

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
    const editorDocumentWrite = useCallback(async (write: DocumentWrite) => {
      const title = write.title === latestTitlesRef.current.get(write.id) ? write.title : undefined;
      if (write.splices.length === 0 && title === undefined) return;
      await documentWrite({
        id: write.id,
        splices: write.splices,
        ...(title === undefined ? {} : { title }),
      });
    }, []);

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
            {document ? (
              <View
                accessibilityElementsHidden={showPlaceholder}
                importantForAccessibility={showPlaceholder ? "no-hide-descendants" : "auto"}
                style={styles.editorFrame}
              >
                <DocumentEditor
                  active={editorActive}
                  closeRequest={closeRequest}
                  document={document}
                  documentWrite={editorDocumentWrite}
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
            ) : null}
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
  const status = editorStatusView(state);
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
          <EditorStatusContent color={status.color} label={status.label} />
        </Pressable>
      ) : (
        <View
          accessibilityLabel={status.label}
          accessibilityLiveRegion="polite"
          accessibilityRole="text"
          accessible
          style={[
            styles.headerStatus,
            state !== "saved" && state !== "opening" && styles.headerStatusActive,
          ]}
        >
          <EditorStatusContent color={status.color} label={status.label} />
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

function editorStatusView(state: EditorSaveState | "opening"): { color: string; label: string } {
  if (state === "dirty") return { color: "#e6e2a8", label: "Unsaved" };
  if (state === "error") return { color: colors.content.error, label: "Retry" };
  if (state === "opening") return { color: colors.content.tertiary, label: "Opening" };
  if (state === "recovered") return { color: "#e6e2a8", label: "Recovered" };
  if (state === "saving") return { color: "#63a8f8", label: "Saving" };
  return { color: "#b4ec92", label: "Saved" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
