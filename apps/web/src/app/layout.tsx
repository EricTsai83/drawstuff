import "@/styles/globals.css";
import { type Metadata } from "next";
import { Geist } from "next/font/google";
import { TRPCReactProvider } from "@/trpc/react";
import { NextSSRPlugin } from "@uploadthing/react/next-ssr-plugin";
import { extractRouterConfig } from "uploadthing/server";
import { uploadRouter } from "@/app/api/uploadthing/core";
import { ThemeProvider } from "next-themes";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { Toaster } from "@/components/ui/sonner";
import { TailwindIndicator } from "@/components/tailwind-indicator";
import { SceneSessionProvider } from "@/hooks/scene-session-context";
import { I18nProvider } from "@/hooks/i18n-context";
import { resolveRequestI18n } from "@/lib/i18n/server";

export const metadata: Metadata = {
  title: "drawstuff",
  description:
    "Drawstuff is a virtual collaborative whiteboard tool that lets you easily sketch diagrams that have a hand-drawn feel to them. It's powered by Excalidraw and built with Next.js and Tailwind CSS.",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

export default async function RootLayout({
  auth,
  overlay,
  children,
}: Readonly<{
  auth: React.ReactNode;
  overlay: React.ReactNode;
  children: React.ReactNode;
}>) {
  // 語言在 server 就解析完成，`<html lang>` 與 client 首次 render 用的字典一致
  const { language, dictionary } = await resolveRequestI18n();

  return (
    <html
      lang={language}
      className={`${geist.variable} antialiased`}
      suppressHydrationWarning
    >
      <body>
        <I18nProvider initialLanguage={language} initialDictionary={dictionary}>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            <TRPCReactProvider>
              <NextSSRPlugin
                /**
                 * The `extractRouterConfig` will extract **only** the route configs
                 * from the router to prevent additional information from being
                 * leaked to the client. The data passed to the client is the same
                 * as if you were to fetch `/api/uploadthing` directly.
                 */
                routerConfig={extractRouterConfig(uploadRouter)}
              />
              <NuqsAdapter>
                <SceneSessionProvider>
                  {children}
                  {overlay}
                  {auth}
                  <Toaster />
                  <TailwindIndicator />
                </SceneSessionProvider>
              </NuqsAdapter>
            </TRPCReactProvider>
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
