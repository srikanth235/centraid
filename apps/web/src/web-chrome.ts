interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function notice(kind: 'install' | 'offline', text: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = `web-notice web-notice-${kind}`;
  element.setAttribute('role', kind === 'offline' ? 'status' : 'region');
  const label = document.createElement('span');
  label.textContent = text;
  element.append(label);
  document.body.append(element);
  return element;
}

export function installWebChrome(): void {
  const offline = notice(
    'offline',
    'You’re offline. Centraid will reconnect to your gateway when the network returns.',
  );
  const syncOnline = (): void => {
    offline.toggleAttribute('data-visible', !navigator.onLine);
  };
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  syncOnline();

  window.addEventListener(
    'beforeinstallprompt',
    (raw) => {
      raw.preventDefault();
      const event = raw as InstallPromptEvent;
      const banner = notice('install', 'Install Centraid for a focused, app-like workspace.');
      const install = document.createElement('button');
      install.type = 'button';
      install.textContent = 'Install';
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = 'Not now';
      dismiss.className = 'web-notice-quiet';
      install.addEventListener('click', () => {
        void event
          .prompt()
          .then(() => event.userChoice)
          .finally(() => banner.remove());
      });
      dismiss.addEventListener('click', () => banner.remove());
      banner.append(install, dismiss);
    },
    { once: true },
  );
}
