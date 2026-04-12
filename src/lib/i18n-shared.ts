export type PlaceholderValues = Record<string, string | number>;

export type AppTranslations = Record<string, Record<string, string>>;

export const appTranslations: AppTranslations = {
  en: {
    "app.export.cloud.title": "Cloud Upload",
    "app.export.cloud.subtitle": "Save the scene to cloud storage.",
    "app.export.cloud.loading": "Uploading...",
    "app.export.link.loading": "Exporting...",
    "app.overwriteConfirm.action.uploadToCloud.button": "Upload to Cloud",
    "app.overwriteConfirm.modal.shareableLink.description":
      "You can choose to export the scene to an image, save it to disk, or upload it to the cloud. You can also choose to overwrite the existing scene.",
    "app.cloudUpload.tooltip.idle": "Waiting to upload to cloud",
    "app.cloudUpload.tooltip.uploading": "Uploading to cloud",
    "app.cloudUpload.tooltip.success": "Synced to cloud",
    "app.cloudUpload.tooltip.error": "Upload failed, click to retry",
    "app.cloudUpload.tooltip.offline": "Currently offline",
    "app.cloudUpload.toast.success": "Scene successfully uploaded to cloud!",
    "app.cloudUpload.toast.error.sceneData":
      "Unable to get current scene data, please try again.",
    "app.cloudUpload.toast.error.saveScene":
      "Error occurred while saving scene, please try again.",
    "app.cloudUpload.toast.error.upload":
      "Error occurred while uploading scene to cloud, please try again.",
    "app.cloudUpload.toast.error.unknown":
      "Unknown error occurred while uploading scene to cloud, please try again.",

    // Missing keys used across the app that may not exist in Excalidraw
    // Overwrite confirm dialog
    "overwriteConfirm.modal.shareableLink.title": "Open shared scene?",
    "overwriteConfirm.modal.shareableLink.button": "Replace current scene",
    "overwriteConfirm.action.exportToImage.button": "Export to image",
    "overwriteConfirm.action.saveToDisk.button": "Save to disk",

    // Export dialog cards
    "exportDialog.disk_title": "Save to disk",
    "exportDialog.disk_details":
      "Save the current scene as an .excalidraw file.",
    "exportDialog.link_title": "Create shareable link",
    "exportDialog.link_details":
      "Upload encrypted scene and get a shareable link.",

    // Welcome screen additions
    "welcomeScreen.app.center_heading": "Draw, collaborate, and share",
    "welcomeScreen.app.menuHint": "Menu",

    // Common labels & buttons
    "buttons.selectLanguage": "Select language",
    "buttons.cancel": "Cancel",
    "buttons.create": "Create",
    "buttons.confirm": "Confirm",
    "labels.fileTitle": "File title",
    "labels.description": "Description",
    "labels.copy": "Copy",
    "labels.share": "Share",

    // Stats
    "stats.storage": "Storage",
    "stats.scene": "Scene",
    "stats.total": "Total",

    // Alerts
    "alerts.uploadedSecurly":
      "Uploaded securely. Only people with the link can access.",

    // Menu & Auth
    "menu.renameScene": "Rename scene",
    "menu.newScene": "New scene",
    "menu.settings": "Settings",
    "auth.signIn": "Sign in",
    "auth.signOut": "Sign out",
    "auth.loading": "Loading sign-in page...",
    "labels.openDashboard": "Open dashboard",

    // Toasts & Errors
    "toasts.newScene.localOnly":
      "New scene ready (local only). Sign in to save to cloud.",
    "toasts.newEmptyScene.localOnly":
      "New empty scene ready (local only). Sign in to save to cloud.",
    "toasts.newSceneCreated": "New scene created",
    "errors.failedToCreateScene": "Failed to create scene",
    "errors.failedToUpdateSceneName":
      "Failed to update scene name. Please try again.",

    // Dashboard & Search
    "dashboard.title": "Dashboard",
    "dashboard.recentlyModified": "Recently modified by you",
    "dashboard.yourScenes": "Your scenes",
    "dashboard.descriptionPlaceholder": "No description.",
    "dashboard.loading": "Loading...",
    "dashboard.noRecentlyModifiedScenes": "No recently modified scenes",
    "dashboard.loadingMore": "Loading more...",
    "dashboard.reachedEnd": "You have reached the end.",
    "dashboard.noScenesFound": "No scenes found",
    "dashboard.noScenesFound.hint":
      "Try adjusting your search terms or browse all scenes",
    "dashboard.sceneAlreadyOpen": "You're already editing this scene.",
    "dashboard.filter.all": "All",
    "dashboard.filter.public": "Public",
    "dashboard.filter.private": "Private",
    "dashboard.workspace.create": "Create workspace",
    "dashboard.workspace.rename": "Rename workspace",
    "dashboard.workspace.delete": "Delete workspace",
    "dashboard.workspace.manage": "Workspace settings",
    "dashboard.workspace.createDialog.description":
      "Create a new workspace directly from the dashboard.",
    "dashboard.workspace.namePlaceholder": "Enter a workspace name",
    "dashboard.workspace.creating": "Creating...",
    "dashboard.workspace.created": 'Workspace "{name}" created',
    "dashboard.workspace.createFailed": "Failed to create workspace",
    "dashboard.workspace.nameInvalid": "Please enter a valid workspace name",
    "workspace.settings.title": "Settings",
    "workspace.settings.title.rename": "Rename Workspace",
    "workspace.settings.title.delete": "Delete Workspace",
    "workspace.settings.description":
      "Edit workspace information and manage dangerous actions.",
    "workspace.settings.description.rename":
      "Change the name of the current workspace.",
    "workspace.settings.description.delete":
      "This action is permanent and cannot be undone.",
    "workspace.settings.defaultCannotDelete":
      "The default workspace cannot be deleted. Please select a different workspace.",
    "workspace.settings.deleteWarningTitle":
      'You are about to delete "{name}" and all of its scenes.',
    "workspace.settings.deleteWarningBody":
      "This action is permanent. All scenes in this workspace will be lost.",
    "workspace.settings.typeToConfirm":
      'Type "{name}" to confirm deletion:',
    "workspace.settings.cancel": "Cancel",
    "workspace.settings.close": "Close",
    "workspace.settings.confirmDelete": "Delete workspace",
    "workspace.settings.deleting": "Deleting...",
    "search.placeholder":
      "Search scenes by name, description, category, or project...",
    "search.resultsCount": 'Found {count} results for "{query}"',
    "search.showingCount": "Showing {total} scenes",
    "menu.importScene": "Import scene",
    "menu.sceneSettings": "Scene settings",
    "publish.badge.public": "Public",
    "publish.badge.private": "Private",
    "publish.menu.publish": "Set to public",
    "publish.menu.unpublish": "Set to private",
    "publish.menu.copyLink": "Copy public link",
    "publish.menu.openLink": "Open public link",
    "publish.toast.published": "Public link is ready.",
    "publish.toast.unpublished": "This scene is now private.",
    "publish.toast.copied": "Public link copied.",
    "publish.toast.failed": "Unable to update publish status. Please try again.",
    "public.theme.system": "Use system theme",
    "public.theme.light": "Use light theme",
    "public.theme.dark": "Use dark theme",
    "public.viewer.loading": "Loading scene...",
    "public.viewer.rendering": "Updating preview...",
    "public.viewer.loadError": "Failed to load this published scene.",
    "public.viewer.zoomIn": "Zoom in",
    "public.viewer.zoomOut": "Zoom out",
    "public.viewer.fit": "Fit",
    "public.viewer.reset": "Reset",
    "public.viewer.info": "Scene info",
    "public.viewer.alt": "Published scene preview",
    "public.viewer.backToWorkspace": "Back to workspace",
    "public.viewer.hideUI": "Hide controls",
    "public.viewer.showUI": "Show controls",

    // Labels
    "labels.updatedTimeAgo": "Updated {time}",

    // Storage / Stats
    "stats.usedStorage": "Used Storage: {percent}% ({capacity})",

    // Images alt
    "images.bun.crying": "Crying bun",
    "images.bun.worried": "Worried bun",
    "images.bun.happy": "Happy bun",

    // Dialogs
    "dialog.delete.title": "Confirm delete",
    "dialog.delete.description":
      'Are you sure you want to delete the scene "{name}"? This action cannot be undone.',
    "buttons.delete": "Delete",
    "buttons.deleting": "Deleting...",
    // Workspace
    "workspace.placeholder.searchOrCreate": "Find/create workspace",
  },
  "zh-TW": {
    "app.export.cloud.title": "上傳雲端",
    "app.export.cloud.subtitle": "將場景上傳至雲端儲存。",
    "app.export.cloud.loading": "上傳中...",
    "app.export.link.loading": "匯出中...",
    "app.overwriteConfirm.action.uploadToCloud.button": "上傳雲端",
    "app.overwriteConfirm.modal.shareableLink.description":
      "您可以選擇將場景匯出為圖片、儲存到磁碟或上傳到雲端。您也可以選擇覆寫現有的場景。",
    "app.cloudUpload.tooltip.idle": "等待上傳到雲端",
    "app.cloudUpload.tooltip.uploading": "正在上傳到雲端",
    "app.cloudUpload.tooltip.success": "已同步到雲端",
    "app.cloudUpload.tooltip.error": "上傳失敗，點擊重試",
    "app.cloudUpload.tooltip.offline": "目前離線",
    "app.cloudUpload.toast.success": "場景已成功上傳至雲端！",
    "app.cloudUpload.toast.error.sceneData": "無法取得當前場景資料，請重試。",
    "app.cloudUpload.toast.error.saveScene": "儲存場景時發生錯誤，請重試。",
    "app.cloudUpload.toast.error.upload": "上傳場景至雲端時發生錯誤，請重試。",
    "app.cloudUpload.toast.error.unknown":
      "上傳場景至雲端時發生未知錯誤，請重試。",

    // 覆寫/補齊：覆寫確認對話框
    "overwriteConfirm.modal.shareableLink.title": "開啟分享的場景？",
    "overwriteConfirm.modal.shareableLink.button": "取代目前場景",
    "overwriteConfirm.action.exportToImage.button": "匯出為圖片",
    "overwriteConfirm.action.saveToDisk.button": "儲存到磁碟",

    // 匯出對話卡片
    "exportDialog.disk_title": "儲存到磁碟",
    "exportDialog.disk_details": "將目前場景儲存為 .excalidraw 檔。",
    "exportDialog.link_title": "建立可分享連結",
    "exportDialog.link_details": "上傳加密後的場景並取得可分享連結。",

    // 歡迎畫面補充
    "welcomeScreen.app.center_heading": "繪製、協作、分享",
    "welcomeScreen.app.menuHint": "選單",

    // 常用標籤與按鈕
    "buttons.selectLanguage": "選擇語言",
    "buttons.cancel": "取消",
    "buttons.create": "建立",
    "buttons.confirm": "確認",
    "labels.fileTitle": "檔案名稱",
    "labels.description": "描述",
    "labels.copy": "複製",
    "labels.share": "分享",

    // 統計
    "stats.storage": "儲存用量",
    "stats.scene": "場景",
    "stats.total": "總計",

    // 警示
    "alerts.uploadedSecurly": "已安全地上傳，只有持有連結的人可存取。",

    // 選單與登入
    "menu.renameScene": "重新命名場景",
    "menu.newScene": "新增場景",
    "menu.settings": "設定",
    "auth.signIn": "登入",
    "auth.signOut": "登出",
    "auth.loading": "正在載入登入頁面…",
    "labels.openDashboard": "開啟場景列表",

    // 提示與錯誤
    "toasts.newScene.localOnly": "已建立新場景（僅本機）。登入即可同步到雲端。",
    "toasts.newEmptyScene.localOnly":
      "已建立空白新場景（僅本機）。登入即可同步到雲端。",
    "toasts.newSceneCreated": "已建立新場景",
    "errors.failedToCreateScene": "建立場景失敗",
    "errors.failedToUpdateSceneName": "更新場景名稱失敗，請再試一次。",

    // 儀表板與搜尋
    "dashboard.title": "場景列表",
    "dashboard.recentlyModified": "您最近修改的項目",
    "dashboard.yourScenes": "您的場景",
    "dashboard.descriptionPlaceholder": "沒有專案描述",
    "dashboard.loading": "載入中...",
    "dashboard.noRecentlyModifiedScenes": "沒有最近修改的場景",
    "dashboard.loadingMore": "載入更多...",
    "dashboard.reachedEnd": "已到清單底部。",
    "dashboard.noScenesFound": "找不到場景",
    "dashboard.noScenesFound.hint": "嘗試調整搜尋關鍵字，或瀏覽全部場景",
    "dashboard.sceneAlreadyOpen": "您已正在編輯此場景。",
    "dashboard.filter.all": "全部",
    "dashboard.filter.public": "公開",
    "dashboard.filter.private": "私人",
    "dashboard.workspace.create": "建立工作空間",
    "dashboard.workspace.rename": "重新命名工作空間",
    "dashboard.workspace.delete": "刪除工作空間",
    "dashboard.workspace.manage": "工作空間設定",
    "dashboard.workspace.createDialog.description":
      "直接從場景列表建立新的工作空間。",
    "dashboard.workspace.namePlaceholder": "輸入工作空間名稱",
    "dashboard.workspace.creating": "建立中...",
    "dashboard.workspace.created": '已建立工作空間「{name}」',
    "dashboard.workspace.createFailed": "建立工作空間失敗",
    "dashboard.workspace.nameInvalid": "請輸入有效的工作空間名稱",
    "workspace.settings.title": "設定",
    "workspace.settings.title.rename": "重新命名工作空間",
    "workspace.settings.title.delete": "刪除工作空間",
    "workspace.settings.description": "編輯工作空間資訊並管理高風險操作。",
    "workspace.settings.description.rename": "變更目前工作空間的名稱。",
    "workspace.settings.description.delete":
      "此操作不可復原，請謹慎操作。",
    "workspace.settings.defaultCannotDelete":
      "預設工作空間無法刪除，請選擇其他工作空間。",
    "workspace.settings.deleteWarningTitle":
      '即將刪除「{name}」及其所有場景。',
    "workspace.settings.deleteWarningBody":
      "此操作不可復原，該工作空間中的所有場景都將永久消失。",
    "workspace.settings.typeToConfirm":
      '請輸入「{name}」以確認刪除：',
    "workspace.settings.cancel": "取消",
    "workspace.settings.close": "關閉",
    "workspace.settings.confirmDelete": "刪除工作空間",
    "workspace.settings.deleting": "刪除中...",
    "search.placeholder": "以名稱、描述、分類或專案名稱搜尋場景...",
    "search.resultsCount": '找到 {count} 筆結果，關鍵字："{query}"',
    "search.showingCount": "共顯示 {total} 個場景",
    "menu.importScene": "匯入場景",
    "menu.sceneSettings": "場景設定",
    "publish.badge.public": "公開",
    "publish.badge.private": "私人",
    "publish.menu.publish": "設為公開",
    "publish.menu.unpublish": "設為私人",
    "publish.menu.copyLink": "複製公開連結",
    "publish.menu.openLink": "開啟公開連結",
    "publish.toast.published": "公開連結已建立。",
    "publish.toast.unpublished": "此場景已設為私人。",
    "publish.toast.copied": "已複製公開連結。",
    "publish.toast.failed": "更新發布狀態失敗，請再試一次。",
    "public.theme.system": "跟隨系統",
    "public.theme.light": "淺色",
    "public.theme.dark": "深色",
    "public.viewer.loading": "載入場景中...",
    "public.viewer.rendering": "正在更新預覽...",
    "public.viewer.loadError": "載入公開場景失敗。",
    "public.viewer.zoomIn": "放大",
    "public.viewer.zoomOut": "縮小",
    "public.viewer.fit": "符合視窗",
    "public.viewer.reset": "重設",
    "public.viewer.info": "場景資訊",
    "public.viewer.alt": "公開場景預覽",
    "public.viewer.backToWorkspace": "返回工作區",
    "public.viewer.hideUI": "隱藏控制列",
    "public.viewer.showUI": "顯示控制列",

    // 標籤
    "labels.updatedTimeAgo": "更新於 {time}",

    // 儲存用量/統計
    "stats.usedStorage": "已用儲存空間：{percent}%（{capacity}）",

    // 圖片替代文字
    "images.bun.crying": "哭泣小包子",
    "images.bun.worried": "擔心小包子",
    "images.bun.happy": "開心小包子",

    // 對話框
    "dialog.delete.title": "確認刪除",
    "dialog.delete.description": "確定要刪除場景「{name}」嗎？此操作無法復原。",
    "buttons.delete": "刪除",
    "buttons.deleting": "刪除中...",
    // Workspace
    "workspace.placeholder.searchOrCreate": "搜尋或建立工作空間",
  },
};

export function formatPlaceholders(
  template: string,
  values?: PlaceholderValues,
): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}
