import React from "react";
import { FlatList, Modal, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Text, TextInput } from "../../kit/components/NativeText";
import type { LockerStyles } from "./LockerHome.styles";
import type { LockerItem, LockerRow } from "./LockerHome.types";
import { visibleFields } from "./LockerHome.types";

export function StateCard({
  title,
  message,
  action,
  onAction,
  styles,
}: {
  title: string;
  message: string;
  action?: string;
  onAction?: () => void;
  styles: LockerStyles;
}): React.JSX.Element {
  return (
    <View style={styles.locked}>
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateCopy}>{message}</Text>
      {action && onAction ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          style={styles.primary}
        >
          <Text style={styles.primaryText}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ItemAuthModal({
  error,
  item,
  passphrase,
  working,
  styles,
  placeholderColor,
  onChangePassphrase,
  onClose,
  onReveal,
}: {
  error?: string;
  item: LockerRow | null;
  passphrase: string;
  working: boolean;
  styles: LockerStyles;
  placeholderColor: string;
  onChangePassphrase: (value: string) => void;
  onClose: () => void;
  onReveal: () => void;
}): React.JSX.Element {
  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      transparent
      visible={item !== null}
    >
      <View style={styles.modalBack}>
        <View accessibilityViewIsModal style={styles.modalCard}>
          <Text style={styles.modalTitle}>Authenticate for this item</Text>
          <Text style={styles.stateCopy}>
            Re-enter your primary passphrase to reveal{" "}
            {item?.title ?? "this secret"} once.
          </Text>
          <TextInput
            accessibilityLabel="Passphrase for this Locker item"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={onChangePassphrase}
            placeholder="Primary passphrase"
            placeholderTextColor={placeholderColor}
            secureTextEntry
            style={styles.input}
            value={passphrase}
          />
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          <View style={styles.modalActions}>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={!item || passphrase.length < 12 || working}
              onPress={onReveal}
              style={styles.primary}
            >
              <Text style={styles.primaryText}>Reveal</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function ItemDetailModal({
  item,
  styles,
  onClose,
  onCopy,
  onShare,
}: {
  item: LockerItem | null;
  styles: LockerStyles;
  onClose: () => void;
  onCopy: (value: string) => void;
  onShare: (itemId: string) => void;
}): React.JSX.Element {
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={item !== null}
    >
      <SafeAreaView style={styles.detailSafe}>
        <View style={styles.detailHeader}>
          <View>
            <Text style={styles.detailTitle}>{item?.title}</Text>
            <Text style={styles.rowSubtitle}>{item?.type}</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={onClose}>
            <Text style={styles.lockNow}>Done</Text>
          </Pressable>
        </View>
        {item ? (
          <Pressable
            accessibilityLabel={`Share ${item.title} with household`}
            accessibilityRole="button"
            onPress={() => onShare(item.item_id)}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>Share family item</Text>
          </Pressable>
        ) : null}
        <FlatList
          contentContainerStyle={styles.detailList}
          data={item ? visibleFields(item) : []}
          keyExtractor={({ label }) => label}
          renderItem={({ item: field }) => (
            <View style={styles.field}>
              <View style={styles.fieldCopy}>
                <Text style={styles.fieldLabel}>{field.label}</Text>
                <Text selectable={!field.secret} style={styles.fieldValue}>
                  {field.value}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={`Copy ${field.label}`}
                accessibilityRole="button"
                onPress={() => onCopy(field.value)}
                style={styles.copyButton}
              >
                <Text style={styles.copyText}>Copy · clears in 30s</Text>
              </Pressable>
            </View>
          )}
        />
      </SafeAreaView>
    </Modal>
  );
}
