// 應用層英文字典：所有 app 翻譯 key 的唯一來源，AppTranslationKey 由此推導。
// 僅由 loadAppDictionary() 以 dynamic import 載入，避免兩種語言同時進共用 client chunk。
export const en = {
  "storage.detachedDraft": "Unsaved · not in “{name}”",
  "storage.savePersonal": "Save to my scenes",
  "storage.room": "Room · {roomId}",
  "storage.room.pending": "Changes not saved yet",
  "storage.room.saving": "Saving",
  "storage.room.saved": "Saved",
  "storage.room.failed": "Save failed",
  "storage.save": "Save",
  "storage.saveRoom": "Save the room",
  "storage.copy": "Save a copy to my scenes",
  "storage.updateSource": "Update my original scene “{name}”",
  "storage.updateSourceUnnamed": "Update my original scene",
  "storage.download": "Download a local copy",
  "storage.exit": "Back to my canvas",
  "storage.copyNotice":
    "The room is unchanged. The personal cloud copy is not end-to-end encrypted and is not automatically public.",
  "storage.personalCopySaved":
    "Saved a copy to my scenes. The room itself saves separately.",
  "storage.keepRoom": "Keep editing the room; decide later",
  "storage.originalSaved": "Original scene updated.",
  "storage.sourceConflict":
    "The original scene changed elsewhere. Save a personal copy, or leave the room and reload the original before updating it.",
  "storage.leaveRisk": "Unconfirmed room changes may be lost. Leave this room?",

  "app.export.cloud.title": "Cloud Upload",
  "app.export.cloud.loading": "Uploading",
  "app.export.link.loading": "Exporting",
  "app.overwriteConfirm.action.uploadToCloud.button": "Upload to Cloud",
  "app.overwriteConfirm.modal.shareableLink.description":
    "You can choose to export the scene to an image, save it to disk, or upload it to the cloud. You can also choose to overwrite the existing scene.",
  "app.cloudUpload.tooltip.idle": "Waiting to upload to cloud",
  "app.cloudUpload.tooltip.uploading": "Uploading to cloud",
  "app.cloudUpload.tooltip.success": "Synced to cloud",
  "app.cloudUpload.tooltip.error": "Upload failed, click to retry",
  "app.cloudUpload.tooltip.offline": "Currently offline",
  "app.cloudUpload.toast.success": "Saved to my scenes.",
  "app.cloudUpload.toast.error.sceneData":
    "Unable to get current scene data, please try again.",
  "app.cloudUpload.toast.error.noSceneToUpdate":
    "This scene has not been saved yet.",
  "app.cloudUpload.toast.error.upload": "Couldn't save. Try again.",
  "app.cloudUpload.toast.error.publishedArtifactsRender":
    "Saved, but the public version could not be rendered. Save again to retry.",
  "app.cloudUpload.toast.error.publishedArtifactsUpload":
    "Saved, but the public version could not be uploaded ({size}). Save again to retry.",

  // Missing keys used across the app that may not exist in Excalidraw
  // Overwrite confirm dialog
  "overwriteConfirm.modal.shareableLink.title": "Open shared scene?",
  "overwriteConfirm.modal.shareableLink.button": "Replace current scene",
  "overwriteConfirm.modal.shareableLink.keep": "Keep current scene",
  "overwriteConfirm.action.exportToImage.button": "Export to image",
  "overwriteConfirm.action.saveToDisk.button": "Save to disk",

  // Export dialog cards
  "exportDialog.disk_title": "Save to disk",
  "exportDialog.link_title": "Create shareable link",

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
  "labels.copied": "Copied",
  "labels.copyFailed": "Couldn't copy. Select the text and copy it manually.",
  "labels.share": "Share",
  "canvas.actions.quick": "Quick actions",
  "canvas.actions.closeQuick": "Close quick actions",
  "canvas.actions.library": "Library",
  "canvas.actions.saveShortcut": "Shortcut: Cmd/Ctrl+S",
  "canvas.actions.share": "Create shareable link",
  "canvas.saveStatus.idle": "Ready",
  "canvas.saveStatus.uploading": "Saving",
  "canvas.saveStatus.success": "Saved",
  "canvas.saveStatus.error": "Failed",
  "canvas.saveStatus.offline": "Offline",

  // Stats
  "stats.storage": "Storage",
  "stats.scene": "Scene",
  "stats.total": "Total",

  // Alerts

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
  "auth.signedOutDraft.title":
    "Keep the canvas from while you were signed out?",
  "auth.signedOutDraft.description":
    "This canvas was edited while you were signed out, so it isn't part of any of your saved scenes. Save it as a new scene, keep editing without saving, or discard it.",
  "auth.signedOutDraft.descriptionDetached":
    "You edited this canvas while signed out, so these changes are not in “{name}”. Save them as a new scene, keep editing without saving, or discard them.",
  "auth.signedOutDraft.keep": "Keep editing without saving",
  "auth.signedOutDraft.save": "Save as new scene",
  "auth.signedOutDraft.discard": "Discard",
  "auth.continueWithGoogle": "Continue with Google",
  "auth.connecting": "Connecting",
  "auth.error.signInFailed":
    "Unable to connect to Google. Check your connection and try again.",
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
  "collaboration.authChecking": "Checking sign-in status",
  "collaboration.createDescription": "Start a room from this canvas.",
  "collaboration.shareDescription":
    "Share the link and choose who can open the room.",
  "collaboration.status.idle": "Collaborate",
  "collaboration.status.preparing": "Preparing canvas",
  "collaboration.status.joining": "Joining",
  "collaboration.status.connected": "Collaborating",
  "collaboration.status.syncBlocked": "Sync stopped",
  "collaboration.status.reconnecting": "Reconnecting",
  "collaboration.status.failed": "Connection stopped",
  "collaboration.status.unauthorized": "Unable to join",
  "collaboration.status.joinFailed": "Join failed",
  "collaboration.status.rateLimited": "Try again later",
  "collaboration.status.cancelled": "Cancelled",
  "collaboration.status.readOnly": "View only",
  "collaboration.status.readOnlyWithStatus": "{status} (View only)",
  "collaboration.toast.initializationPending":
    "Room creation is not confirmed yet. The canvas is paused; retry or cancel this creation.",
  "collaboration.action.cancelInitialization": "Cancel room creation",
  "collaboration.toast.initializationAttachments":
    "Some image files are missing or unsupported. Reload the scene or remove those images before starting collaboration.",
  "collaboration.error.operationFailed":
    "The collaboration action failed. Please try again.",
  "collaboration.action.creating": "Creating room",
  "collaboration.action.start": "Start collaboration",
  "collaboration.create.noPersonalCopy": "Saved in the room, not in My scenes.",
  "collaboration.create.protection":
    "Like your scenes, the room is protected by sign-in: only people you invite, or anyone with the link if you allow it, can open it.",
  "collaboration.create.sourceCopy": "Your original scene isn't changed.",
  "collaboration.role.owner": "Owner",
  "collaboration.role.editor": "Can edit",
  "collaboration.role.viewer": "View only",
  "collaboration.linkRole.none": "Invited people only",
  "collaboration.linkRole.viewer": "Anyone with the link can view",
  "collaboration.linkRole.editor": "Anyone with the link can edit",
  "collaboration.dialogStatus.idle": "Not connected",
  "collaboration.dialogStatus.preparing": "Preparing canvas",
  "collaboration.dialogStatus.joining": "Joining",
  "collaboration.dialogStatus.connected": "Connected",
  "collaboration.dialogStatus.syncBlocked": "Sync stopped",
  "collaboration.dialogStatus.reconnecting": "Reconnecting",
  "collaboration.dialogStatus.failed": "Connection stopped",
  "collaboration.dialogStatus.unauthorized": "Unable to join",
  "collaboration.dialogStatus.joinFailed": "Join failed. Try again.",
  "collaboration.dialogStatus.rateLimited": "Too many attempts. Try later.",
  "collaboration.dialogStatus.cancelled": "Join cancelled",
  "collaboration.toast.stillConfirming":
    "Still confirming. Check again in a moment.",
  "collaboration.toast.creationStopped":
    "The room wasn't finished. Try creating it again, or cancel it.",
  "collaboration.toast.enforcementPending":
    "Permissions updated. They may take a moment to apply.",
  "collaboration.toast.retryPrevious":
    "Your last change isn't confirmed yet. Retry it first.",
  "collaboration.management.unconfirmed": "Your last change wasn't confirmed.",
  "collaboration.toast.listSyncing":
    "The room may take a moment to appear in your list.",
  "collaboration.toast.existingRoom":
    "This scene already has a room. Opened it.",
  "collaboration.share.title": "Share room",
  "collaboration.room.name": "Room name",
  "collaboration.room.untitled": "Untitled room",
  "collaboration.room.nameHint":
    "Everyone you invite sees this name in their room list.",
  "collaboration.noAccess.title": "You don't have access to this room",
  "collaboration.noAccess.description":
    "Ask the owner for an invitation, or make sure you're signed in with the invited account.",
  "collaboration.accessRemoved.title": "Your access to this room was removed",
  "collaboration.accessRemoved.description":
    "To come back, ask the owner to invite you again.",
  "collaboration.roomEnded.title": "This room has ended or doesn't exist",
  "collaboration.roomEnded.description":
    "Check the link, or ask the person who shared it.",
  "collaboration.manage": "Manage room",
  "collaboration.people": "People",
  "collaboration.invite.email": "Email to invite",
  "collaboration.invite.invalid": "Enter a valid email address.",
  "collaboration.invite.placeholder": "Google account email",
  "collaboration.invite.role": "Role for the invitation",
  "collaboration.invite.submit": "Invite",
  "collaboration.person.joined": "Joined",
  "collaboration.person.joinedAt": "Joined {date}",
  "collaboration.person.viaLink": "Joined with the link",
  "collaboration.person.role": "Role for {name}",
  "collaboration.person.actions": "Actions for {name}",
  "collaboration.person.removeInvite": "Remove invitation",
  "collaboration.link.label": "Invite link",
  "collaboration.linkPermission": "Who can join with the link",
  "collaboration.allowlist.notJoined": "Not joined yet",
  "collaboration.members.first": "First page",
  "collaboration.members.next": "Next page",
  "collaboration.rooms.title": "Rooms",
  "collaboration.rooms.create": "New room",
  "collaboration.rooms.retry": "Try creating again",
  "collaboration.rooms.open": "Open room",
  "collaboration.rooms.hint":
    "Rooms you own, were invited to, or opened with a link.",
  "collaboration.rooms.unfinished": "Setup didn't finish.",
  "collaboration.rooms.copyLink": "Copy link",
  "collaboration.rooms.linkCopied": "Link copied.",
  "collaboration.rooms.copyFailed": "Couldn't copy the link.",
  "collaboration.rooms.end": "End room",
  "collaboration.rooms.endTitle": "End this room?",
  "collaboration.rooms.endDescription":
    "Everyone loses access and the content is deleted. This can't be undone.",
  "collaboration.rooms.endConfirm": "End room",
  "collaboration.rooms.creationCancelled": "Room creation cancelled.",
  "collaboration.rooms.ended": "You ended this room. Its content was deleted.",
  "collaboration.rooms.leave": "Leave room",
  "collaboration.rooms.leaveTitle": "Leave this room?",
  "collaboration.rooms.leaveDescription":
    "The room leaves your list. To return you'll need an invitation, unless anyone with the link can open it.",
  "collaboration.rooms.left": "You left the room.",
  "collaboration.rooms.loading": "Loading rooms",
  "collaboration.rooms.loadFailed": "Couldn't load rooms.",
  "collaboration.rooms.sceneLinked": "From a scene",
  "collaboration.rooms.mineHeading": "Owned and invited",
  "collaboration.rooms.emptyTitle": "No rooms yet",
  "collaboration.rooms.emptyHint":
    "Create a room here or from the editor's collaboration button, or open an invite link. It will show up here.",
  "collaboration.rooms.mineEmpty":
    "Rooms you create or are invited to appear here.",
  "collaboration.rooms.linkHeading": "Opened via link",
  "collaboration.rooms.linkEmpty":
    "Rooms you open from a shared link appear here.",
  "collaboration.rooms.invited": "Invited",
  "collaboration.rooms.removeFromList": "Remove from list",
  "collaboration.rooms.removed":
    "Removed from the list. Opening its link again brings it back.",
  "collaboration.action.end": "End room",
  "collaboration.action.leave": "Leave room",
  "collaboration.failure.unauthorized":
    "You no longer have access to this room. Ask the owner for a new invitation.",
  "collaboration.failure.noAccess":
    "You don't have access to this room. Ask the owner for an invitation, or make sure you're signed in with the invited account.",
  "collaboration.failure.roomEnded": "This room has ended or doesn't exist.",
  "collaboration.failure.protocolViolation":
    "The connection stopped unexpectedly. Reload the page; if it keeps happening, let us know.",
  "collaboration.failure.unsupportedProtocolVersion":
    "This tab is out of date. Refresh the page, then join again.",
  "collaboration.failure.retryLimit":
    "Reconnection failed repeatedly. Check your network and reload.",
  "collaboration.failure.rateLimited":
    "Too many attempts. Try again in a minute.",
  "collaboration.warning.unreadableAssets":
    "Some images cannot be opened right now. Other canvas content is still syncing; reload to try again.",
  "collaboration.warning.realtimeTooLarge":
    "Live sync stopped: the {size} canvas exceeds the {limit} send limit, so other members will not receive new changes.",
  "collaboration.warning.backupTooLarge":
    "Cloud backup stopped: the {size} canvas exceeds the {limit} room limit, so reloads and later joiners will see an older version.",
  "collaboration.warning.tooLargeAdvice":
    "Export a copy, then reduce the canvas to resume sync.",
  "collaboration.failure.invalidLink": "This collaboration link is invalid.",
  "collaboration.failure.cancelled":
    "Join cancelled. Your original canvas was not changed.",
  "collaboration.failure.saveBeforeJoin":
    "The current scene could not be saved, so the room was not joined. Try again.",
  "collaboration.failure.joinFailed":
    "Couldn't join. Check your connection and try again.",
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
  "dashboard.tabs.scenes": "My scenes",
  "dashboard.title": "Dashboard",
  "dashboard.recentlyModified": "Recently modified by you",
  "dashboard.yourScenes": "Your scenes",
  "dashboard.loading": "Loading",
  "dashboard.results": "Results",
  "dashboard.noScenesYet": "No scenes yet",
  "dashboard.noScenesYet.hint":
    "Draw something in the editor and save it to your scenes; it will show up here.",
  "dashboard.openEditor": "Open the editor",
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
  "dashboard.workspace.manage": "Workspace settings",
  "dashboard.workspace.createDialog.description":
    "Create a new workspace directly from the dashboard.",
  "dashboard.workspace.namePlaceholder": "Enter a workspace name",
  "dashboard.workspace.creating": "Creating",
  "dashboard.workspace.created": 'Workspace "{name}" created',
  "dashboard.workspace.createFailed": "Failed to create workspace",
  "dashboard.workspace.nameInvalid": "Please enter a valid workspace name",
  "workspace.settings.title": "Settings",
  "workspace.settings.general": "General",
  "workspace.settings.description":
    "Edit workspace information and manage dangerous actions.",
  "workspace.settings.defaultCannotDelete":
    "The default workspace can't be deleted.",
  "workspace.settings.deleteWarningBody":
    "This action is permanent. All scenes in this workspace will be lost.",
  "workspace.settings.typeToConfirm": 'Type "{name}" to confirm deletion:',
  "workspace.settings.confirmDelete": "Delete workspace",
  "workspace.settings.deleting": "Deleting",
  "workspace.settings.toast.updated": "Workspace updated",
  "workspace.settings.toast.updateFailed": "Failed to update workspace",
  "workspace.settings.toast.deleted": "Workspace deleted",
  "workspace.settings.toast.deleteFailed": "Failed to delete workspace",
  "workspace.settings.toast.missing":
    "This workspace no longer exists. Returning to the dashboard.",
  "workspace.settings.nameLabel": "Workspace name",
  "workspace.settings.save": "Save",
  "workspace.settings.saving": "Saving",
  "workspace.settings.dangerZone": "Danger zone",
  "workspace.settings.dangerDescription":
    "Deleting a workspace will permanently remove all its scenes.",
  "workspace.settings.deleteThisWorkspace": "Delete this workspace",
  "workspace.settings.defaultCannotDeleteShort":
    "Default workspace cannot be deleted.",
  "workspace.settings.currentCanvasWarningTitle":
    "This workspace contains the current canvas scene.",
  "workspace.settings.currentCanvasWarningBody":
    "Deleting it will also clear the current scene, local draft, and undo history.",
  "workspace.settings.collaborationBlocked":
    "Leave the collaboration room before deleting this workspace.",
  "search.placeholder": "Search scenes",
  "search.resultsCount": 'Loaded {count} results for "{query}"',
  "menu.importScene": "Open in editor",
  "menu.openScene.named": "Open {name} in the editor",
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
  "category.manage.sceneCountOne": "1 scene",
  "category.manage.rename": "Rename category",
  "category.manage.delete": "Delete category",
  "category.manage.deleteConfirm.description":
    'Are you sure you want to delete the category "{name}"? It will be removed from {count} scenes. The scenes themselves are not affected.',
  "category.manage.deleteConfirm.descriptionOne":
    'Are you sure you want to delete the category "{name}"? It will be removed from 1 scene. The scene itself is not affected.',
  "category.toast.created": 'Category "{name}" created',
  "category.toast.renamed": 'Category renamed to "{name}"',
  "category.toast.deleted": "Category deleted",
  "category.toast.duplicate": "A category with this name already exists.",
  "category.toast.failed": "Failed to update category. Please try again.",
  "category.toast.assignFailed":
    "Failed to update scene categories. Please try again.",
  "publish.badge.public": "Public",
  "publish.badge.private": "Private",
  "publish.menu.publish": "Set to public (anyone with the link can view)",
  "publish.menu.unpublish": "Set to private",
  "publish.menu.copyLink": "Copy public link",
  "publish.menu.openLink": "Open public link",
  "publish.toast.published":
    "Public link is ready. Anyone with the link can view it; public content is not encrypted.",
  "publish.toast.unpublished": "This scene is now private.",
  "publish.toast.copied": "Public link copied.",
  "publish.toast.failed": "Unable to update publish status. Please try again.",
  "publish.toast.preparing": "Rendering the public version",
  "publish.toast.renderFailed":
    "Unable to render the public version of this scene. Please try again.",
  "public.theme.light": "Switch to light theme",
  "public.theme.dark": "Switch to dark theme",
  "public.viewer.loading": "Loading scene",
  "public.viewer.goHome": "Go to drawstuff",
  "public.viewer.loadError": "Failed to load this published scene.",
  "public.viewer.zoomIn": "Zoom in",
  "public.viewer.zoomOut": "Zoom out",
  "public.viewer.fit": "Fit",
  "public.viewer.reset": "Reset",
  "public.viewer.handTool": "Hand: drag to pan (H)",
  "public.viewer.selectTool": "Select: drag to select text (V)",
  "public.viewer.hideUI": "Hide controls",
  "public.viewer.showUI": "Show controls",

  // Labels
  "labels.updatedTimeAgo": "Updated {time}",

  // Storage / Stats
  "stats.usedStorage": "Browser storage: {percent}% of {capacity}",

  // Images alt
  "images.bun.crying": "Crying bun",
  "images.bun.worried": "Worried bun",
  "images.bun.happy": "Happy bun",

  // Dialogs
  "dialog.delete.title": "Confirm delete",
  "dialog.delete.description":
    'Are you sure you want to delete the scene "{name}"? This action cannot be undone.',
  "buttons.delete": "Delete",
  "buttons.deleting": "Deleting",
  // Workspace
  "workspace.placeholder.search": "Find workspace",
  "buttons.save": "Save",
  "common.processing": "Processing",
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
  "share.scene.linkAccess":
    "Anyone with the link can view this version. Later edits won't appear.",
  "menu.moreOptions": "More options",
  "workspace.current": "Current workspace: {name}",
  "workspace.none": "None",
  "workspace.empty": "No workspace found.",
  "scene.change.title": "Switch scene?",
  "scene.change.description": "Save the current scene before switching?",
  "scene.change.save": "Save, then switch",
  "scene.change.discard": "Switch without saving",
  "scene.save.description":
    "Personal cloud saves are not end-to-end encrypted and are not automatically public.",
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
  "scene.conflict.load.title": "Discard my changes and load the latest version",
  "scene.conflict.save.title": "Save my changes as a new scene",
  "scene.conflict.keep.title": "Keep editing my version for now",
  "category.selector.placeholder": "Type or create a category",
  "category.selector.searching": "Searching",
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
  "toast.scene.deleted": "Deleted “{name}”.",
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
  "errors.failedToExportScene": "Failed to export scene. Try again.",
  "errors.exportInProgress": "An export is already in progress.",
  "errors.emptyCanvas": "An empty canvas cannot be exported.",
};
