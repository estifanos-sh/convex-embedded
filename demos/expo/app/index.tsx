import { api } from "$convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { Stack } from "expo-router/stack";
import * as React from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { client } from "@/src/client";
import { useEmbeddedQuery } from "@/src/query";
import { colors, fontSize, radius, spacing } from "@/src/theme";
import { DocumentScreen } from "./document/[id]";

const summaryArgs = { limit: 40 } as const;

type DocumentSummary = FunctionReturnType<typeof api.documents.summaries>[number];

export default function DocumentsScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ document?: string | string[] }>();
  const linkedDocumentId = Array.isArray(params.document) ? params.document[0] : params.document;
  const query = useEmbeddedQuery(api.documents.summaries, summaryArgs);
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = React.useState<string | null>(
    linkedDocumentId ?? null,
  );
  const [editorVisible, setEditorVisible] = React.useState(linkedDocumentId !== undefined);

  const openDocument = React.useCallback((id: string) => {
    setSelectedDocumentId(id);
    setEditorVisible(true);
  }, []);
  const closeDocument = React.useCallback(() => {
    Keyboard.dismiss();
    setEditorVisible(false);
    if (linkedDocumentId !== undefined) router.setParams({ document: undefined });
  }, [linkedDocumentId]);

  React.useEffect(() => {
    if (linkedDocumentId !== undefined) openDocument(linkedDocumentId);
  }, [linkedDocumentId, openDocument]);

  const createDocument = React.useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    if (process.env.EXPO_OS === "ios") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    try {
      const document = await client.mutation(api.documents.create, {});
      openDocument(document._id);
    } catch (error: unknown) {
      setCreateError(error instanceof Error ? error.message : "The document could not be created.");
    } finally {
      setCreating(false);
    }
  }, [creating, openDocument]);

  React.useEffect(() => {
    if (!editorVisible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      closeDocument();
      return true;
    });
    return () => subscription.remove();
  }, [closeDocument, editorVisible]);

  const documents: DocumentSummary[] = query.status === "ready" ? query.value : [];

  React.useEffect(() => {
    if (selectedDocumentId !== null || documents.length === 0) return;
    setSelectedDocumentId(documents[0]._id);
  }, [documents, selectedDocumentId]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.screen}>
        <View style={[styles.navigationBar, { height: insets.top + 56, paddingTop: insets.top }]}>
          <View style={styles.navigationSlot}>
            {editorVisible ? (
              <Pressable
                accessibilityLabel="Back to documents"
                accessibilityRole="button"
                hitSlop={8}
                onPress={closeDocument}
                style={({ pressed }) => [styles.headerBack, pressed && styles.headerButtonPressed]}
              >
                <Text style={styles.headerBackLabel}>‹</Text>
              </Pressable>
            ) : null}
          </View>
          <Text numberOfLines={1} style={styles.navigationTitle}>
            {editorVisible ? "" : "Documents"}
          </Text>
          <View style={[styles.navigationSlot, styles.navigationSlotRight]}>
            {!editorVisible ? (
              <Pressable
                accessibilityLabel="Create document"
                accessibilityRole="button"
                disabled={creating}
                hitSlop={8}
                onPress={() => void createDocument()}
                style={({ pressed }) => [
                  styles.headerButton,
                  styles.headerButtonSurface,
                  pressed && styles.buttonPressed,
                  creating && styles.buttonDisabled,
                ]}
              >
                {creating ? (
                  <ActivityIndicator color={colors.content.primary} size="small" />
                ) : (
                  <Text style={styles.headerButtonLabel}>+</Text>
                )}
              </Pressable>
            ) : null}
          </View>
        </View>
        <View style={styles.contentArea}>
          {selectedDocumentId ? (
            <View
              accessibilityElementsHidden={!editorVisible}
              importantForAccessibility={editorVisible ? "auto" : "no-hide-descendants"}
              onAccessibilityEscape={() => {
                closeDocument();
              }}
              pointerEvents={editorVisible ? "auto" : "none"}
              style={styles.editorLayer}
            >
              <DocumentScreen active={editorVisible} documentId={selectedDocumentId} />
            </View>
          ) : null}
          <View
            accessibilityElementsHidden={editorVisible}
            importantForAccessibility={editorVisible ? "no-hide-descendants" : "auto"}
            pointerEvents={editorVisible ? "none" : "auto"}
            style={[styles.listLayer, editorVisible && styles.listLayerHidden]}
          >
            <FlatList
              contentInsetAdjustmentBehavior="never"
              contentContainerStyle={documents.length === 0 ? styles.emptyContent : styles.content}
              data={documents}
              keyExtractor={(document) => document._id}
              ListHeaderComponent={
                createError ? (
                  <View accessibilityRole="alert" style={styles.errorBanner}>
                    <Text selectable style={styles.errorText}>
                      {createError}
                    </Text>
                  </View>
                ) : null
              }
              ListEmptyComponent={
                <QueryState
                  creating={creating}
                  onCreate={createDocument}
                  onRetry={query.retry}
                  state={query}
                />
              }
              renderItem={({ item }) => (
                <DocumentRow document={item} onOpen={() => openDocument(item._id)} />
              )}
              style={styles.list}
            />
          </View>
        </View>
      </View>
    </>
  );
}

function DocumentRow({ document, onOpen }: { document: DocumentSummary; onOpen: () => void }) {
  return (
    <Pressable
      accessibilityHint="Opens this document"
      accessibilityRole="button"
      onPress={onOpen}
      onPressIn={() => {
        if (process.env.EXPO_OS === "ios") void Haptics.selectionAsync();
      }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.documentIcon}
      >
        <View style={styles.documentIconFold} />
        <View style={styles.documentIconLine} />
        <View style={[styles.documentIconLine, styles.documentIconLineShort]} />
      </View>
      <View style={styles.rowCopy}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {document.title || "Untitled"}
        </Text>
        <Text style={styles.rowMeta}>{formatDate(document.updatedAt)}</Text>
      </View>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.chevron}
      >
        ›
      </Text>
    </Pressable>
  );
}

