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
    "app.cloudUpload.toast.error.noSceneToUpdate":
      "This scene has not been saved yet.",
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
    "buttons.close": "Close",
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
    "auth.signOutConfirm.title": "Save before signing out?",
    "auth.signOutConfirm.description":
      "Signing out clears the current canvas and its images from this browser. Save your latest changes first if you want to keep them.",
    "auth.signOutConfirm.save": "Save, then sign out",
    "auth.signOutConfirm.discard": "Discard and sign out",
    "auth.loading": "Loading sign-in page...",
    "auth.continueWithGoogle": "Continue with Google",
    "auth.connecting": "Connecting...",
    "auth.welcome": "Welcome to Excalidraw X Ericts",
    "auth.required.title": "Sign in required",
    "auth.required.description": "Sign in to access this feature.",
    "auth.agreement.click": "By continuing, you agree to our",
    "auth.agreement.signIn": "By signing in, you agree to our",
    "auth.terms": "Terms of Service",
    "auth.and": "and",
    "auth.privacy": "Privacy Policy",
    "collaboration.title": "Live collaboration",
    "collaboration.authRequired":
      "Sign in to create or join a collaboration room.",
    "collaboration.authChecking": "Checking sign-in status...",
    "collaboration.createDescription":
      "Create a room and share its link with collaborators.",
    "collaboration.saveFirst":
      "Save this scene to the cloud before starting collaboration.",
    "collaboration.shareDescription":
      "Share the complete link to invite collaborators.",
    "collaboration.status.idle": "Collaborate",
    "collaboration.status.preparing": "Preparing canvas...",
    "collaboration.status.joining": "Joining...",
    "collaboration.status.connected": "Collaborating",
    "collaboration.status.syncBlocked": "Sync stopped",
    "collaboration.status.reconnecting": "Reconnecting...",
    "collaboration.status.failed": "Connection stopped",
    "collaboration.status.unauthorized": "Unable to join",
    "collaboration.status.rateLimited": "Try again later",
    "collaboration.status.cancelled": "Cancelled",
    "collaboration.status.missingRoomKey": "Incomplete link",
    "collaboration.status.readOnly": "View only",
    "collaboration.status.readOnlyWithStatus": "{status} (View only)",
    "collaboration.error.network": "Network connection failed",
    "collaboration.error.operationFailed":
      "The collaboration action failed. Please try again.",
    "collaboration.action.creating": "Creating...",
    "collaboration.action.start": "Start collaboration",
    "collaboration.connectionStatus": "Connection",
    "collaboration.role.owner": "Owner",
    "collaboration.role.editor": "Can edit",
    "collaboration.role.viewer": "View only",
    "collaboration.linkRole.none": "Invited members only",
    "collaboration.linkRole.viewer": "Anyone with the link can view",
    "collaboration.linkRole.editor": "Anyone with the link can edit",
    "collaboration.dialogStatus.idle": "Not connected",
    "collaboration.dialogStatus.preparing": "Preparing canvas...",
    "collaboration.dialogStatus.joining": "Joining...",
    "collaboration.dialogStatus.connected": "Connected",
    "collaboration.dialogStatus.syncBlocked":
      "Connected, but sync stopped because the canvas is too large",
    "collaboration.dialogStatus.reconnecting": "Reconnecting...",
    "collaboration.dialogStatus.failed": "Connection stopped",
    "collaboration.dialogStatus.unauthorized": "Unable to join",
    "collaboration.dialogStatus.rateLimited": "Too many attempts. Try later.",
    "collaboration.dialogStatus.cancelled": "Join cancelled",
    "collaboration.dialogStatus.missingRoomKey": "Link is missing its key",
    "collaboration.toast.relayUnavailable":
      "Permissions were updated, but connected members may remain online until the relay reconnects.",
    "collaboration.toast.keyConflict":
      "This room already has an encryption key. Share the complete link from the device that created it, or reset the room generation.",
    "collaboration.toast.keySetupFailed":
      "Encryption setup failed. Select Start collaboration again.",
    "collaboration.toast.rotationSetupFailed":
      "The room generation changed, but encryption setup is incomplete. Reset the room generation again.",
    "collaboration.toast.rotationSuccess":
      "Room generation {generation} is ready with a new key. Share the new link.",
    "collaboration.toast.snapshotReset":
      "The cloud canvas was reset. Rejoining with the next member's canvas.",
    "collaboration.recovery.description":
      "If this is the correct link, the cloud canvas may have been encrypted with the wrong key. Resetting deletes the saved collaboration canvas and restarts from the next member's canvas.",
    "collaboration.recovery.reset": "Reset cloud canvas...",
    "collaboration.recovery.resetting": "Resetting...",
    "collaboration.recovery.confirmReset": "Delete cloud canvas",
    "collaboration.recovery.cancel": "Cancel",
    "collaboration.link.label": "Collaboration link",
    "collaboration.link.keyPresent":
      "The key after # stays in the browser and link, never on the server. Copy the complete link.",
    "collaboration.link.keyMissing":
      "This link is missing its key. Share the complete link from the device that created the room, or reset the room generation.",
    "collaboration.linkPermission": "Link access",
    "collaboration.members": "Members",
    "collaboration.member.revoked": " (Removed)",
    "collaboration.member.makeEditor": "Allow editing",
    "collaboration.member.makeViewer": "Make view only",
    "collaboration.member.remove": "Remove",
    "collaboration.action.end": "End collaboration",
    "collaboration.action.rotate": "Reset room generation",
    "collaboration.action.rotateTitle":
      "Invalidate existing join tokens and start a new room generation",
    "collaboration.action.leave": "Leave collaboration",
    "collaboration.failure.unauthorized":
      "You no longer have access to this room. Ask the owner for a new invitation.",
    "collaboration.failure.membershipRevoked":
      "Your collaboration access was removed.",
    "collaboration.failure.roomEnded":
      "This room was ended or reset. Ask the sharer for a new link.",
    "collaboration.failure.generationRotated":
      "This link uses an old encryption key. Ask the sharer for the latest complete link.",
    "collaboration.failure.unreadableRoom":
      "This link cannot decrypt the room. Ask the sharer for the latest complete link.",
    "collaboration.failure.protocolViolation":
      "The connection stopped because of a protocol error. Reload and report it if the problem continues.",
    "collaboration.failure.cryptoExhausted":
      "The connection's encryption limit was reached. Ask the owner to reset the room generation.",
    "collaboration.failure.retryLimit":
      "Reconnection failed repeatedly. Check your network and reload.",
    "collaboration.failure.wrongKey":
      "The link has the wrong encryption key, so the room was not joined and your canvas was not changed. Ask for the latest complete link.",
    "collaboration.failure.missingKeyCheck":
      "This room's encryption setup is incomplete. Ask the owner to reopen collaboration or reset the room generation.",
    "collaboration.failure.rateLimited":
      "Too many join attempts. This is not a permissions issue. Wait a minute, then open the link again.",
    "collaboration.warning.unreadableAssets":
      "Some images cannot be opened with this link. Other canvas content is still syncing; ask for the latest complete link to view them.",
    "collaboration.warning.realtimeTooLarge":
      "Live sync stopped: the {size} canvas exceeds the {limit} send limit, so other members will not receive new changes.",
    "collaboration.warning.backupTooLarge":
      "Cloud backup stopped: the {size} canvas exceeds the {limit} room limit, so reloads and later joiners will see an older version.",
    "collaboration.warning.tooLargeAdvice":
      "Export an image or save the scene to a file now. Reducing the canvas can restore sync; reload before rejoining if recently deleted content still counts toward the limit.",
    "collaboration.failure.invalidLink": "This collaboration link is invalid.",
    "collaboration.failure.missingRoomKey":
      "This collaboration link is missing the encryption key after #. Ask the sharer for the complete link.",
    "collaboration.failure.cancelled":
      "Join cancelled. Your original canvas was not changed.",
    "collaboration.failure.saveBeforeJoin":
      "The current scene could not be saved, so the room was not joined. Try again.",
    "collaboration.failure.joinFailed":
      "Unable to join the collaboration room. Check that you still have access.",
    "import.error.fileTooLarge":
      "Import failed: {name} ({size}) exceeds the {limit} limit.",
    "sharedScene.confirm.title": "Load shared scene?",
    "sharedScene.confirm.description": "This will replace the current canvas.",
    "sharedScene.confirm.action": "Replace and load",
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
    "dashboard.archive.active": "Active",
    "dashboard.archive.archived": "Archived",
    "dashboard.noArchivedScenes": "No archived scenes",
    "dashboard.noArchivedScenes.hint":
      "Archived scenes will appear here and can be restored at any time.",
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
    "workspace.settings.typeToConfirm": 'Type "{name}" to confirm deletion:',
    "workspace.settings.cancel": "Cancel",
    "workspace.settings.close": "Close",
    "workspace.settings.confirmDelete": "Delete workspace",
    "workspace.settings.deleting": "Deleting...",
    "workspace.settings.toast.updated": "Workspace updated",
    "workspace.settings.toast.updateFailed": "Failed to update workspace",
    "workspace.settings.toast.deleted": "Workspace deleted",
    "workspace.settings.toast.deleteFailed": "Failed to delete workspace",
    "workspace.settings.nameLabel": "Workspace Name",
    "workspace.settings.namePlaceholder": "Workspace name",
    "workspace.settings.selectActiveFirst": "Select an active workspace first.",
    "workspace.settings.save": "Save",
    "workspace.settings.saving": "Saving...",
    "workspace.settings.dangerZone": "Danger Zone",
    "workspace.settings.dangerDescription":
      "Deleting a workspace will permanently remove all its scenes.",
    "workspace.settings.deleteThisWorkspace": "Delete this workspace",
    "workspace.settings.defaultCannotDeleteShort":
      "Default workspace cannot be deleted.",
    "workspace.settings.typeNameToConfirm": 'Type "{name}" to confirm',
    "workspace.settings.typeWorkspaceNameToConfirm":
      "Type workspace name to confirm",
    "workspace.settings.confirmDeleteAction": "Confirm delete",
    "search.placeholder":
      "Search scenes by name, description, category, or project...",
    "search.resultsCount": 'Found {count} results for "{query}"',
    "search.showingCount": "Showing {total} scenes",
    "menu.importScene": "Import scene",
    "menu.sceneSettings": "Scene settings",
    "menu.moveToWorkspace": "Move to workspace",
    "menu.moveToWorkspace.success": 'Moved to "{name}"',
    "menu.moveToWorkspace.failed": "Failed to move scene. Please try again.",
    "menu.categories": "Categories",
    "archive.menu.archive": "Archive scene",
    "archive.menu.unarchive": "Restore scene",
    "archive.toast.archived": "Scene archived.",
    "archive.toast.currentArchived":
      "Scene archived. It remains open in the editor.",
    "archive.toast.unarchived": "Scene restored.",
    "archive.toast.failed":
      "Unable to update archive status. Please try again.",
    "dashboard.category.all": "All categories",
    "dashboard.category.manage": "Manage categories",
    "category.manage.title": "Manage categories",
    "category.manage.description":
      "Create, rename, or delete your scene categories.",
    "category.manage.empty":
      "No categories yet. Create one to organize your scenes.",
    "category.manage.namePlaceholder": "Enter a category name",
    "category.manage.nameInvalid": "Please enter a valid category name",
    "category.manage.sceneCount": "{count} scenes",
    "category.manage.rename": "Rename category",
    "category.manage.delete": "Delete category",
    "category.manage.deleteConfirm.description":
      'Are you sure you want to delete the category "{name}"? It will be removed from {count} scenes. The scenes themselves are not affected.',
    "category.toast.created": 'Category "{name}" created',
    "category.toast.renamed": 'Category renamed to "{name}"',
    "category.toast.deleted": "Category deleted",
    "category.toast.duplicate": "A category with this name already exists.",
    "category.toast.failed": "Failed to update category. Please try again.",
    "category.toast.assignFailed":
      "Failed to update scene categories. Please try again.",
    "publish.badge.public": "Public",
    "publish.badge.private": "Private",
    "publish.menu.publish": "Set to public",
    "publish.menu.unpublish": "Set to private",
    "publish.menu.copyLink": "Copy public link",
    "publish.menu.openLink": "Open public link",
    "publish.toast.published": "Public link is ready.",
    "publish.toast.unpublished": "This scene is now private.",
    "publish.toast.copied": "Public link copied.",
    "publish.toast.failed":
      "Unable to update publish status. Please try again.",
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
    "buttons.save": "Save",
    "common.processing": "Processing...",
    "labels.sceneName": "Scene name",
    "labels.workspace": "Workspace",
    "labels.categories": "Categories",
    "labels.content": "Content",
    "labels.untitled": "Untitled",
    "placeholders.sceneName": "Enter a scene name",
    "placeholders.description": "Add a short description",
    "validation.nameRequired": "Name is required",
    "validation.nameTooLong": "Name is too long",
    "validation.descriptionTooLong": "Description is too long",
    "share.scene.description": "Anyone with this link can view this scene.",
    "share.scene.link": "Link",
    "share.scene.lock": "Private link",
    "menu.moreOptions": "More options",
    "workspace.current": "Current workspace: {name}",
    "workspace.none": "None",
    "workspace.empty": "No workspace found.",
    "workspace.createConfirm.title": "Create workspace?",
    "workspace.createConfirm.description": 'Create a workspace named "{name}".',
    "workspace.create.pending": "Creating...",
    "workspace.create.action": "Create",
    "workspace.pending": "Will create workspace: {name}",
    "scene.change.title": "Switch scene?",
    "scene.change.description": "Save the current scene before switching?",
    "scene.change.save": "Save, then switch",
    "scene.change.discard": "Switch without saving",
    "scene.save.title": "Save scene",
    "scene.save.description": "Save the scene to the cloud.",
    "scene.save.cancelLabel": "Cancel save",
    "scene.save.confirmLabel": "Confirm save",
    "scene.new.title": "New scene",
    "scene.new.description": "Create a new scene.",
    "scene.new.descriptionLabel": "Description (optional)",
    "scene.new.reset": "Start with an empty canvas",
    "scene.new.keep": "Keep current canvas content",
    "scene.new.createLabel": "Create scene",
    "scene.switchWorkspace.title": "Switch workspace",
    "scene.switchWorkspace.description": "Switch from {from} to {to}.",
    "scene.switchWorkspace.current": "current workspace",
    "scene.switchWorkspace.selected": "selected workspace",
    "scene.switchWorkspace.openExisting":
      "Open an existing scene in this workspace",
    "scene.switchWorkspace.createEmpty": "Create a new empty scene",
    "scene.rename.description": "Rename scene",
    "scene.rename.tooltip": "Click to rename scene",
    "scene.settings.title": "Scene settings",
    "scene.settings.cancelLabel": "Cancel editing",
    "scene.settings.confirmLabel": "Save scene settings",
    "scene.conflict.title": "Remote changes detected",
    "scene.conflict.description":
      "This scene was updated elsewhere while you have local changes.",
    "scene.conflict.load.title": "Load remote version",
    "scene.conflict.load.description":
      "Discard local changes and use the latest remote version.",
    "scene.conflict.save.title": "Save local as a new scene",
    "scene.conflict.save.description":
      "Keep both versions by saving local changes as a new scene.",
    "scene.conflict.keep.title": "Keep local for now",
    "scene.conflict.keep.description":
      "Continue editing locally and sync later.",
    "category.selector.placeholder": "Type or create a category",
    "category.selector.searching": "Searching...",
    "category.selector.empty": "No matching results.",
    "category.selector.loadFailed": "Failed to get categories.",
    "welcomeScreen.github": "GitHub repository",
    "errorPage.title": "Something went wrong",
    "errorPage.description":
      "Reload the page. If the problem continues, return to the canvas and open the scene again.",
    "errorPage.id": "Error ID:",
    "errorPage.retry": "Try again",
    "navigation.backToCanvas": "Back to canvas",
    "notFound.title": "This drawing space does not exist.",
    "notFound.description":
      "The page may have moved, been deleted, or used a broken link. Return to the canvas or open the dashboard.",
    "toast.scene.remoteLoaded": "Loaded the latest remote scene.",
    "toast.scene.remoteLoadFailed":
      "Failed to load the remote scene. Try again.",
    "toast.scene.localCopySaved": "Saved local changes as a new scene.",
    "toast.scene.localCopyFailed":
      "Failed to save local changes as a new scene.",
    "toast.scene.loaded": "Scene loaded.",
    "toast.scene.loadFailed": "Failed to load scene.",
    "toast.scene.saveFailed": "Failed to save scene. Try again.",
    "toast.scene.remoteConflict":
      "The scene was updated elsewhere. Refresh and try again.",
    "toast.scene.versionCheckFailed":
      "Unable to verify the scene version. Reload and try again.",
    "toast.workspace.required": "Select a workspace before uploading.",
    "toast.export.fileSaved": "File saved to disk.",
    "toast.export.fileSaveFailed": "Failed to save the file. Try again.",
    "toast.export.imageFailed": "Failed to export the image. Try again.",
    "toast.cloud.uploaded": "Uploaded to the cloud.",
    "toast.cloud.uploadFailed": "Failed to upload to the cloud. Try again.",
    "errors.failedToExportScene": "Failed to export scene. Try again.",
    "errors.exportInProgress": "An export is already in progress.",
    "errors.emptyCanvas": "An empty canvas cannot be exported.",
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
    "app.cloudUpload.toast.error.noSceneToUpdate": "此場景尚未儲存。",
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
    "buttons.close": "關閉",
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
    "auth.signOutConfirm.title": "登出前要先儲存嗎？",
    "auth.signOutConfirm.description":
      "登出會清除這個瀏覽器中的目前畫布與圖片。若要保留最新變更，請先儲存。",
    "auth.signOutConfirm.save": "儲存後登出",
    "auth.signOutConfirm.discard": "捨棄並登出",
    "auth.loading": "正在載入登入頁面…",
    "auth.continueWithGoogle": "使用 Google 繼續",
    "auth.connecting": "連線中…",
    "auth.welcome": "歡迎使用 Excalidraw X Ericts",
    "auth.required.title": "需要登入",
    "auth.required.description": "請先登入以使用此功能。",
    "auth.agreement.click": "繼續即表示你同意我們的",
    "auth.agreement.signIn": "登入即表示你同意我們的",
    "auth.terms": "服務條款",
    "auth.and": "與",
    "auth.privacy": "隱私權政策",
    "collaboration.title": "即時共編",
    "collaboration.authRequired": "請先登入 Drawstuff 才能建立或加入共編。",
    "collaboration.authChecking": "正在確認登入狀態…",
    "collaboration.createDescription": "建立共編 room，再把連結分享給協作者。",
    "collaboration.saveFirst": "請先把場景儲存到雲端，再開啟共編。",
    "collaboration.shareDescription": "分享完整連結，邀請協作者加入。",
    "collaboration.status.idle": "共編",
    "collaboration.status.preparing": "準備畫布中…",
    "collaboration.status.joining": "加入中…",
    "collaboration.status.connected": "共編中",
    "collaboration.status.syncBlocked": "同步已停止",
    "collaboration.status.reconnecting": "重新連線中…",
    "collaboration.status.failed": "連線已停止",
    "collaboration.status.unauthorized": "無法加入",
    "collaboration.status.rateLimited": "請稍後再試",
    "collaboration.status.cancelled": "已取消",
    "collaboration.status.missingRoomKey": "連結不完整",
    "collaboration.status.readOnly": "僅檢視",
    "collaboration.status.readOnlyWithStatus": "{status}（僅檢視）",
    "collaboration.error.network": "網路連線失敗",
    "collaboration.error.operationFailed": "即時共編操作失敗，請稍後再試。",
    "collaboration.action.creating": "建立中…",
    "collaboration.action.start": "開始共編",
    "collaboration.connectionStatus": "連線狀態",
    "collaboration.role.owner": "擁有者",
    "collaboration.role.editor": "可編輯",
    "collaboration.role.viewer": "僅檢視",
    "collaboration.linkRole.none": "僅受邀成員",
    "collaboration.linkRole.viewer": "有連結者可檢視",
    "collaboration.linkRole.editor": "有連結者可編輯",
    "collaboration.dialogStatus.idle": "未連線",
    "collaboration.dialogStatus.preparing": "準備畫布中…",
    "collaboration.dialogStatus.joining": "加入中…",
    "collaboration.dialogStatus.connected": "已連線",
    "collaboration.dialogStatus.syncBlocked": "已連線，但畫布過大，已停止同步",
    "collaboration.dialogStatus.reconnecting": "正在重新連線…",
    "collaboration.dialogStatus.failed": "連線已停止",
    "collaboration.dialogStatus.unauthorized": "無法加入",
    "collaboration.dialogStatus.rateLimited": "嘗試次數過多，請稍後再試",
    "collaboration.dialogStatus.cancelled": "已取消加入",
    "collaboration.dialogStatus.missingRoomKey": "連結缺少金鑰",
    "collaboration.toast.relayUnavailable":
      "權限已更新，但 relay 恢復前，已連線成員可能仍在線上。",
    "collaboration.toast.keyConflict":
      "這個 room 已有加密金鑰。請從建立 room 的裝置分享完整連結，或重設 room generation。",
    "collaboration.toast.keySetupFailed":
      "無法完成加密設定，請再按一次「開始共編」。",
    "collaboration.toast.rotationSetupFailed":
      "room generation 已更換，但加密設定未完成。請再重設一次。",
    "collaboration.toast.rotationSuccess":
      "已建立 room generation {generation} 與新金鑰，請重新分享連結。",
    "collaboration.toast.snapshotReset":
      "已重設雲端畫布，正在以下一位成員的畫布重新加入。",
    "collaboration.recovery.description":
      "若連結正確，雲端畫布可能曾以錯誤金鑰加密。重設會刪除已儲存的共編畫布，並從下一位成員的畫布重新開始。",
    "collaboration.recovery.reset": "重設雲端畫布…",
    "collaboration.recovery.resetting": "重設中…",
    "collaboration.recovery.confirmReset": "刪除雲端畫布",
    "collaboration.recovery.cancel": "取消",
    "collaboration.link.label": "共編連結",
    "collaboration.link.keyPresent":
      "# 後的金鑰只存在瀏覽器與連結中，不會傳到伺服器。請複製完整連結。",
    "collaboration.link.keyMissing":
      "此連結缺少金鑰。請從建立 room 的裝置分享完整連結，或重設 room generation。",
    "collaboration.linkPermission": "連結權限",
    "collaboration.members": "成員",
    "collaboration.member.revoked": "（已移除）",
    "collaboration.member.makeEditor": "改為可編輯",
    "collaboration.member.makeViewer": "改為僅檢視",
    "collaboration.member.remove": "移除",
    "collaboration.action.end": "結束共編",
    "collaboration.action.rotate": "重設 room generation",
    "collaboration.action.rotateTitle":
      "讓既有 join token 失效，並開始新的 room generation",
    "collaboration.action.leave": "離開共編",
    "collaboration.failure.unauthorized":
      "你已無法存取這個 room，請向擁有者索取新邀請。",
    "collaboration.failure.membershipRevoked": "你的共編權限已被移除。",
    "collaboration.failure.roomEnded":
      "這個 room 已結束或重設，請向分享者索取新連結。",
    "collaboration.failure.generationRotated":
      "此連結使用舊金鑰，請向分享者索取最新的完整連結。",
    "collaboration.failure.unreadableRoom":
      "此連結無法解密 room，請向分享者索取最新的完整連結。",
    "collaboration.failure.protocolViolation":
      "連線因通訊協定錯誤而停止。請重新載入；若持續發生請回報。",
    "collaboration.failure.cryptoExhausted":
      "連線已達加密上限，請由擁有者重設 room generation。",
    "collaboration.failure.retryLimit":
      "多次重新連線失敗，請確認網路後重新載入。",
    "collaboration.failure.wrongKey":
      "連結的加密金鑰不正確，因此未加入 room，原畫布也未變更。請索取最新的完整連結。",
    "collaboration.failure.missingKeyCheck":
      "room 的加密設定未完成，請擁有者重新開啟共編或重設 room generation。",
    "collaboration.failure.rateLimited":
      "加入次數過多。這不是權限問題；請等待一分鐘後重新開啟連結。",
    "collaboration.warning.unreadableAssets":
      "部分圖片無法用此連結開啟。其他畫布內容仍在同步；請索取最新完整連結以查看圖片。",
    "collaboration.warning.realtimeTooLarge":
      "即時同步已停止：畫布 {size} 超過傳送上限 {limit}，其他成員不會收到新變更。",
    "collaboration.warning.backupTooLarge":
      "雲端備份已停止：畫布 {size} 超過 room 上限 {limit}，重新載入或稍後加入只會看到舊版本。",
    "collaboration.warning.tooLargeAdvice":
      "請立即匯出圖片或儲存場景檔。減少畫布內容可恢復同步；若剛刪除的內容仍計入上限，請重新載入後再加入。",
    "collaboration.failure.invalidLink": "此共編連結格式不正確。",
    "collaboration.failure.missingRoomKey":
      "此共編連結缺少 # 後的加密金鑰，請向分享者索取完整連結。",
    "collaboration.failure.cancelled": "已取消加入，原畫布沒有變更。",
    "collaboration.failure.saveBeforeJoin":
      "無法儲存目前場景，因此未加入共編。請再試一次。",
    "collaboration.failure.joinFailed":
      "無法加入共編 room，請確認你仍有存取權限。",
    "import.error.fileTooLarge": "匯入失敗：{name}（{size}）超過上限 {limit}。",
    "sharedScene.confirm.title": "載入分享連結內容？",
    "sharedScene.confirm.description": "此操作將覆蓋目前畫布內容。",
    "sharedScene.confirm.action": "覆蓋並載入",
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
    "dashboard.archive.active": "使用中",
    "dashboard.archive.archived": "已封存",
    "dashboard.noArchivedScenes": "沒有已封存的場景",
    "dashboard.noArchivedScenes.hint": "封存的場景會顯示於此，並可隨時還原。",
    "dashboard.workspace.create": "建立工作空間",
    "dashboard.workspace.rename": "重新命名工作空間",
    "dashboard.workspace.delete": "刪除工作空間",
    "dashboard.workspace.manage": "工作空間設定",
    "dashboard.workspace.createDialog.description":
      "直接從場景列表建立新的工作空間。",
    "dashboard.workspace.namePlaceholder": "輸入工作空間名稱",
    "dashboard.workspace.creating": "建立中...",
    "dashboard.workspace.created": "已建立工作空間「{name}」",
    "dashboard.workspace.createFailed": "建立工作空間失敗",
    "dashboard.workspace.nameInvalid": "請輸入有效的工作空間名稱",
    "workspace.settings.title": "設定",
    "workspace.settings.title.rename": "重新命名工作空間",
    "workspace.settings.title.delete": "刪除工作空間",
    "workspace.settings.description": "編輯工作空間資訊並管理高風險操作。",
    "workspace.settings.description.rename": "變更目前工作空間的名稱。",
    "workspace.settings.description.delete": "此操作不可復原，請謹慎操作。",
    "workspace.settings.defaultCannotDelete":
      "預設工作空間無法刪除，請選擇其他工作空間。",
    "workspace.settings.deleteWarningTitle": "即將刪除「{name}」及其所有場景。",
    "workspace.settings.deleteWarningBody":
      "此操作不可復原，該工作空間中的所有場景都將永久消失。",
    "workspace.settings.typeToConfirm": "請輸入「{name}」以確認刪除：",
    "workspace.settings.cancel": "取消",
    "workspace.settings.close": "關閉",
    "workspace.settings.confirmDelete": "刪除工作空間",
    "workspace.settings.deleting": "刪除中...",
    "workspace.settings.toast.updated": "已更新工作空間",
    "workspace.settings.toast.updateFailed": "更新工作空間失敗",
    "workspace.settings.toast.deleted": "已刪除工作空間",
    "workspace.settings.toast.deleteFailed": "刪除工作空間失敗",
    "workspace.settings.nameLabel": "工作空間名稱",
    "workspace.settings.namePlaceholder": "工作空間名稱",
    "workspace.settings.selectActiveFirst": "請先選擇啟用的工作空間。",
    "workspace.settings.save": "儲存",
    "workspace.settings.saving": "儲存中...",
    "workspace.settings.dangerZone": "高風險區域",
    "workspace.settings.dangerDescription":
      "刪除工作空間會永久移除其中所有場景。",
    "workspace.settings.deleteThisWorkspace": "刪除此工作空間",
    "workspace.settings.defaultCannotDeleteShort": "預設工作空間無法刪除。",
    "workspace.settings.typeNameToConfirm": "請輸入「{name}」以確認",
    "workspace.settings.typeWorkspaceNameToConfirm": "請輸入工作空間名稱以確認",
    "workspace.settings.confirmDeleteAction": "確認刪除",
    "search.placeholder": "以名稱、描述、分類或專案名稱搜尋場景...",
    "search.resultsCount": '找到 {count} 筆結果，關鍵字："{query}"',
    "search.showingCount": "共顯示 {total} 個場景",
    "menu.importScene": "匯入場景",
    "menu.sceneSettings": "場景設定",
    "menu.moveToWorkspace": "移至工作空間",
    "menu.moveToWorkspace.success": "已移至「{name}」",
    "menu.moveToWorkspace.failed": "移動場景失敗，請再試一次。",
    "menu.categories": "分類",
    "archive.menu.archive": "封存場景",
    "archive.menu.unarchive": "還原場景",
    "archive.toast.archived": "場景已封存。",
    "archive.toast.currentArchived": "場景已封存，編輯器會保持開啟。",
    "archive.toast.unarchived": "場景已還原。",
    "archive.toast.failed": "無法更新封存狀態，請再試一次。",
    "dashboard.category.all": "全部分類",
    "dashboard.category.manage": "管理分類",
    "category.manage.title": "管理分類",
    "category.manage.description": "建立、重新命名或刪除場景分類。",
    "category.manage.empty": "尚無分類，建立一個來整理你的場景。",
    "category.manage.namePlaceholder": "輸入分類名稱",
    "category.manage.nameInvalid": "請輸入有效的分類名稱",
    "category.manage.sceneCount": "{count} 個場景",
    "category.manage.rename": "重新命名分類",
    "category.manage.delete": "刪除分類",
    "category.manage.deleteConfirm.description":
      "確定要刪除分類「{name}」嗎？將自 {count} 個場景移除此分類，場景本身不受影響。",
    "category.toast.created": "已建立分類「{name}」",
    "category.toast.renamed": "分類已更名為「{name}」",
    "category.toast.deleted": "已刪除分類",
    "category.toast.duplicate": "同名分類已存在。",
    "category.toast.failed": "更新分類失敗，請再試一次。",
    "category.toast.assignFailed": "更新場景分類失敗，請再試一次。",
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
    "buttons.save": "儲存",
    "common.processing": "處理中…",
    "labels.sceneName": "場景名稱",
    "labels.workspace": "工作空間",
    "labels.categories": "分類",
    "labels.content": "內容",
    "labels.untitled": "未命名",
    "placeholders.sceneName": "輸入場景名稱",
    "placeholders.description": "加入簡短描述",
    "validation.nameRequired": "請輸入名稱",
    "validation.nameTooLong": "名稱過長",
    "validation.descriptionTooLong": "描述過長",
    "share.scene.description": "任何持有此連結的人都能查看場景。",
    "share.scene.link": "連結",
    "share.scene.lock": "私人連結",
    "menu.moreOptions": "更多選項",
    "workspace.current": "目前工作空間：{name}",
    "workspace.none": "無",
    "workspace.empty": "找不到工作空間。",
    "workspace.createConfirm.title": "建立工作空間？",
    "workspace.createConfirm.description": "建立名為「{name}」的工作空間。",
    "workspace.create.pending": "建立中…",
    "workspace.create.action": "建立",
    "workspace.pending": "將建立工作空間：{name}",
    "scene.change.title": "切換場景？",
    "scene.change.description": "切換前要先儲存目前場景嗎？",
    "scene.change.save": "儲存後切換",
    "scene.change.discard": "不儲存並切換",
    "scene.save.title": "儲存場景",
    "scene.save.description": "將場景儲存到雲端。",
    "scene.save.cancelLabel": "取消儲存",
    "scene.save.confirmLabel": "確認儲存",
    "scene.new.title": "新增場景",
    "scene.new.description": "建立新場景。",
    "scene.new.descriptionLabel": "描述（選填）",
    "scene.new.reset": "使用空白畫布",
    "scene.new.keep": "保留目前畫布內容",
    "scene.new.createLabel": "建立場景",
    "scene.switchWorkspace.title": "切換工作空間",
    "scene.switchWorkspace.description": "從 {from} 切換到 {to}。",
    "scene.switchWorkspace.current": "目前工作空間",
    "scene.switchWorkspace.selected": "所選工作空間",
    "scene.switchWorkspace.openExisting": "開啟此工作空間的既有場景",
    "scene.switchWorkspace.createEmpty": "建立空白新場景",
    "scene.rename.description": "重新命名場景",
    "scene.rename.tooltip": "點擊以重新命名場景",
    "scene.settings.title": "場景設定",
    "scene.settings.cancelLabel": "取消編輯",
    "scene.settings.confirmLabel": "儲存場景設定",
    "scene.conflict.title": "偵測到遠端變更",
    "scene.conflict.description": "你有本機變更時，此場景已在其他地方更新。",
    "scene.conflict.load.title": "載入遠端版本",
    "scene.conflict.load.description": "捨棄本機變更並使用最新遠端版本。",
    "scene.conflict.save.title": "將本機版本另存為新場景",
    "scene.conflict.save.description": "另存本機變更以保留兩個版本。",
    "scene.conflict.keep.title": "暫時保留本機版本",
    "scene.conflict.keep.description": "繼續在本機編輯，稍後再同步。",
    "category.selector.placeholder": "輸入或建立分類",
    "category.selector.searching": "搜尋中…",
    "category.selector.empty": "找不到結果。",
    "category.selector.loadFailed": "取得分類失敗。",
    "welcomeScreen.github": "GitHub 儲存庫",
    "errorPage.title": "發生錯誤",
    "errorPage.description":
      "請重新載入頁面；若問題持續，請返回畫布並重新開啟場景。",
    "errorPage.id": "錯誤 ID：",
    "errorPage.retry": "再試一次",
    "navigation.backToCanvas": "返回畫布",
    "notFound.title": "這個繪圖空間不存在。",
    "notFound.description":
      "頁面可能已移動、刪除，或連結有誤。請返回畫布或開啟場景列表。",
    "toast.scene.remoteLoaded": "已載入最新遠端場景。",
    "toast.scene.remoteLoadFailed": "載入遠端場景失敗，請再試一次。",
    "toast.scene.localCopySaved": "已將本機變更另存為新場景。",
    "toast.scene.localCopyFailed": "另存本機變更失敗。",
    "toast.scene.loaded": "已載入場景。",
    "toast.scene.loadFailed": "載入場景失敗。",
    "toast.scene.saveFailed": "儲存場景失敗，請再試一次。",
    "toast.scene.remoteConflict": "場景已在其他地方更新，請重新整理後再試。",
    "toast.scene.versionCheckFailed": "無法確認場景版本，請重新載入後再試。",
    "toast.workspace.required": "請先選擇工作空間再上傳。",
    "toast.export.fileSaved": "檔案已儲存到磁碟。",
    "toast.export.fileSaveFailed": "儲存檔案失敗，請再試一次。",
    "toast.export.imageFailed": "匯出圖片失敗，請再試一次。",
    "toast.cloud.uploaded": "已上傳到雲端。",
    "toast.cloud.uploadFailed": "上傳雲端失敗，請再試一次。",
    "errors.failedToExportScene": "匯出場景失敗，請再試一次。",
    "errors.exportInProgress": "已有匯出作業正在進行。",
    "errors.emptyCanvas": "空白畫布無法匯出。",
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

export function translateApp(
  langCode: string,
  key: string,
  values?: PlaceholderValues,
): string {
  const template =
    appTranslations[langCode]?.[key] ?? appTranslations.en?.[key];
  return formatPlaceholders(template ?? key, values);
}
