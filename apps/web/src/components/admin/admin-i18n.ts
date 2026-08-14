"use client";

import { useCallback } from "react";

import { useAppI18n } from "@/hooks/use-app-i18n";
import { formatPlaceholders, type PlaceholderValues } from "@/lib/i18n";

const en = {
  "role.admin": "Admin",
  "role.operator": "Operator",
  "role.user": "User",
  "navigation.backToCanvas": "Back to canvas",
  "navigation.backToOverview": "Back to admin overview",
  "overview.pageTitle": "Operations",
  "overview.title": "System overview",
  "overview.description":
    "Live operational data. Every change is recorded in the audit log.",
  "overview.loadFailed": "Unable to load the system overview: {message}",
  "stats.users": "Users",
  "stats.scenes": "Scenes",
  "stats.activeRooms": "Active rooms",
  "stats.pendingCleanup": "Pending cleanup",
  "users.title": "Users and permissions",
  "users.description":
    "Search by name, email, or Better Auth user ID. Up to 25 results are shown.",
  "users.searchLabel": "Search users",
  "users.searchPlaceholder": "Name, email, or user ID",
  "users.search": "Search",
  "users.loading": "Loading users…",
  "users.empty": "No matching users found.",
  "users.manage": "Manage",
  "audit.title": "Recent audit log",
  "audit.description":
    "The 30 most recent administrative changes, including failed attempts.",
  "audit.loading": "Loading audit log…",
  "audit.empty": "No audit events yet.",
  "audit.systemActor": "System / deleted account",
  "actor.id": "Signed-in administrator ID:",
  "table.user": "User",
  "table.permission": "Permission",
  "table.scenes": "Scenes",
  "table.activeRooms": "Active rooms",
  "table.actions": "Actions",
  "table.time": "Time",
  "table.action": "Action",
  "table.actor": "Actor",
  "table.target": "Target",
  "table.status": "Status",
  "table.name": "Name",
  "table.updatedAt": "Updated",
  "table.roomId": "Room ID",
  "table.expiresAt": "Expires",
  "user.pageTitle": "User management",
  "user.details": "Account details",
  "user.loading": "Loading account details…",
  "user.loadFailed": "Unable to load account",
  "user.emailVerified": "Email verified",
  "user.createdAt": "Created",
  "user.updatedAt": "Last updated",
  "user.grantSource": "Administrator grant source",
  "user.revokeAccess": "Revoke admin access",
  "user.grantAccess": "Grant admin access",
  "user.retireAccount": "Retire account",
  "scenes.title": "Scenes",
  "scenes.recent": "100 most recently updated",
  "scenes.empty": "No scenes.",
  "scenes.archived": "Archived",
  "scenes.published": "Published",
  "scenes.retireLabel": "Retire scene {name}",
  "rooms.title": "Owned collaboration rooms",
  "rooms.recent": "100 most recently updated",
  "rooms.empty": "No collaboration rooms.",
  "rooms.endLabel": "End room {id}",
  "confirm.typeTargetId": "Enter the target ID to confirm",
  "confirm.cancel": "Cancel",
  "confirm.grant.title": "Grant administrator access?",
  "confirm.grant.description":
    "The target must be a verified account linked to Google. The authorization is stored as a permanent ID-based grant.",
  "confirm.grant.action": "Grant access",
  "confirm.revoke.title": "Revoke administrator access?",
  "confirm.revoke.description":
    "The user will immediately lose access to the admin interface and admin API.",
  "confirm.revoke.action": "Revoke access",
  "confirm.retireAccount.title": "Permanently retire this account?",
  "confirm.retireAccount.description":
    "This ends its collaboration rooms and deletes scenes, assets, and sign-in data. This action cannot be undone.",
  "confirm.retireAccount.action": "Retire account",
  "confirm.retireScene.title": "Permanently retire this scene?",
  "confirm.retireScene.description":
    "The scene, collaboration data, and related external assets will enter the deletion process. This action cannot be undone.",
  "confirm.retireScene.action": "Retire scene",
  "confirm.endRoom.title": "End this collaboration room now?",
  "confirm.endRoom.description":
    "Existing authorization will be invalidated and the relay will receive a forced-disconnect command. Room history will be retained.",
  "confirm.endRoom.action": "End room",
  "toast.operationFailed": "The administrative action failed. Try again later.",
  "toast.grantSucceeded":
    "Administrator access granted. Access is bound to the immutable user ID.",
  "toast.revokeSucceeded": "Administrator access revoked.",
  "toast.sceneRetired": "The scene and related data entered retirement.",
  "toast.roomEnded":
    "The collaboration room ended and relay connections were forcibly closed.",
  "toast.roomEndedRelayUnconfirmed":
    "The collaboration room ended. Relay control was not immediately confirmed, but existing short-lived tokens are invalid.",
  "toast.accountRetired": "The account and its data were retired.",
  "status.active": "Active",
  "status.ended": "Ended",
  "status.started": "Started",
  "status.succeeded": "Succeeded",
  "status.failed": "Failed",
  "auditAction.grant-admin": "Grant administrator access",
  "auditAction.revoke-admin": "Revoke administrator access",
  "auditAction.retire-scene": "Retire scene",
  "auditAction.end-room": "End collaboration room",
  "auditAction.retire-account": "Retire account",
  "targetType.account": "Account",
  "targetType.scene": "Scene",
  "targetType.room": "Room",
} as const;

