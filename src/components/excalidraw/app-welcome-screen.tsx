import { useI18n } from "@excalidraw/excalidraw";
import { WelcomeScreen } from "@excalidraw/excalidraw";
import React from "react";
import { LogIn } from "lucide-react";

function AppWelcomeScreen() {
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
        <WelcomeScreen.Center.Logo />
        <WelcomeScreen.Center.Heading>
          {headingContent}
        </WelcomeScreen.Center.Heading>
        <WelcomeScreen.Center.Menu>
          <WelcomeScreen.Center.MenuItemLoadScene />
          <WelcomeScreen.Center.MenuItemHelp />

          <WelcomeScreen.Center.MenuItemLink
            href="/login"
            shortcut={null}
            icon={<LogIn size={16} />}
          >
            Sign up
          </WelcomeScreen.Center.MenuItemLink>
        </WelcomeScreen.Center.Menu>
      </WelcomeScreen.Center>
    </WelcomeScreen>
  );
}

export default React.memo(AppWelcomeScreen);
