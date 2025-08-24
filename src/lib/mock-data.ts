export type SceneItem = {
  id: string;
  name: string;
  description: string;
  image: string;
  lastUpdated: Date;
  category: string[];
  workspaceName: string;
};

export const mockSceneItems: SceneItem[] = [
  {
    id: "1",
    name: "Wireframe Design",
    description: "Homepage wireframe design",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-15"),
    category: ["Design", "Wireframe"],
    workspaceName: "Website Redesign",
  },
  {
    id: "2",
    name: "User Flow Diagram",
    description: "User journey mapping",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-14"),
    category: ["UX", "Flow"],
    workspaceName: "Mobile App",
  },
  {
    id: "3",
    name: "System Architecture",
    description: "Database schema design",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-13"),
    category: ["Architecture", "Database"],
    workspaceName: "Backend System",
  },
  {
    id: "4",
    name: "Wireframe Design",
    description: "Homepage wireframe design",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-15"),
    category: ["Design", "Wireframe"],
    workspaceName: "Website Redesign",
  },
  {
    id: "5",
    name: "User Flow Diagram",
    description: "User journey mapping",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-14"),
    category: ["UX", "Flow"],
    workspaceName: "Mobile App",
  },
  {
    id: "6",
    name: "System Architecture",
    description: "Database schema design",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-13"),
    category: ["Architecture", "Database"],
    workspaceName: "Backend System",
  },
];
