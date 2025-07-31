import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import type {
  user,
  project,
  category,
  drawing,
  drawingCategory,
} from "@/server/db/schema";

// 從 schema 推導出的類型
export type User = InferSelectModel<typeof user>;
export type NewUser = InferInsertModel<typeof user>;

export type Project = InferSelectModel<typeof project>;
export type NewProject = InferInsertModel<typeof project>;

export type Category = InferSelectModel<typeof category>;
export type NewCategory = InferInsertModel<typeof category>;

export type Drawing = InferSelectModel<typeof drawing>;
export type NewDrawing = InferInsertModel<typeof drawing>;

export type DrawingCategory = InferSelectModel<typeof drawingCategory>;
export type NewDrawingCategory = InferInsertModel<typeof drawingCategory>;

// 擴展的類型，包含關聯資料
export type DrawingWithRelations = Drawing & {
  project?: Project;
  categories?: Category[];
  user?: User;
};

export type ProjectWithRelations = Project & {
  drawings?: Drawing[];
  user?: User;
};

export type CategoryWithRelations = Category & {
  drawings?: Drawing[];
};

// 與 mock-data.ts 相容的類型
export type DrawingItem = {
  id: string;
  name: string;
  description: string;
  image: string;
  lastUpdated: Date;
  category: string[];
  projectName: string;
};

// API 響應類型
export type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

// 查詢參數類型
export type DrawingFilters = {
  search?: string;
  categories?: string[];
  projectId?: string;
  userId?: string;
  sortBy?: "name" | "lastUpdated" | "createdAt";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

// 統計資料類型
export type DrawingStats = {
  totalDrawings: number;
  totalProjects: number;
  totalCategories: number;
  recentDrawings: Drawing[];
  popularCategories: Array<{
    category: Category;
    count: number;
  }>;
};
