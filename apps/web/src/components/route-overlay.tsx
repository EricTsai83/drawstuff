"use client";

import { useCallback, useRef } from "react";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { RouteOverlayProvider } from "@/components/route-overlay-context";
import { buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type { AppTranslationKey } from "@/lib/i18n";
import {
  matchWorkspaceRoute,
  routes,
  type WorkspaceRouteMatch,
} from "@/lib/routes";
import { workspaceRouteMeta } from "@/lib/workspace-route-meta";
import { cn } from "@/lib/utils";

/** 置中大標題 + 選用返回鍵（dashboard / settings）。 */
const TITLE_ROW_HEADER_CLASSNAME =
  "static grid min-h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-0 px-[var(--app-surface-gutter)] pt-6 pb-6 text-center sm:pt-10 sm:pb-8";
/** 靠左小標題 + 分隔線（新增 workspace）。 */
const BANNER_HEADER_CLASSNAME =
  "app-safe-header bg-popover static border-b py-4 pr-14 text-left";

const BODY_CLASSNAME = {
  /** dashboard 內容自帶 padding。 */
  dashboard: "min-w-0 flex-1",
  centered:
    "flex min-w-0 flex-1 flex-col gap-5 px-[var(--app-surface-gutter)] pt-3 pb-[max(var(--app-safe-area-bottom),1.5rem)] sm:pt-4",
  banner:
    "min-w-0 flex-1 px-[var(--app-surface-gutter)] pt-6 pb-[max(var(--app-safe-area-bottom),1.5rem)]",
} as const;

type OverlayChrome = {
  titleKey: AppTranslationKey;
  descriptionKey?: AppTranslationKey;
  headerClassName: string;
  bodyClassName: string;
  /** title row 的標題置中放大；banner 的標題靠左縮小。 */
  isTitleRow: boolean;
  backHref?: string;
  /** 無法辨識的路由：仍要給 dialog 一個 accessible name，但不顯示佔位標題。 */
  headerHidden?: boolean;
};

function getOverlayChrome(match: WorkspaceRouteMatch | null): OverlayChrome {
  if (!match) {
    // `@overlay/(modal)` 只放 match 得到的路由，正常不會走到這裡；
    // tests/workspace-routes.test.ts 會擋住新增卻沒登記的 modal 路由。
    return {
      titleKey: "workspace.route.description",
      headerClassName: BANNER_HEADER_CLASSNAME,
      bodyClassName: BODY_CLASSNAME.banner,
      isTitleRow: false,
      headerHidden: true,
    };
  }

  const { titleKey, descriptionKey, backHref } = workspaceRouteMeta(match);

  switch (match.kind) {
    case "dashboard":
      return {
        titleKey,
        descriptionKey,
        headerClassName: TITLE_ROW_HEADER_CLASSNAME,
        bodyClassName: BODY_CLASSNAME.dashboard,
        isTitleRow: true,
      };
    case "newWorkspace":
      return {
        titleKey,
        descriptionKey,
        headerClassName: BANNER_HEADER_CLASSNAME,
        bodyClassName: BODY_CLASSNAME.banner,
        isTitleRow: false,
      };
    case "workspaceSettings":
      return {
        titleKey,
        descriptionKey,
        headerClassName: TITLE_ROW_HEADER_CLASSNAME,
        bodyClassName: BODY_CLASSNAME.centered,
        isTitleRow: true,
        backHref,
      };
  }
}

export function RouteOverlay({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useAppI18n();
  const closingRef = useRef(false);
  const {
    titleKey,
    descriptionKey,
    headerClassName,
    bodyClassName,
    isTitleRow,
    backHref,
    headerHidden,
  } = getOverlayChrome(matchWorkspaceRoute(pathname));

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    // 刻意不走瀏覽器上一頁：整個 modal（含 dashboard → settings 的 replace 導航）
    // 只佔一個 history entry，關閉就是回到底下常駐的 canvas，深連結進來也不會退出站外。
    router.replace(routes.canvas);
  }, [router]);

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        aria-label={t(titleKey)}
        viewportClassName="fixed inset-0 z-50 overflow-x-hidden overflow-y-auto overscroll-contain"
        className="relative top-auto left-auto mx-auto my-8 flex max-h-none min-h-[calc(100dvh-4rem)] w-4/5 max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-visible rounded-none p-0 sm:max-w-none"
      >
        <DialogHeader
          className={cn(headerHidden ? "sr-only" : headerClassName)}
        >
          {backHref && (
            <Link
              href={backHref}
              replace
              aria-label={t("workspace.backToDashboard")}
              className={buttonVariants({
                variant: "ghost",
                size: "lg",
                className: "col-start-1 row-start-1 justify-self-start",
              })}
            >
              <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
              <span className="hidden md:inline">{t("dashboard.title")}</span>
            </Link>
          )}
          <DialogTitle
            className={cn(
              isTitleRow
                ? "col-start-2 row-start-1 text-2xl leading-tight font-semibold lg:text-3xl"
                : "text-lg leading-tight font-semibold sm:text-xl",
            )}
          >
            {t(titleKey)}
          </DialogTitle>
          <DialogDescription
            className={cn((!descriptionKey || isTitleRow) && "sr-only")}
          >
            {descriptionKey
              ? t(descriptionKey)
              : t("workspace.route.description")}
          </DialogDescription>
        </DialogHeader>
        <div data-route-overlay-body className={bodyClassName}>
          <RouteOverlayProvider>{children}</RouteOverlayProvider>
        </div>
      </DialogContent>
    </Dialog>
  );
}
