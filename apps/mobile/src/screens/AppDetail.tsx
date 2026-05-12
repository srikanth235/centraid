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
import { colors, spacing, t } from '../theme';
import {
  appLiveUrl,
  getGatewayUrl,
  GatewayError,
  parseOrigin,
  resolveAppMeta,
  type AppRegistryRow,
} from '../lib/gateway';
import { fetchInlinedAppDocument, type InlinedDocument } from '../lib/asset-inliner';
import { dispatch } from '../lib/bridge/dispatch';
import { buildInjectedJs } from '../lib/bridge/injected';
import { CENTRAID_HANDSHAKE, type BridgeRequest } from '../lib/bridge/protocol';
import type { RootScreenProps } from '../navigation';

/**
 * Renders a Centraid app inside a WebView pointing at the user's gateway.
 * The native shell owns the titlebar + back button; the app's UI runs in
 * the WebView. See issue #14 (Phase B) for the architecture.
 */
export default function AppDetailScreen({
  navigation,
  route,
}: RootScreenProps<'AppDetail'>): React.JSX.Element {
  const { appId } = route.params;

  const liveUrlOrError = useMemo(() => {
    try {
      return { kind: 'ok' as const, url: appLiveUrl(appId) };
    } catch (err) {
      const message =
        err instanceof GatewayError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Gateway not configured.';
      return { kind: 'err' as const, message };
    }
  }, [appId]);

  // WKWebView's `source.headers` only attaches headers to the initial
  // document GET — sub-resource loads (<script src>, <link href>) don't
  // inherit them, so the gateway 401s those and the page's JS never runs.
  // Workaround: native fetches the HTML + every referenced asset with
  // the bearer attached and inlines them, then we hand the WebView a
  // self-contained document. The page's runtime fetch() calls (e.g.
  // `_data/list`, `_run`) are intercepted by the injected bridge shim
  // and proxied through native — see lib/bridge/injected.ts.
  const gatewayOrigin = useMemo(() => parseOrigin(getGatewayUrl()), []);
  const injectedJs = useMemo(() => buildInjectedJs(gatewayOrigin), [gatewayOrigin]);

  // Display metadata: a fabricated RegistryRow gives `resolveAppMeta` the
  // shape it wants — we only need the id at this layer; resolution falls
  // back to a derived tile for unknown ids.
  const meta = useMemo(() => {
    const row: AppRegistryRow = {
      id: appId,
      path: '',
      mode: 'uploaded',
      registeredAt: '',
      crons: [],
      cronStatus: {},
    };
    return resolveAppMeta(row);
  }, [appId]);

  const webViewRef = useRef<WebView | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  const [doc, setDoc] = useState<InlinedDocument | undefined>(undefined);

  // Fetch + inline the app's index.html each time we mount or retry.
  useEffect(() => {
    if (liveUrlOrError.kind !== 'ok') return;
    let cancelled = false;
    setDoc(undefined);
    setLoadError(undefined);
    setLoading(true);
    fetchInlinedAppDocument(appId)
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appId, reloadKey, liveUrlOrError.kind]);

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
      const response = await dispatch(appId, envelope);
      const js = `window.__centraidResolve && window.__centraidResolve(${JSON.stringify(
        response,
      )}); true;`;
      webViewRef.current?.injectJavaScript(js);
    },
    [appId],
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
      {liveUrlOrError.kind === 'err' ? (
        <ErrorState
          title="Gateway not set"
          message={liveUrlOrError.message}
          actionLabel="Open Settings"
          onAction={() => navigation.navigate('Settings')}
        />
      ) : loadError ? (
        <ErrorState
          title="Could not load app"
          message={loadError}
          actionLabel="Retry"
          onAction={reload}
        />
      ) : (
        <View style={styles.webWrap}>
          {doc ? (
            <WebView
              key={reloadKey}
              ref={webViewRef}
              source={{ html: doc.html, baseUrl: doc.baseUrl }}
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
              injectedJavaScriptBeforeContentLoaded={injectedJs}
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
}

function ErrorState({ title, message, actionLabel, onAction }: ErrorStateProps): React.JSX.Element {
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

const styles = StyleSheet.create({
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
