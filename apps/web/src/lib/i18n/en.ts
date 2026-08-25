// 應用層英文字典：所有 app 翻譯 key 的唯一來源，AppTranslationKey 由此推導。
// 僅由 loadAppDictionary() 以 dynamic import 載入，避免兩種語言同時進共用 client chunk。
export const en = {
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
  "exportDialog.disk_details": "Save the current scene as an .excalidraw file.",
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
  "buttons.retry": "Retry",
  "workspace.navigation": "Workspace navigation",
  "workspace.route.description": "Workspace route content",
  "workspace.back": "Back",
  "workspace.backToDashboard": "Back to dashboard",
  "workspace.descriptionLabel": "Description (optional)",
  "workspace.descriptionLimit": "Up to 100 characters.",
  "labels.fileTitle": "File title",
  "labels.description": "Description",
  "labels.copy": "Copy",
  "labels.share": "Share",
  "canvas.actions.open": "Share and collaborate. Current status: {status}",
  "canvas.actions.quick": "Quick actions",
  "canvas.actions.closeQuick": "Close quick actions",
  "canvas.actions.library": "Library",
  "canvas.actions.save": "Save to cloud",
  "canvas.actions.saveShortcut": "Shortcut: Cmd/Ctrl+S",
  "canvas.actions.share": "Create shareable link",
  "canvas.saveStatus.idle": "Ready",
  "canvas.saveStatus.uploading": "Saving…",
  "canvas.saveStatus.success": "Saved",
  "canvas.saveStatus.error": "Failed",
  "canvas.saveStatus.offline": "Offline",

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
  "menu.admin": "Admin console",
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
  "auth.welcome": "Welcome to drawstuff",
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
  "collaboration.status.joinFailed": "Join failed",
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
  "collaboration.dialogStatus.joinFailed": "Join failed. Try again.",
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
  "collaboration.failure.unsupportedProtocolVersion":
    "This tab is running an outdated collaboration version. Refresh the page, then join again.",
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
    "Could not join the room. This is usually temporary — check your connection and open the link again.",
  "import.error.fileTooLarge":
    "Import failed: {name} ({size}) exceeds the {limit} limit.",
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
  "dashboard.loadFailed": "Failed to load scenes",
  "dashboard.categoriesLoadFailed": "Failed to load categories.",
  "dashboard.loadFailed.hint":
    "Something went wrong while loading your scenes. Please try again.",
  "dashboard.sceneAlreadyOpen": "You're already editing this scene.",
  "dashboard.filter.all": "All",
  "dashboard.filter.public": "Public",
  "dashboard.filter.private": "Private",
  "dashboard.filters": "Filters",
  "dashboard.filters.description":
    "Narrow scenes by publishing, archive, and category status.",
  "dashboard.filters.publish": "Publishing",
  "dashboard.filters.archive": "Archive",
  "dashboard.filters.category": "Category",
  "dashboard.filters.clear": "Clear filters",
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
  "workspace.settings.general": "General",
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
  "workspace.settings.toast.missing":
    "This workspace no longer exists. Returning to the dashboard.",
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
  "workspace.settings.currentCanvasWarningTitle":
    "This workspace contains the current canvas scene.",
  "workspace.settings.currentCanvasWarningBody":
    "Deleting it will also clear the current scene, local draft, and undo history.",
  "workspace.settings.collaborationBlocked":
    "Leave the collaboration room before deleting this workspace.",
  "search.placeholder":
    "Search scenes by name, description, category, or project...",
  "search.resultsCount": 'Loaded {count} results for "{query}"',
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
  "archive.toast.failed": "Unable to update archive status. Please try again.",
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
  "workspace.placeholder.search": "Find workspace",
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
  "scene.conflict.keep.description": "Continue editing locally and sync later.",
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
  "toast.scene.remoteLoadFailed": "Failed to load the remote scene. Try again.",
  "toast.scene.localCopySaved": "Saved local changes as a new scene.",
  "toast.scene.localCopyFailed": "Failed to save local changes as a new scene.",
  "toast.scene.loaded": "Scene loaded.",
  "toast.scene.loadFailed": "Failed to load scene.",
  "toast.scene.saveFailed": "Failed to save scene. Try again.",
  "toast.scene.deleteFailed": "Failed to delete scene. Try again.",
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
};
