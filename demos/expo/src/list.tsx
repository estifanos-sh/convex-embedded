import * as Haptics from "expo-haptics";
import * as React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { documentRowIsEqual, type DocumentRowProps } from "./row";
import { colors, fontSize, radius, spacing } from "./theme";

export type { DocumentRowProps } from "./row";

// ICU formatter construction is expensive on device. The app locale is fixed for this process, so
// one formatter can serve every virtualized row without changing its visible output.
const documentDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

/** A memoized document row whose props are limited to its visible state. */
export const DocumentRow = React.memo(function DocumentRow({
  document,
  expanded,
  opening,
  pinned,
  onOpen,
  onToggleExpanded,
  onTogglePin,
}: DocumentRowProps) {
  const open = React.useCallback(() => {
    onOpen(document._id);
  }, [document._id, onOpen]);
  const toggleExpanded = React.useCallback(() => {
    void onToggleExpanded(document._id);
  }, [document._id, onToggleExpanded]);
  const togglePin = React.useCallback(() => {
    void onTogglePin(document._id);
  }, [document._id, onTogglePin]);
  const select = React.useCallback(() => {
    if (process.env.EXPO_OS === "ios") void Haptics.selectionAsync();
  }, []);

  return (
    <Pressable
      accessibilityHint="Opens this document"
      accessibilityRole="button"
      onPress={open}
      onPressIn={select}
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
        <Text style={styles.rowMeta}>{documentDateFormatter.format(document.updatedAt)}</Text>
        {expanded ? (
          <Text numberOfLines={1} style={styles.rowMeta}>
            /{document.slug}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityHint="Shows more about this document on this device only"
        accessibilityLabel={expanded ? "Collapse document details" : "Expand document details"}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        hitSlop={8}
        onPress={toggleExpanded}
        style={({ pressed }) => [styles.pinButton, pressed && styles.rowPressed]}
      >
        <Text style={[styles.pinGlyph, expanded && styles.pinGlyphActive]}>
          {expanded ? "▾" : "▸"}
        </Text>
      </Pressable>
      <Pressable
        accessibilityHint="Keeps this document listed on this device only"
        accessibilityLabel={pinned ? "Unpin document" : "Pin document"}
        accessibilityRole="button"
        hitSlop={8}
        onPress={togglePin}
        style={({ pressed }) => [styles.pinButton, pressed && styles.rowPressed]}
      >
        <Text style={[styles.pinGlyph, pinned && styles.pinGlyphActive]}>{pinned ? "★" : "☆"}</Text>
      </Pressable>
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
}, documentRowIsEqual);

const styles = StyleSheet.create({
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
  pinButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  pinGlyph: {
    color: colors.content.tertiary,
    fontSize: 18,
    lineHeight: 22,
  },
  pinGlyphActive: {
    color: colors.content.primary,
  },
});
