import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { onInstallAvailability, promptInstall, isStandalone } from '../lib/pwa';

/**
 * "Install app" — shown only while the browser actually has an install prompt to give.
 *
 * It renders nothing when the app is already an installed window, when the browser never
 * fired `beforeinstallprompt` (Safari, or requirements not met), and after the prompt has
 * been used. That is deliberate: a button that cannot do anything is worse than no button,
 * and the requirements it depends on — manifest, secure origin, service worker — are things
 * the reader cannot fix from here.
 */
export function InstallAppButton() {
  const [available, setAvailable] = useState(false);
  const [standalone] = useState(isStandalone);

  useEffect(() => onInstallAvailability(setAvailable), []);

  if (standalone || !available) return null;

  return (
    <button
      className="btn-ghost w-full justify-start lg:h-8"
      onClick={() => { void promptInstall(); }}
      title="Install DecisionGuru as a desktop app"
    >
      <Download size={15} /> Install app
    </button>
  );
}
