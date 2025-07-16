import { useI18n } from "@excalidraw/excalidraw";
import { WelcomeScreen } from "@excalidraw/excalidraw";
import React from "react";
import { Github } from "lucide-react";
import { THEME } from "@excalidraw/excalidraw";
import type { Theme } from "@excalidraw/excalidraw/element/types";

type AppWelcomeScreenProps = {
  theme: Theme;
};
function AppWelcomeScreen({ theme }: AppWelcomeScreenProps) {
  const { t } = useI18n();
  const headingContent = t("welcomeScreen.app.center_heading");

  return (
    <WelcomeScreen>
      <WelcomeScreen.Hints.MenuHint>
        {t("welcomeScreen.app.menuHint")}
      </WelcomeScreen.Hints.MenuHint>
      <WelcomeScreen.Hints.ToolbarHint />
      <WelcomeScreen.Hints.HelpHint />
      <WelcomeScreen.Center>
        <WelcomeScreen.Center.Logo>
          <h1
            className={`animate-flash-once inline-block ${
              theme === THEME.DARK ? "text-gray-300" : "text-indigo-500"
            }`}
          >
            EXcalidraw x Ericts
          </h1>
        </WelcomeScreen.Center.Logo>

        <WelcomeScreen.Center.Heading>
          {headingContent}
        </WelcomeScreen.Center.Heading>
        <WelcomeScreen.Center.Menu>
          <WelcomeScreen.Center.MenuItemLoadScene />
          <WelcomeScreen.Center.MenuItemHelp />

          <WelcomeScreen.Center.MenuItemLink
            href="https://github.com/EricTsai83/excalidraw-ericts"
            shortcut={null}
            icon={<Github size={16} />}
          >
            GitHub Repository
          </WelcomeScreen.Center.MenuItemLink>
        </WelcomeScreen.Center.Menu>
      </WelcomeScreen.Center>
    </WelcomeScreen>
  );
}

export default React.memo(AppWelcomeScreen);