export type AdminTranslationKey = keyof typeof en;

const zhTW = {
  "role.admin": "管理員",
  "role.operator": "管理員",
  "role.user": "使用者",
  "navigation.backToCanvas": "回到畫布",
  "navigation.backToOverview": "返回管理總覽",
  "overview.pageTitle": "營運管理",
  "overview.title": "系統總覽",
  "overview.description": "即時營運資料；所有變更操作都會留下審計紀錄。",
  "overview.loadFailed": "無法載入系統總覽：{message}",
  "stats.users": "使用者",
  "stats.scenes": "場景",
  "stats.activeRooms": "進行中房間",
  "stats.pendingCleanup": "待清理物件",
  "users.title": "使用者與權限",
  "users.description":
    "以姓名、email 或 Better Auth 使用者 ID 搜尋。最多顯示 25 筆。",
  "users.searchLabel": "搜尋使用者",
  "users.searchPlaceholder": "姓名、email 或使用者 ID",
  "users.search": "搜尋",
  "users.loading": "載入使用者…",
  "users.empty": "找不到符合條件的使用者。",
  "users.manage": "管理",
  "audit.title": "最近審計紀錄",
  "audit.description": "最近 30 筆管理變更，包含失敗嘗試。",
  "audit.loading": "載入審計紀錄…",
  "audit.empty": "尚無審計紀錄。",
  "audit.systemActor": "系統／已刪除帳號",
  "actor.id": "登入管理者 ID：",
  "table.user": "使用者",
  "table.permission": "權限",
  "table.scenes": "場景",
  "table.activeRooms": "進行中房間",
  "table.actions": "操作",
  "table.time": "時間",
  "table.action": "操作",
  "table.actor": "執行者",
  "table.target": "目標",
  "table.status": "狀態",
  "table.name": "名稱",
  "table.updatedAt": "更新時間",
  "table.roomId": "房間 ID",
  "table.expiresAt": "到期時間",
  "user.pageTitle": "使用者管理",
  "user.details": "帳號詳細資料",
  "user.loading": "載入帳號資料…",
  "user.loadFailed": "無法載入帳號",
  "user.emailVerified": "Email 已驗證",
  "user.createdAt": "建立時間",
  "user.updatedAt": "最後更新",
  "user.grantSource": "管理權限來源",
  "user.revokeAccess": "撤銷管理權限",
  "user.grantAccess": "授予管理權限",
  "user.retireAccount": "退場帳號",
  "scenes.title": "場景",
  "scenes.recent": "最近更新的 100 筆",
  "scenes.empty": "沒有場景。",
  "scenes.archived": "已封存",
  "scenes.published": "已發佈",
  "scenes.retireLabel": "退場場景 {name}",
  "rooms.title": "擁有的協作房間",
  "rooms.recent": "最近更新的 100 筆",
  "rooms.empty": "沒有協作房間。",
  "rooms.endLabel": "結束房間 {id}",
  "confirm.typeTargetId": "輸入目標 ID 以確認",
  "confirm.cancel": "取消",
  "confirm.grant.title": "授予管理者權限？",
  "confirm.grant.description":
    "目標必須是已驗證、已連結 Google 的帳號。授權會寫入永久的 ID-based grant。",
  "confirm.grant.action": "授予權限",
  "confirm.revoke.title": "撤銷管理者權限？",
  "confirm.revoke.description":
    "這會立刻使該使用者無法再進入管理介面或呼叫管理 API。",
  "confirm.revoke.action": "撤銷權限",
  "confirm.retireAccount.title": "永久退場此帳號？",
  "confirm.retireAccount.description":
    "這會結束其協作房間、刪除場景與資產、移除登入資料。操作無法復原。",
  "confirm.retireAccount.action": "退場帳號",
  "confirm.retireScene.title": "永久退場此場景？",
  "confirm.retireScene.description":
    "場景、協作資料與相關外部資產都會進入刪除流程。此操作無法復原。",
  "confirm.retireScene.action": "退場場景",
  "confirm.endRoom.title": "立即結束此協作房間？",
  "confirm.endRoom.description":
    "現有授權會失效，Relay 會收到強制關閉指令。房間歷史紀錄會保留。",
  "confirm.endRoom.action": "結束房間",
  "toast.operationFailed": "管理操作失敗，請稍後再試。",
  "toast.grantSucceeded": "已授予管理者權限。管理權限綁定不可變的使用者 ID。",
  "toast.revokeSucceeded": "已撤銷管理者權限。",
  "toast.sceneRetired": "場景與相關資料已進入退場流程。",
  "toast.roomEnded": "協作房間已結束，Relay 連線也已強制關閉。",
  "toast.roomEndedRelayUnconfirmed":
    "協作房間已結束；Relay 控制未即時確認，既有短效權杖仍已失效。",
  "toast.accountRetired": "帳號與其資料已完成退場處理。",
  "status.active": "進行中",
  "status.ended": "已結束",
  "status.started": "處理中",
  "status.succeeded": "成功",
  "status.failed": "失敗",
  "auditAction.grant-admin": "授予管理者權限",
  "auditAction.revoke-admin": "撤銷管理者權限",
  "auditAction.retire-scene": "退場場景",
  "auditAction.end-room": "結束協作房間",
  "auditAction.retire-account": "退場帳號",
  "targetType.account": "帳號",
  "targetType.scene": "場景",
  "targetType.room": "房間",
} as const satisfies Record<AdminTranslationKey, string>;

