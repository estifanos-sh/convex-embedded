import { api } from "$convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import * as Haptics from "expo-haptics";
import { Link, router } from "expo-router";
import { Stack } from "expo-router/stack";
import * as React from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { client } from "@/src/client";
import { useEmbeddedQuery } from "@/src/query";
import { colors, fontSize, radius, spacing } from "@/src/theme";

const summaryArgs = Object.freeze({ limit: 40 });

type DocumentSummary = FunctionReturnType<typeof api.documents.summaries>[number];

export default function DocumentsScreen() {
  const query = useEmbeddedQuery(api.documents.summaries, summaryArgs);
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  const createDocument = React.useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    if (process.env.EXPO_OS === "ios") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    try {
      const document = await client.mutation(api.documents.create, {});
      router.push({ pathname: "/document/[id]", params: { id: document._id } });
    } catch (error: unknown) {
      setCreateError(error instanceof Error ? error.message : "The document could not be created.");
    } finally {
      setCreating(false);
    }
  }, [creating]);

  const documents: DocumentSummary[] = query.status === "ready" ? query.value : [];

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              accessibilityLabel="Create document"
              accessibilityRole="button"
              disabled={creating}
              hitSlop={12}
              onPress={() => void createDocument()}
              style={({ pressed }) => [styles.headerButton, pressed && styles.buttonPressed]}
            >
              {creating ? (
                <ActivityIndicator color={colors.content.primary} size="small" />
              ) : (
                <Text style={styles.headerButtonLabel}>New</Text>
              )}
            </Pressable>
          ),
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
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
        renderItem={({ item }) => <DocumentRow document={item} />}
        style={styles.screen}
      />
    </>
  );
}

function DocumentRow({ document }: { document: DocumentSummary }) {
  return (
    <Link href={{ pathname: "/document/[id]", params: { id: document._id } }} asChild>
      <Pressable
        accessibilityHint="Opens this document"
        onPressIn={() => {
          if (process.env.EXPO_OS === "ios") void Haptics.selectionAsync();
        }}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={styles.documentMark} />
        <View style={styles.rowCopy}>
          <Text numberOfLines={1} selectable style={styles.rowTitle}>
            {document.title || "Untitled"}
          </Text>
          <Text selectable style={styles.rowMeta}>
            Created {formatDate(document.updatedAt)}
          </Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
    </Link>
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
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  emptyContent: {
    flexGrow: 1,
    padding: spacing.lg,
  },
  headerButton: {
    minWidth: 48,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.full,
  },
  headerButtonLabel: {
    color: colors.content.primary,
    fontSize: fontSize.body,
    fontWeight: "700",
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
    minHeight: 72,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.background.secondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
  },
  rowPressed: {
    backgroundColor: colors.background.tertiary,
    transform: [{ scale: 0.99 }],
  },
  documentMark: {
    width: 10,
    height: 36,
    backgroundColor: colors.accent,
    borderRadius: radius.full,
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
    fontSize: 28,
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
