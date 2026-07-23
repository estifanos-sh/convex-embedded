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
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { client } from "@/src/client";
import {
  markFirstRender,
  markListReady,
  markOpenReady,
  markOpenTap,
  usePerfSnapshot,
} from "@/src/perf";
import { useEmbeddedQuery } from "@/src/query";
import { colors, fontSize, radius, spacing } from "@/src/theme";
import { DocumentScreen, type DocumentScreenHandle } from "./document/[id]";

type DocumentSummary = FunctionReturnType<typeof api.documents.read>[number];

export default function DocumentsScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ document?: string | string[] }>();
  const linkedDocumentId = Array.isArray(params.document) ? params.document[0] : params.document;
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const queryArgs = React.useMemo(() => {
    const prefix = search.trim();
    return prefix ? { limit: 40, prefix } : { limit: 40 };
  }, [search]);
  const query = useEmbeddedQuery(api.documents.read, queryArgs);
  const [openingDocumentId, setOpeningDocumentId] = React.useState<string | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = React.useState<string | null>(
    linkedDocumentId ?? null,
  );
  const [editorVisible, setEditorVisible] = React.useState(linkedDocumentId !== undefined);
  const selectedDocumentIdRef = React.useRef<string | null>(linkedDocumentId ?? null);
  const readyDocumentIdRef = React.useRef<string | null>(null);
  const requestedDocumentIdRef = React.useRef<string | null>(linkedDocumentId ?? null);
  const previousLinkedDocumentIdRef = React.useRef<string | undefined>(linkedDocumentId);
  const documentScreenRef = React.useRef<DocumentScreenHandle>(null);

  const openDocument = React.useCallback((id: string) => {
    const alreadyReady = selectedDocumentIdRef.current === id && readyDocumentIdRef.current === id;
    selectedDocumentIdRef.current = id;
    setSelectedDocumentId(id);
    if (alreadyReady) {
      requestedDocumentIdRef.current = null;
      setOpeningDocumentId(null);
      setEditorVisible(true);
      return;
    }
    readyDocumentIdRef.current = null;
    requestedDocumentIdRef.current = id;
    markOpenTap(id);
    setOpeningDocumentId(id);
    setEditorVisible(false);
  }, []);
  const showReadyDocument = React.useCallback((id: string) => {
    if (selectedDocumentIdRef.current !== id) return;
    readyDocumentIdRef.current = id;
    if (requestedDocumentIdRef.current !== id) return;
    requestedDocumentIdRef.current = null;
    markOpenReady(id);
    setOpeningDocumentId(null);
    setEditorVisible(true);
  }, []);
  const closeDocument = React.useCallback(() => {
    Keyboard.dismiss();
    requestedDocumentIdRef.current = null;
    setOpeningDocumentId(null);
    setEditorVisible(false);
    if (linkedDocumentId !== undefined) router.setParams({ document: undefined });
  }, [linkedDocumentId]);
  const requestCloseDocument = React.useCallback(() => {
    const editor = documentScreenRef.current;
    if (editor) {
      editor.requestClose();
      return;
    }
    closeDocument();
  }, [closeDocument]);

  React.useEffect(() => {
    const previous = previousLinkedDocumentIdRef.current;
    previousLinkedDocumentIdRef.current = linkedDocumentId;
    if (linkedDocumentId !== undefined && linkedDocumentId !== previous) {
      openDocument(linkedDocumentId);
    } else if (linkedDocumentId === undefined && previous !== undefined) {
      requestedDocumentIdRef.current = null;
      setOpeningDocumentId(null);
      setEditorVisible(false);
    }
  }, [linkedDocumentId, openDocument]);

  const createDocument = React.useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    if (process.env.EXPO_OS === "ios") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    try {
      const document = await client.mutation(api.documents.write, {});
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
      requestCloseDocument();
      return true;
    });
    return () => subscription.remove();
  }, [editorVisible, requestCloseDocument]);

  const documents: DocumentSummary[] = query.status === "ready" ? query.value : [];

  React.useEffect(() => {
    markFirstRender();
  }, []);

  React.useEffect(() => {
    if (query.status === "ready") markListReady();
  }, [query.status]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.screen}>
        <View
          style={[
            editorVisible ? styles.editorNavigationBar : styles.listNavigationBar,
            { height: insets.top + (editorVisible ? 0 : spacing.sm) },
          ]}
        />
        <View style={styles.contentArea}>
          <View
            accessibilityElementsHidden={!editorVisible}
            importantForAccessibility={editorVisible ? "auto" : "no-hide-descendants"}
            onAccessibilityEscape={() => {
              requestCloseDocument();
            }}
            pointerEvents={editorVisible ? "auto" : "none"}
            style={styles.editorLayer}
          >
            <DocumentScreen
              active={editorVisible || openingDocumentId === selectedDocumentId}
              documentId={selectedDocumentId ?? undefined}
              onClose={closeDocument}
              onReady={showReadyDocument}
              ref={documentScreenRef}
            />
          </View>
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
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              keyExtractor={(document) => document._id}
              ListHeaderComponent={
                <View style={styles.listHeader}>
                  <TextInput
                    accessibilityLabel="Search documents"
                    autoCapitalize="none"
                    autoCorrect={false}
                    clearButtonMode="while-editing"
                    onChangeText={setSearch}
                    placeholder="Search documents"
                    placeholderTextColor={colors.content.tertiary}
                    returnKeyType="search"
                    style={styles.searchInput}
                    value={search}
                  />
                  {createError ? (
                    <View accessibilityRole="alert" style={styles.errorBanner}>
                      <Text selectable style={styles.errorText}>
                        {createError}
                      </Text>
                    </View>
                  ) : null}
                </View>
              }
              ListEmptyComponent={
                search.trim() && query.status === "ready" ? (
                  <View style={styles.state}>
                    <Text selectable style={styles.stateTitle}>
                      No matching documents
                    </Text>
                    <Text selectable style={styles.stateCopy}>
                      Try a different title.
                    </Text>
                  </View>
                ) : (
                  <QueryState
                    creating={creating}
                    onCreate={createDocument}
                    onRetry={query.retry}
                    state={query}
                  />
                )
              }
              renderItem={({ item }) => (
                <DocumentRow
                  document={item}
                  opening={openingDocumentId === item._id}
                  onOpen={() => openDocument(item._id)}
                />
              )}
              style={styles.list}
            />
            <View
              pointerEvents="box-none"
              style={[styles.fabWrap, { bottom: Math.max(20, insets.bottom + 16) }]}
            >
              <Pressable
                accessibilityLabel="Create document"
                accessibilityRole="button"
                disabled={creating}
                hitSlop={8}
                onPress={() => void createDocument()}
                style={({ pressed }) => [
                  styles.fab,
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
            </View>
          </View>
          {__DEV__ ? <PerfHud /> : null}
        </View>
      </View>
    </>
  );
}