function QueryState({
  creating,
  onCreate,
  onRetry,
  state,
}: {
  creating: boolean;
  onCreate: () => Promise<void>;
  onRetry: () => void;
  state: ReturnType<typeof useEmbeddedQuery<typeof api.documents.summaries>>;
}) {
  if (state.status === "loading") {
    return (
      <View style={styles.state}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.stateCopy}>Opening the embedded store…</Text>
      </View>
    );
  }
  if (state.status === "error") {
    return (
      <View style={styles.state}>
        <Text selectable style={styles.stateTitle}>
          Couldn’t open documents
        </Text>
        <Text selectable style={styles.stateCopy}>
          {state.error.message}
        </Text>
        <ActionButton label="Try again" onPress={onRetry} />
      </View>
    );
  }
  return (
    <View style={styles.state}>
      <View style={styles.emptyIcon}>
        <Text style={styles.emptyIconLabel}>✦</Text>
      </View>
      <Text selectable style={styles.stateTitle}>
        Your local workspace is ready
      </Text>
      <Text selectable style={styles.stateCopy}>
        Create a document. It stays in the embedded database on this device.
      </Text>
      <ActionButton
        disabled={creating}
        label={creating ? "Creating…" : "Create document"}
        onPress={() => void onCreate()}
      />
    </View>
  );
}

function ActionButton({
  disabled = false,
  label,
  onPress,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        pressed && styles.buttonPressed,
        disabled && styles.buttonDisabled,
      ]}
    >
      <Text style={styles.actionButtonLabel}>{label}</Text>
    </Pressable>
  );
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(value);
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background.secondary,
  },
  navigationBar: {
    zIndex: 1,
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.background.secondary,
  },
  navigationSlot: {
    width: 52,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  navigationSlotRight: {
    alignItems: "flex-end",
  },
  navigationTitle: {
    flex: 1,
    color: colors.content.primary,
    fontSize: fontSize.title,
    fontWeight: "700",
    textAlign: "center",
  },
  contentArea: {
    flex: 1,
  },
  list: {
    flex: 1,
    backgroundColor: colors.background.secondary,
  },
  editorLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background.secondary,
  },
  listLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background.secondary,
  },
  listLayerHidden: {
    opacity: 0,
  },
  content: {
    paddingBottom: spacing.lg,
  },
  emptyContent: {
    flexGrow: 1,
    padding: spacing.lg,
  },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.full,
    overflow: "hidden",
  },
  headerButtonSurface: {
    backgroundColor: colors.accent,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.18)",
    borderRadius: radius.full,
  },
  headerButtonPressed: {
    opacity: 0.58,
  },
  headerBack: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.full,
    overflow: "hidden",
    backgroundColor: colors.background.tertiary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  headerBackLabel: {
    marginTop: -3,
    color: colors.content.primary,
    fontSize: 42,
    fontWeight: "300",
    lineHeight: 44,
  },
  headerButtonLabel: {
    color: colors.content.primary,
    fontSize: 26,
    fontWeight: "400",
    lineHeight: 28,
  },
  buttonPressed: {
    backgroundColor: colors.accentPressed,
    opacity: 0.9,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  errorBanner: {
    marginBottom: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.background.error,
    borderRadius: radius.md,
  },
  errorText: {
    color: colors.content.error,
    fontSize: fontSize.caption,
    lineHeight: 18,
  },
  row: {
    minHeight: 68,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: "transparent",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowPressed: {
    backgroundColor: colors.background.tertiary,
  },
  documentIcon: {
    width: 18,
    height: 22,
    borderWidth: 1.5,
    borderColor: colors.content.tertiary,
    borderRadius: 2,
    paddingHorizontal: 3,
    paddingTop: 8,
    gap: 3,
  },
  documentIconFold: {
    position: "absolute",
    top: -1,
    right: -1,
    width: 7,
    height: 7,
    borderLeftWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: colors.content.tertiary,
    backgroundColor: colors.background.secondary,
  },
  documentIconLine: {
    width: 9,
    height: 1.5,
    backgroundColor: colors.content.tertiary,
    borderRadius: 1,
  },
  documentIconLineShort: {
    width: 6,
  },
  rowCopy: {
    flex: 1,
    gap: spacing.xs,
  },
  rowTitle: {
    color: colors.content.primary,
    fontSize: fontSize.body,
    fontWeight: "600",
  },
  rowMeta: {
    color: colors.content.tertiary,
    fontSize: fontSize.caption,
  },
  chevron: {
    color: colors.content.tertiary,
    fontSize: 24,
    fontWeight: "300",
  },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.xxxl,
  },
  stateTitle: {
    maxWidth: 320,
    color: colors.content.primary,
    fontSize: fontSize.title,
    lineHeight: 24,
    fontWeight: "700",
    textAlign: "center",
  },
  stateCopy: {
    maxWidth: 340,
    color: colors.content.secondary,
    fontSize: fontSize.body,
    lineHeight: 22,
    textAlign: "center",
  },
  emptyIcon: {
    width: 64,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background.secondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.xl,
  },
  emptyIconLabel: {
    color: colors.accent,
    fontSize: 30,
  },
  actionButton: {
    minHeight: 46,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
  },
  actionButtonLabel: {
    color: colors.content.primary,
    fontSize: fontSize.body,
    fontWeight: "700",
  },
});
