import { api } from "$convex/_generated/api";
import type { Id } from "$convex/_generated/dataModel";
import type { DOMProps } from "expo/dom";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import DocumentEditor from "@/src/editor";
import { client } from "@/src/client";
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
}: {
  active?: boolean;
  documentId?: string;
}) {
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorToken, setEditorToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [editorPainted, setEditorPainted] = useState(false);
  const [applicationActive, setApplicationActive] = useState(AppState.currentState === "active");
  const [placeholderVisible, setPlaceholderVisible] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [webViewCrash, setWebViewCrash] = useState<string | null>(null);
  const activeEditorTokenRef = useRef("");
  const readGenerationRef = useRef(0);
  const placeholderOpacity = useRef(new Animated.Value(1)).current;

  const read = useCallback(() => {
    const generation = readGenerationRef.current + 1;
    readGenerationRef.current = generation;
    activeEditorTokenRef.current = "";
    setEditorToken("");
    setEditorPainted(false);
    setPlaceholderVisible(true);
    placeholderOpacity.setValue(1);
    setWebViewCrash(null);
    if (!id) {
      setDocument(null);
      setError("This document link is missing an id.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setDocument(null);
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
  }, [id, placeholderOpacity]);

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

  useEffect(() => {
    let active = true;
    let eventReceived = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active && !eventReceived) setReduceMotion(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      eventReceived = true;
      if (active) setReduceMotion(value);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!editorPainted) return;
    const animation = Animated.timing(placeholderOpacity, {
      duration: reduceMotion ? 0 : 150,
      toValue: 0,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setPlaceholderVisible(false);
    });
    return () => animation.stop();
  }, [editorPainted, placeholderOpacity, reduceMotion]);

  const editorFailed = useCallback((token: string, message: string) => {
    if (activeEditorTokenRef.current === token) setWebViewCrash(message);
  }, []);
  const editorReady = useCallback(async (token: string) => {
    if (activeEditorTokenRef.current === token) setEditorPainted(true);
  }, []);

  useEffect(() => {
    if (!document || !editorToken || editorPainted || webViewCrash) return;
    const timeout = setTimeout(() => {
      editorFailed(
        editorToken,
        "The editor did not finish opening. Check the Metro connection and try again.",
      );
    }, 30_000);
    return () => clearTimeout(timeout);
  }, [document, editorFailed, editorPainted, editorToken, webViewCrash]);

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

  const visibleError = webViewCrash ?? error;
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
          {!loading && document ? (
            <View
              accessibilityElementsHidden={placeholderVisible}
              importantForAccessibility={placeholderVisible ? "no-hide-descendants" : "auto"}
              style={styles.editorFrame}
            >
              <DocumentEditor
                active={active && applicationActive}
                key={editorToken}
                document={document}
                documentWrite={documentWrite}
                dom={dom}
                editorReady={editorReady}
                editorToken={editorToken}
              />
            </View>
          ) : null}
          {placeholderVisible ? (
            <Animated.View
              accessibilityLabel="Opening the local document"
              accessibilityRole="progressbar"
              accessibilityViewIsModal
              importantForAccessibility="yes"
              pointerEvents="box-only"
              style={[styles.placeholder, { opacity: placeholderOpacity }]}
            >
              <View style={styles.placeholderStatus}>
                <View style={styles.placeholderSave}>
                  <View style={styles.placeholderDot} />
                  <Text style={styles.placeholderSaveLabel}>Opening</Text>
                </View>
              </View>
              {document ? (
                <Text numberOfLines={2} style={styles.placeholderTitle}>
                  {document.title || "Untitled"}
                </Text>
              ) : (
                <View style={styles.placeholderTitleBar} />
              )}
              <View style={styles.placeholderBody}>
                <View style={styles.placeholderLine} />
                <View style={[styles.placeholderLine, styles.placeholderLineShort]} />
              </View>
            </Animated.View>
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
    paddingTop: 22,
  },
  placeholderStatus: {
    minHeight: 30,
    marginBottom: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  placeholderSave: {
    minHeight: 30,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: colors.background.tertiary,
    borderRadius: 999,
  },
  placeholderDot: {
    width: 7,
    height: 7,
    backgroundColor: "#63a8f8",
    borderRadius: 999,
  },
  placeholderSaveLabel: {
    color: colors.content.secondary,
    fontSize: 11,
    fontWeight: "600",
  },
  placeholderTitle: {
    color: colors.content.primary,
    fontSize: 34,
    fontWeight: "600",
    letterSpacing: -1,
    lineHeight: 39,
    paddingBottom: 16,
  },
  placeholderTitleBar: {
    width: "44%",
    height: 34,
    marginBottom: 21,
    backgroundColor: colors.background.tertiary,
    borderRadius: 6,
  },
  placeholderBody: {
    gap: 12,
    paddingTop: 30,
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
