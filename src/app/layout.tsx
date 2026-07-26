import "@/styles/globals.css";
import { type Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TRPCReactProvider } from "@/trpc/react";
import { NextSSRPlugin } from "@uploadthing/react/next-ssr-plugin";
import { extractRouterConfig } from "uploadthing/server";
import { uploadRouter } from "@/app/api/uploadthing/core";
import { ThemeProvider } from "@/components/theme-provider";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { Toaster } from "@/components/ui/sonner";
import { TailwindIndicator } from "@/components/tailwind-indicator";
import { SceneSessionProvider } from "@/hooks/scene-session-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "drawstuff",
  description:
    "Drawstuff is a collaborative whiteboard for sketching, organizing, and sharing visual ideas.",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
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
      className={cn(
        "font-sans antialiased",
        geist.variable,
        geistMono.variable,
      )}
      suppressHydrationWarning
    >
      <body>
        <ThemeProvider>
          <TooltipProvider>
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
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
