import { ExcalidrawWelcomeScreen as WelcomeScreen } from "@/features/whiteboard/adapters/excalidraw";
import { memo } from "react";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { DrawstuffLogo, Github } from "@/components/icons";

function AppWelcomeScreen() {
  const { t } = useStandaloneI18n();
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
          <div className="flex items-center gap-2">
            <DrawstuffLogo className="animate-flash-once inline-block h-8 w-8 text-indigo-500 dark:text-gray-300" />
            <h1 className="animate-flash-once inline-block pt-1 text-indigo-500 dark:text-gray-300">
              drawstuff
            </h1>
          </div>
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
            icon={<Github className="h-4 w-4" />}
          >
            GitHub Repository
          </WelcomeScreen.Center.MenuItemLink>
        </WelcomeScreen.Center.Menu>
      </WelcomeScreen.Center>
    </WelcomeScreen>
  );
}

export default memo(AppWelcomeScreen);
