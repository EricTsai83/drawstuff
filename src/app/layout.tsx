import "@/styles/globals.css";
import { type Metadata } from "next";
import { Geist } from "next/font/google";
import { TRPCReactProvider } from "@/trpc/react";
import { NextSSRPlugin } from "@uploadthing/react/next-ssr-plugin";
import { extractRouterConfig } from "uploadthing/server";
import { uploadRouter } from "@/app/api/uploadthing/core";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { ThemeProvider } from "next-themes";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { Toaster } from "@/components/ui/sonner";
import { TailwindIndicator } from "@/components/tailwind-indicator";
import { SceneSessionProvider } from "@/hooks/scene-session-context";

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

export default function RootLayout({
  auth,
  dashboard,
  children,
}: Readonly<{
  auth: React.ReactNode;
  dashboard: React.ReactNode;
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geist.variable} antialiased`}
      suppressHydrationWarning
    >
      <body>
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
                <div>{auth}</div>
                <div>{dashboard}</div>
                {children}
                <Toaster />
                <TailwindIndicator />
              </SceneSessionProvider>
            </NuqsAdapter>
          </TRPCReactProvider>
          <SpeedInsights />
        </ThemeProvider>
      </body>
    </html>
  );
}