function PerfHud() {
  const snapshot = usePerfSnapshot();
  const open = snapshot.lastOpen;
  return (
    <View pointerEvents="none" style={styles.perfHud}>
      <Text style={styles.perfText}>
        JS→render {snapshot.jsStartToRenderMs === null ? "…" : `${snapshot.jsStartToRenderMs}ms`} ·
        →list {snapshot.jsStartToListMs === null ? "…" : `${snapshot.jsStartToListMs}ms`}
      </Text>
      {open ? (
        <Text style={styles.perfText}>
          open {open.warm ? "(warm)" : "(cold)"} …{open.id.slice(-4)}: tap→data{" "}
          {open.tapToMaterializedMs === null ? "?" : `${open.tapToMaterializedMs}ms`} · data→editor{" "}
          {open.materializedToReadyMs === null ? "?" : `${open.materializedToReadyMs}ms`} · total{" "}
          {open.totalMs}ms
        </Text>
      ) : (
        <Text style={styles.perfText}>tap a document to measure open cost</Text>
      )}
    </View>
  );
}

function DocumentRow({
  document,
  opening,
  onOpen,
}: {
  document: DocumentSummary;
  opening: boolean;
  onOpen: () => void;
}) {
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
      {opening ? (
        <ActivityIndicator color={colors.content.secondary} size="small" />
      ) : (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.chevron}
        >
          ›
        </Text>
      )}
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
  state: ReturnType<typeof useEmbeddedQuery<typeof api.documents.read>>;
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
        Your workspace is ready
      </Text>
      <Text selectable style={styles.stateCopy}>
        Create a document. Changes are stored instantly and remain available offline.
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
  perfHud: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    padding: 8,
    backgroundColor: "rgba(0, 0, 0, 0.82)",
    borderRadius: 8,
    gap: 3,
    zIndex: 1000,
  },
  perfText: {
    color: "#69f0ae",
    fontSize: 11,
    lineHeight: 15,
    fontVariant: ["tabular-nums"],
  },
  screen: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  editorNavigationBar: {
    backgroundColor: colors.background.secondary,
  },
  listNavigationBar: {
    backgroundColor: colors.background.primary,
  },
  contentArea: {
    flex: 1,
  },
  list: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  editorLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background.secondary,
  },
  listLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background.primary,
  },
  listLayerHidden: {
    opacity: 0,
  },
  content: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: 112,
  },
  emptyContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.md,
    paddingBottom: 112,
  },
  listHeader: {
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  searchInput: {
    minHeight: 44,
    color: colors.content.primary,
    backgroundColor: colors.background.secondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  fabWrap: {
    position: "absolute",
    right: spacing.xl,
  },
  fab: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: colors.accent,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.3)",
    borderRadius: radius.full,
    borderCurve: "continuous",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.28)",
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
    minHeight: 62,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.background.secondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderCurve: "continuous",
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
    paddingVertical: spacing.xxxl,
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
