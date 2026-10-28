import type { Metadata, Viewport } from "next";

import { APP_FONT_VARIABLE_CLASS_NAMES } from "./fonts";
import ConstellationBackgroundShell from "@/components/constellation/ConstellationBackgroundShell";
import PwaBootstrap from "@/components/layout/PwaBootstrap";
import { getLaunchScreenLinks } from "@/lib/app/launch-screens";
import { APP_THEME_BOOTSTRAP_SCRIPT } from "@/lib/app/theme-preference";
import OfflineBanner from "@/components/layout/OfflineBanner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jami Flashcards",
  description: "Practice real GCSE and A-level exam questions, keep what you learn as flashcards, and know what to revise next.",
  applicationName: "Jami Flashcards",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Jami",
    // What iOS shows while an installed Jami is opening. Without these it shows
    // nothing -- a bare dark rectangle that reads as the app hanging rather
    // than starting. Android builds its own from the manifest.
    startupImage: getLaunchScreenLinks(),
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  /*
   * The status bar while the app opens, so it matches the launch colour rather
   * than framing it in the purple theme's background. Once a page is up, the
   * notebook editor replaces this with the surface actually in use.
   */
  themeColor: "#040827",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${APP_FONT_VARIABLE_CLASS_NAMES} h-full antialiased`}
      // The theme class below is stamped on before React sees the document.
      suppressHydrationWarning
    >
      <head>
        {/* Blocking on purpose: the stored theme has to be on the document
            before the first paint, or the app opens on the default background
            and changes colour a frame later. */}
        <script
          dangerouslySetInnerHTML={{ __html: APP_THEME_BOOTSTRAP_SCRIPT }}
        />
      </head>
      <body className="min-h-full bg-surface-base text-text-primary">
        <PwaBootstrap />
        <OfflineBanner />
        <ConstellationBackgroundShell>{children}</ConstellationBackgroundShell>
      </body>
    </html>
  );
}

