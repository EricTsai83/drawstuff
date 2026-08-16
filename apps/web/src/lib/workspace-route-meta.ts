import type { AppTranslationKey } from "@/lib/i18n";
import { routes, type WorkspaceRouteMatch } from "@/lib/routes";

/**
 * 一個 workspace 管理頁的標題／描述／返回目的地。
 *
 * 同一條路由有兩種外殼：`(workspace)` 下的整頁 `WorkspaceManagementShell`，
 * 以及 `@overlay/(modal)` 下的 `RouteOverlay`。兩邊都從這裡取值，避免兩份會漂移的定義。
 */
export type WorkspaceRouteMeta = {
  titleKey: AppTranslationKey;
  descriptionKey?: AppTranslationKey;
  backHref: string;
};

export function workspaceRouteMeta(
  match: WorkspaceRouteMatch,
): WorkspaceRouteMeta {
  switch (match.kind) {
    case "dashboard":
      return {
        titleKey: "dashboard.title",
        backHref: routes.canvas,
      };
    case "newWorkspace":
      return {
        titleKey: "dashboard.workspace.create",
        descriptionKey: "dashboard.workspace.createDialog.description",
        backHref: routes.dashboard(),
      };
    case "workspaceSettings":
      return {
        titleKey: "workspace.settings.title",
        descriptionKey: "workspace.settings.description",
        backHref: routes.dashboard(match.workspaceId),
      };
  }
}
