import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    { id: "drawstuff", root: ".." },
    // <deepsec:projects-insert-above>
  ],
});
