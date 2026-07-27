# @drawstuff/whiteboard

Internal whiteboard engine and React canvas for Drawstuff.

The package owns the portable whiteboard system:

- canonical document contracts and validation
- assets, clipboard, import, and export
- drawing, geometry, editing, input, history, and store
- Canvas 2D renderer and React canvas lifecycle
- Excalidraw-compatible light/dark rendering behavior

The Next.js app owns product integration:

- shadcn/Tailwind toolbars and dialogs
- authentication, persistence, sharing, and uploads
- routes, workspace state, and product-specific copy

Consumers import only the package root:

```ts
import {
  OwnedWhiteboardCanvas,
  type WhiteboardEngine,
} from "@drawstuff/whiteboard";
```

Do not import files below `src/` from the app. Add intentional public APIs to
`src/index.ts`.

## Checks

```sh
pnpm --filter @drawstuff/whiteboard typecheck
pnpm --filter @drawstuff/whiteboard test
```
