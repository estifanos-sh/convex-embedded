import { api } from "$convex/_generated/api";
import type { Id } from "$convex/_generated/dataModel";
import type { DOMProps } from "expo/dom";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  InteractionManager,
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
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [interactionReady, setInteractionReady] = useState(false);
  const [webViewCrash, setWebViewCrash] = useState<string | null>(null);
  const readGenerationRef = useRef(0);

  const read = useCallback(() => {
    const generation = readGenerationRef.current + 1;
    readGenerationRef.current = generation;
    if (!id) {
      setDocument(null);
      setError("This document link is missing an id.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setDocument(null);
    setWebViewCrash(null);
    void documentRead(id)
      .then((value) => {
        if (readGenerationRef.current !== generation) return;
        if (!value) {
          setError("Document not found in embedded storage.");
          return;
        }
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
    };
  }, [read]);

  useEffect(() => {
    setInteractionReady(false);
    const task = InteractionManager.runAfterInteractions(() => setInteractionReady(true));
    return () => task.cancel();
  }, [id]);

  const onContentProcessDidTerminate = useCallback(() => {
    setWebViewCrash("The editor process stopped. Recent local drafts are recovered when possible.");
  }, []);
  const onRenderProcessGone = useCallback(() => {
    setWebViewCrash("The editor process stopped. Recent local drafts are recovered when possible.");
  }, []);
  const dom = useMemo<DOMProps>(
    () => ({
      automaticallyAdjustContentInsets: false,
      bounces: true,
      contentInsetAdjustmentBehavior: "never",
      nestedScrollEnabled: false,
      onContentProcessDidTerminate,
      onRenderProcessGone,
      overScrollMode: "never",
      scrollEnabled: true,
      style: styles.webView,
    }),
    [onContentProcessDidTerminate, onRenderProcessGone],
  );

  const visibleError = webViewCrash ?? error;
  return (
    <View style={styles.page}>
      <Stack.Screen
        options={{
          headerBackTitle: "Documents",
          headerStyle: styles.header,
          headerTintColor: colors.content.primary,
          headerTitle: "Document",
        }}
      />
      {loading || (!interactionReady && !visibleError) ? (
        <View style={styles.state}>
          <ActivityIndicator color={colors.accent} />
          <Text selectable style={styles.stateCopy}>
            Opening the local document…
          </Text>
        </View>
      ) : visibleError ? (
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
      ) : document ? (
        <DocumentEditor
          key={document.id}
          document={document}
          documentWrite={documentWrite}
          dom={dom}
        />
      ) : null}
    </View>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  header: {
    backgroundColor: colors.background.secondary,
  },
  webView: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
    backgroundColor: colors.background.primary,
  },
  stateCopy: {
    color: colors.content.tertiary,
    fontSize: 13,
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
