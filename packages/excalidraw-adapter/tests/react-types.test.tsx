import type { ReactElement } from "react";
import { expect, it } from "vitest";

const createTypecheckedElement = (): ReactElement => (
  <div data-adapter-typecheck />
);

it("typechecks the React JSX surface used by future client entries", () => {
  expect(createTypecheckedElement().type).toBe("div");
});