const translations: Record<
  "en" | "zh-TW",
  Record<AdminTranslationKey, string>
> = {
  en,
  "zh-TW": zhTW,
};

export type AdminTranslate = (
  key: AdminTranslationKey,
  values?: PlaceholderValues,
) => string;

export function useAdminI18n() {
  // langCode 已由 I18nProvider 正規化為 app 支援語言，`<html lang>` 也由 provider 維護
  const { langCode } = useAppI18n();

  const t = useCallback<AdminTranslate>(
    (key, values) => formatPlaceholders(translations[langCode][key], values),
    [langCode],
  );

  return { t, langCode } as const;
}

const valueTranslationKeys = {
  status: {
    active: "status.active",
    ended: "status.ended",
    started: "status.started",
    succeeded: "status.succeeded",
    failed: "status.failed",
  },
  auditAction: {
    "grant-admin": "auditAction.grant-admin",
    "revoke-admin": "auditAction.revoke-admin",
    "retire-scene": "auditAction.retire-scene",
    "end-room": "auditAction.end-room",
    "retire-account": "auditAction.retire-account",
  },
  targetType: {
    account: "targetType.account",
    scene: "targetType.scene",
    room: "targetType.room",
  },
} as const satisfies Record<string, Record<string, AdminTranslationKey>>;

export function translateAdminValue(
  t: AdminTranslate,
  group: keyof typeof valueTranslationKeys,
  value: string,
): string {
  const keys = valueTranslationKeys[group] as Record<
    string,
    AdminTranslationKey | undefined
  >;
  const key = keys[value];
  return key ? t(key) : value;
}
