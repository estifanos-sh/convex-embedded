import { api } from "$convex/_generated/api";
import type { Id } from "$convex/_generated/dataModel";
import type { DOMProps } from "expo/dom";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";

import DocumentEditor from "@/src/editor";
import { client } from "@/src/client";
import { documentPreview } from "@/src/preview";
import { colors } from "@/src/theme";
import type { DocumentWrite, EditorDocument } from "@/src/types";

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

export function DocumentScreen({
  active = true,
  documentId: id,
  onReady,
}: {
  active?: boolean;
  documentId?: string;
  onReady?: (id: string) => void;
}) {
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorToken, setEditorToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [readyEditorToken, setReadyEditorToken] = useState("");
  const [applicationActive, setApplicationActive] = useState(AppState.currentState === "active");
  const [placeholderVisible, setPlaceholderVisible] = useState(true);
  const [webViewCrash, setWebViewCrash] = useState<string | null>(null);
  const activeEditorTokenRef = useRef("");
  const editorHasPaintedRef = useRef(false);
  const readGenerationRef = useRef(0);

  const read = useCallback(() => {
    const generation = readGenerationRef.current + 1;
    readGenerationRef.current = generation;
    activeEditorTokenRef.current = "";
    if (!editorHasPaintedRef.current) {
      setPlaceholderVisible(true);
    }
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
  const currentEditorFailed = useCallback(
    (message: string) => {
      const token = activeEditorTokenRef.current;
      if (token) editorFailed(token, message);
    },
    [editorFailed],
  );
  const editorReady = useCallback(
    async (token: string) => {
      if (activeEditorTokenRef.current === token) {
        editorHasPaintedRef.current = true;
        setReadyEditorToken(token);
        setPlaceholderVisible(false);
        if (id) onReady?.(id);
      }
    },
    [id, onReady],
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
        currentEditorFailed(
          "The editor process stopped. Recent local drafts are recovered when possible.",
        );
      },
      onError: (event) => {
        currentEditorFailed(`The editor could not load: ${event.nativeEvent.description}`);
      },
      onHttpError: (event) => {
        currentEditorFailed(`The editor request failed with HTTP ${event.nativeEvent.statusCode}.`);
      },
      onRenderProcessGone: () => {
        currentEditorFailed(
          "The editor process stopped. Recent local drafts are recovered when possible.",
        );
      },
      overScrollMode: "never",
      scrollEnabled: true,
      style: styles.webView,
    }),
    [currentEditorFailed],
  );

  const switchingDocument = document !== null && document.id !== id;
  const showPlaceholder = placeholderVisible;
  const visibleError = switchingDocument ? null : (webViewCrash ?? error);
  const preview = useMemo(
    () => (document && !switchingDocument ? documentPreview(document.body) : ""),
    [document, switchingDocument],
  );
  return (
    <View style={styles.page}>
      {visibleError ? (
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
      ) : (
        <View style={styles.editorStage}>
          {document ? (
            <View
              accessibilityElementsHidden={showPlaceholder}
              importantForAccessibility={showPlaceholder ? "no-hide-descendants" : "auto"}
              style={styles.editorFrame}
            >
              <DocumentEditor
                active={active && applicationActive && !loading && !switchingDocument}
                document={document}
                documentWrite={documentWrite}
                dom={dom}
                editorReady={editorReady}
                editorToken={editorToken}
              />
            </View>
          ) : null}
          {showPlaceholder ? (
            <View
              accessibilityLabel="Opening the local document"
              accessibilityRole="progressbar"
              accessibilityViewIsModal
              importantForAccessibility="yes"
              pointerEvents="box-only"
              style={styles.placeholder}
            >
              <View style={styles.placeholderHeader}>
                {document && !switchingDocument ? (
                  <Text numberOfLines={1} style={styles.placeholderTitle}>
                    {document.title || "Untitled"}
                  </Text>
                ) : (
                  <View style={styles.placeholderTitleBar} />
                )}
                <View style={styles.placeholderSave}>
                  <View style={styles.placeholderDot} />
                  <Text style={styles.placeholderSaveLabel}>Saved</Text>
                </View>
              </View>
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
  editorFrame: {
    flex: 1,
  },
  placeholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background.secondary,
    paddingHorizontal: 20,
    paddingTop: 14,
  },
  placeholderHeader: {
    minHeight: 42,
    marginBottom: 4,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  placeholderSave: {
    minHeight: 28,
    marginTop: 2,
    paddingHorizontal: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: colors.background.tertiary,
    borderRadius: 999,
    transform: [{ translateY: 8 }],
  },
  placeholderDot: {
    width: 7,
    height: 7,
    backgroundColor: "#b4ec92",
    borderRadius: 999,
  },
  placeholderSaveLabel: {
    color: colors.content.secondary,
    fontSize: 11,
    fontWeight: "600",
  },
  placeholderTitle: {
    flex: 1,
    color: colors.content.primary,
    fontSize: 30,
    fontWeight: "600",
    letterSpacing: -1,
    lineHeight: 32,
    transform: [{ translateY: 10 }],
  },
  placeholderTitleBar: {
    flex: 1,
    height: 30,
    backgroundColor: colors.background.tertiary,
    borderRadius: 6,
  },
  placeholderBody: {
    gap: 12,
    paddingTop: 0,
  },
  placeholderCopy: {
    color: colors.content.primary,
    fontSize: 16,
    lineHeight: 27.5,
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
