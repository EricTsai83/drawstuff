import { type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import type {
  user,
  session,
  account,
  verification,
  workspace,
  category,
  scene,
  sceneCategory,
} from "@/server/db/schema";

// User types
export type User = InferSelectModel<typeof user>;
export type NewUser = InferInsertModel<typeof user>;

// Session types
export type Session = InferSelectModel<typeof session>;
export type NewSession = InferInsertModel<typeof session>;

// Account types
export type Account = InferSelectModel<typeof account>;
export type NewAccount = InferInsertModel<typeof account>;

// Verification types
export type Verification = InferSelectModel<typeof verification>;
export type NewVerification = InferInsertModel<typeof verification>;

// Workspace types
export type Workspace = InferSelectModel<typeof workspace>;
export type NewWorkspace = InferInsertModel<typeof workspace>;

// Category types
export type Category = InferSelectModel<typeof category>;
export type NewCategory = InferInsertModel<typeof category>;

// Scene types
export type Scene = InferSelectModel<typeof scene>;
export type NewScene = InferInsertModel<typeof scene>;

export type SceneCategory = InferSelectModel<typeof sceneCategory>;
export type NewSceneCategory = InferInsertModel<typeof sceneCategory>;

// Relations
export type SceneWithRelations = Scene & {
  user?: User;
  workspace?: Workspace;
  sceneCategories?: SceneCategory[];
};

export type UserWithRelations = User & {
  sessions?: Session[];
  accounts?: Account[];
  workspaces?: Workspace[];
  scenes?: Scene[];
};

export type WorkspaceWithRelations = Workspace & {
  user?: User;
  scenes?: Scene[];
};

export type CategoryWithRelations = Category & {
  sceneCategories?: SceneCategory[];
};

// UI types
export type SceneItem = {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  workspaceId?: string;
  workspaceName?: string;
  thumbnail?: string;
  isArchived: boolean;
  categories: string[];
};

// Filter types
export type SceneFilters = {
  search?: string;
  workspaceId?: string;
  categoryId?: string;
  isArchived?: boolean;
  sortBy?: "name" | "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
};

// Stats types
export type SceneStats = {
  totalScenes: number;
  archivedScenes: number;
  recentScenes: Scene[];
};
