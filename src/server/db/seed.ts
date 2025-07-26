import { db } from "./index";
import { user, project, category, drawing, drawingCategory } from "./schema";

export async function seed() {
  console.log("🌱 Seeding database...");

  // 創建測試用戶
  const testUser = await db
    .insert(user)
    .values({
      id: "test-user-1",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      image: "https://github.com/shadcn.png",
    })
    .returning();

  // 創建專案
  const projects = await db
    .insert(project)
    .values([
      {
        name: "Project 1",
        description: "First test project",
        userId: testUser[0].id,
      },
      {
        name: "Project 2",
        description: "Second test project",
        userId: testUser[0].id,
      },
      {
        name: "Project 3",
        description: "Third test project",
        userId: testUser[0].id,
      },
      {
        name: "Project 4",
        description: "Fourth test project",
        userId: testUser[0].id,
      },
      {
        name: "Project 5",
        description: "Fifth test project",
        userId: testUser[0].id,
      },
      {
        name: "Project 6",
        description: "Sixth test project",
        userId: testUser[0].id,
      },
    ])
    .returning();

  // 創建分類
  const categories = await db
    .insert(category)
    .values([
      { name: "Design" },
      { name: "Dashboard" },
      { name: "Analytics" },
      { name: "Development" },
      { name: "Component Library" },
      { name: "TypeScript" },
      { name: "Mobile" },
      { name: "E-commerce" },
      { name: "Payment Integration" },
      { name: "Chart" },
      { name: "Graph" },
      { name: "Business" },
      { name: "Social" },
      { name: "Social Media" },
      { name: "Post" },
      { name: "Schedule" },
    ])
    .returning();

  // 創建繪圖
  const drawings = await db
    .insert(drawing)
    .values([
      {
        name: "Modern Dashboard Design",
        description: "A clean and intuitive dashboard interface for analytics",
        image: "/placeholder.svg",
        projectId: projects[0].id,
        userId: testUser[0].id,
        lastUpdated: new Date("2024-01-15T10:30:00Z"),
      },
      {
        name: "React Component Library",
        description: "Reusable components built with TypeScript and Tailwind",
        image: "/placeholder.svg",
        projectId: projects[1].id,
        userId: testUser[0].id,
        lastUpdated: new Date("2024-01-14T14:22:00Z"),
      },
      {
        name: "Mobile App Prototype",
        description: "iOS and Android app design with smooth animations",
        image: "/placeholder.svg",
        projectId: projects[2].id,
        userId: testUser[0].id,
        lastUpdated: new Date("2024-01-13T09:15:00Z"),
      },
      {
        name: "E-commerce Platform",
        description: "Full-stack e-commerce solution with payment integration",
        image: "/placeholder.svg",
        projectId: projects[3].id,
        userId: testUser[0].id,
        lastUpdated: new Date("2024-01-12T16:45:00Z"),
      },
      {
        name: "Data Visualization Tool",
        description: "Interactive charts and graphs for business analytics",
        image: "/placeholder.svg",
        projectId: projects[4].id,
        userId: testUser[0].id,
        lastUpdated: new Date("2024-01-11T11:20:00Z"),
      },
      {
        name: "Social Media Manager",
        description: "Tool for scheduling and managing social media posts",
        image: "/placeholder.svg",
        projectId: projects[5].id,
        userId: testUser[0].id,
        lastUpdated: new Date("2024-01-10T13:30:00Z"),
      },
    ])
    .returning();

  // 建立繪圖與分類的關聯
  const categoryMap = new Map(categories.map((cat) => [cat.name, cat.id]));

  const drawingCategoryRelations = [
    // Modern Dashboard Design
    { drawingId: drawings[0].id, categoryId: categoryMap.get("Design")! },
    { drawingId: drawings[0].id, categoryId: categoryMap.get("Dashboard")! },
    { drawingId: drawings[0].id, categoryId: categoryMap.get("Analytics")! },

    // React Component Library
    { drawingId: drawings[1].id, categoryId: categoryMap.get("Development")! },
    {
      drawingId: drawings[1].id,
      categoryId: categoryMap.get("Component Library")!,
    },
    { drawingId: drawings[1].id, categoryId: categoryMap.get("TypeScript")! },

    // Mobile App Prototype
    { drawingId: drawings[2].id, categoryId: categoryMap.get("Mobile")! },

    // E-commerce Platform
    { drawingId: drawings[3].id, categoryId: categoryMap.get("E-commerce")! },
    {
      drawingId: drawings[3].id,
      categoryId: categoryMap.get("Payment Integration")!,
    },

    // Data Visualization Tool
    { drawingId: drawings[4].id, categoryId: categoryMap.get("Analytics")! },
    { drawingId: drawings[4].id, categoryId: categoryMap.get("Chart")! },
    { drawingId: drawings[4].id, categoryId: categoryMap.get("Graph")! },
    { drawingId: drawings[4].id, categoryId: categoryMap.get("Business")! },

    // Social Media Manager
    { drawingId: drawings[5].id, categoryId: categoryMap.get("Social")! },
    { drawingId: drawings[5].id, categoryId: categoryMap.get("Social Media")! },
    { drawingId: drawings[5].id, categoryId: categoryMap.get("Post")! },
    { drawingId: drawings[5].id, categoryId: categoryMap.get("Schedule")! },
  ];

  await db.insert(drawingCategory).values(drawingCategoryRelations);

  console.log("✅ Database seeded successfully!");
}

// 如果直接執行此檔案
if (require.main === module) {
  seed()
    .then(() => {
      console.log("Seed completed");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
