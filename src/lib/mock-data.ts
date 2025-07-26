export type DrawingItem = {
  id: string;
  name: string;
  description: string;
  image: string;
  lastUpdated: Date;
  category: string[];
  projectName: string;
};

export const mockDrawingItems: DrawingItem[] = [
  {
    id: "1",
    name: "Modern Dashboard Design",
    description: "A clean and intuitive dashboard interface for analytics",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-15T10:30:00Z"),
    category: ["Design", "Dashboard", "Analytics"],
    projectName: "Project 1",
  },
  {
    id: "2",
    name: "React Component Library",
    description: "Reusable components built with TypeScript and Tailwind",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-14T14:22:00Z"),
    category: ["Development", "Component Library", "TypeScript"],
    projectName: "Project 2",
  },
  {
    id: "3",
    name: "Mobile App Prototype",
    description: "iOS and Android app design with smooth animations",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-13T09:15:00Z"),
    category: ["Mobile"],
    projectName: "Project 3",
  },
  {
    id: "4",
    name: "E-commerce Platform",
    description: "Full-stack e-commerce solution with payment integration",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-12T16:45:00Z"),
    category: ["E-commerce", "Payment Integration"],
    projectName: "Project 4",
  },
  {
    id: "5",
    name: "Data Visualization Tool",
    description: "Interactive charts and graphs for business analytics",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-11T11:20:00Z"),
    category: ["Analytics", "Chart", "Graph", "Business"],
    projectName: "Project 5",
  },
  {
    id: "6",
    name: "Social Media Manager",
    description: "Tool for scheduling and managing social media posts",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-10T13:30:00Z"),
    category: ["Social", "Social Media", "Post", "Schedule"],
    projectName: "Project 6",
  },
];
