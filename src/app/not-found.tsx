import Link from "next/link";
import { Home, PanelsTopLeft } from "lucide-react";

import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="bg-background text-foreground flex min-h-screen items-center justify-center px-4 py-10">
      <section
        aria-labelledby="not-found-title"
        className="flex w-full max-w-xl flex-col items-center text-center"
      >
        <div className="text-primary mb-6 flex items-center gap-3">
          <DrawstuffLogo className="size-9" />
          <span className="text-lg font-semibold">drawstuff</span>
        </div>

        <h1
          id="not-found-title"
          className="max-w-lg text-3xl font-bold tracking-normal text-balance sm:text-4xl"
        >
          This drawing space does not exist.
        </h1>
        <p className="text-muted-foreground mt-4 max-w-md text-sm leading-6 text-balance">
          The page may have been moved, deleted, or shared with a broken link.
          Return to the canvas or open your dashboard to find another scene.
        </p>

        <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:justify-center">
          <Button asChild className="w-full sm:w-auto">
            <Link href="/">
              <Home className="size-4" aria-hidden="true" />
              Back to canvas
            </Link>
          </Button>
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/dashboard">
              <PanelsTopLeft className="size-4" aria-hidden="true" />
              Open dashboard
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
