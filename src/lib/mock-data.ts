export type SceneItem = {
  id: string;
  name: string;
  description: string;
  image: string;
  lastUpdated: Date;
  category: string[];
  projectName: string;
};

export const mockSceneItems: SceneItem[] = [
  {
    id: "1",
    name: "Wireframe Design",
    description: "Homepage wireframe design",
    image: "/api/placeholder/300/200",
    lastUpdated: new Date("2024-01-15"),
    category: ["Design", "Wireframe"],
    projectName: "Website Redesign",
  },
  {
    id: "2",
    name: "User Flow Diagram",
    description: "User journey mapping",
    image: "/api/placeholder/300/200",
    lastUpdated: new Date("2024-01-14"),
    category: ["UX", "Flow"],
    projectName: "Mobile App",
  },
  {
    id: "3",
    name: "System Architecture",
    description: "Database schema design",
    image: "/api/placeholder/300/200",
    lastUpdated: new Date("2024-01-13"),
    category: ["Architecture", "Database"],
    projectName: "Backend System",
  },
];
