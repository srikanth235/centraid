import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, BackHandler, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type {
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewMessageEvent,
  WebViewNavigation,
} from 'react-native-webview/lib/WebViewTypes';
import AppHeader from '../components/AppHeader';
import Button from '../components/Button';
import { spacing, t, useTheme, type ThemeColors } from '../theme';
import { appLiveUrl, resolveGatewayBase, resolveAppMeta } from '../lib/gateway';
import { dispatch } from '../lib/bridge/dispatch';
import { INJECTED_JS } from '../lib/bridge/injected';
import { CENTRAID_HANDSHAKE, type BridgeRequest } from '../lib/bridge/protocol';
import type { AppsScreenProps } from '../navigation';

/**
 * Renders a Centraid app inside a WebView. The native shell owns the
 * titlebar + back button; the app's UI runs in the WebView, loaded
 * straight from `<base>/centraid/<id>/`.
 *
 * The base URL comes from the paired tunnel when available — a localhost
 * proxy that forwards everything (documents, ES-module imports, EventSource)
 * to the desktop over iroh, so no inlining or header tricks are needed. The
 * manual-URL dev fallback loads the same URL directly; that only works
 * against a token-less dev gateway, since the WebView attaches no bearer —
 * an authed gateway needs the tunnel.
 */
export default function AppDetailScreen({
  navigation,
  route,
}: AppsScreenProps<'AppDetail'>): React.JSX.Element {
  const { appId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // Display metadata: resolution falls back to a derived tile for ids the
  // built-in catalog doesn't know — we only have the id at this layer.
  const meta = useMemo(() => resolveAppMeta({ id: appId }), [appId]);

  const webViewRef = useRef<WebView | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  const [baseUrl, setBaseUrl] = useState<string | undefined>(undefined);
  const [noGateway, setNoGateway] = useState(false);

  // Resolve the gateway base (tunnel first) each time we mount or retry.
  useEffect(() => {
    let cancelled = false;
    setBaseUrl(undefined);
    setNoGateway(false);
    setLoadError(undefined);
    setLoading(true);
    resolveGatewayBase()
      .then((base) => {
        if (cancelled) return;
        if (base) setBaseUrl(base);
        else {
          setNoGateway(true);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appId, reloadKey]);

  const handleNavStateChange = useCallback((event: WebViewNavigation): void => {
    setCanGoBack(event.canGoBack);
  }, []);

  const handleError = useCallback((event: WebViewErrorEvent): void => {
    const ne = event.nativeEvent;
    setLoadError(ne.description || `Error ${ne.code}`);
    setLoading(false);
  }, []);

  const handleHttpError = useCallback((event: WebViewHttpErrorEvent): void => {
    const ne = event.nativeEvent;
    setLoadError(ne.description || `HTTP ${ne.statusCode}`);
    setLoading(false);
  }, []);

  // postMessage envelope from the injected bridge. We narrow on the
  // handshake string so other window.postMessage senders (3rd-party
  // libs inside the WebView) can't impersonate the bridge.
  const handleMessage = useCallback(
    async (event: WebViewMessageEvent): Promise<void> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const envelope = parsed as { __centraid?: string } & BridgeRequest;
      if (envelope.__centraid !== CENTRAID_HANDSHAKE) return;
      const response = await dispatch(
        appId,
        envelope,
        baseUrl ? { gatewayBaseUrl: baseUrl } : undefined,
      );
      const js = `window.__centraidResolve && window.__centraidResolve(${JSON.stringify(
        response,
      )}); true;`;
      webViewRef.current?.injectJavaScript(js);
    },
    [appId, baseUrl],
  );

  const reload = useCallback((): void => {
    setLoadError(undefined);
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  // Android hardware back: step inside the WebView's history first; if
  // we're at the entry page, fall through to React Navigation's default
  // (pop the screen). iOS edge-swipe always pops the screen — fine.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [canGoBack]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader
        title={meta.name}
        subtitle={meta.desc || undefined}
        color={meta.color}
        iconKey={meta.iconKey}
        onBack={() => navigation.goBack()}
      />
      {noGateway ? (
        <ErrorState
          title="Not connected"
          message="Pair with your desktop (or set a gateway URL under Advanced) to open apps."
          actionLabel="Open Settings"
          onAction={() => navigation.navigate('SettingsTab', { screen: 'Settings' })}
          styles={styles}
        />
      ) : loadError ? (
        <ErrorState
          title="Could not load app"
          message={loadError}
          actionLabel="Retry"
          onAction={reload}
          styles={styles}
        />
      ) : (
        <View style={styles.webWrap}>
          {baseUrl ? (
            <WebView
              key={reloadKey}
              ref={webViewRef}
              source={{ uri: appLiveUrl(baseUrl, appId) }}
              onNavigationStateChange={handleNavStateChange}
              onLoadStart={() => {
                setLoading(true);
              }}
              onLoadEnd={() => setLoading(false)}
              onError={handleError}
              onHttpError={handleHttpError}
              onMessage={(event) => {
                void handleMessage(event);
              }}
              injectedJavaScriptBeforeContentLoaded={INJECTED_JS}
              style={styles.web}
              allowsBackForwardNavigationGestures={false}
              originWhitelist={['*']}
            />
          ) : null}
          {loading ? (
            <View style={styles.loadingOverlay} pointerEvents="none">
              <ActivityIndicator color={colors.ink3} />
            </View>
          ) : null}
        </View>
      )}
    </SafeAreaView>
  );
}

interface ErrorStateProps {
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
  styles: ReturnType<typeof makeStyles>;
}

function ErrorState({
  title,
  message,
  actionLabel,
  onAction,
  styles,
}: ErrorStateProps): React.JSX.Element {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyMsg}>{message}</Text>
      <View style={styles.emptyAction}>
        <Button label={actionLabel} onPress={onAction} variant="soft" />
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    empty: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing[5],
    },
    emptyAction: { alignSelf: 'stretch', marginTop: spacing[4] },
    emptyMsg: { ...t('body'), color: colors.ink2 },
    emptyTitle: { ...t('title'), color: colors.ink, marginBottom: spacing[2] },
    loadingOverlay: {
      alignItems: 'center',
      backgroundColor: 'transparent',
      bottom: 0,
      justifyContent: 'center',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    safe: { backgroundColor: colors.bg, flex: 1 },
    web: { backgroundColor: colors.bg, flex: 1 },
    webWrap: { flex: 1 },
  });
