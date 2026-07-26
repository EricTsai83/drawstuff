"use client";

import Link from "next/link";
import {
  Languages,
  FilePlus2,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  PanelsTopLeft,
  Sun,
} from "lucide-react";
import { useRouter } from "next/navigation";

import { LanguageSelector } from "@/components/excalidraw/app-language/language-selector";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { authClient, signOut } from "@/lib/auth/client";
import { useSyncTheme, type UserChosenTheme } from "@/hooks/use-sync-theme";
import { useLanguagePreference } from "@/hooks/use-language-preference";
import { WorkspaceDropdown } from "@/components/workspace-dropdown";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { useSceneSession } from "@/hooks/scene-session-context";
import {
  dispatchOwnedNewScene,
  dispatchOwnedWorkspaceSwitch,
} from "@/lib/events";

const THEMES = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

export function OwnedWhiteboardProductMenu() {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const { userChosenTheme, setTheme } = useSyncTheme();
  const { langCode, handleLangCodeChange } = useLanguagePreference();
  const { workspaces, lastActiveWorkspaceId } = useWorkspaceOptions();
  const { currentWorkspaceId } = useSceneSession();

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Account</DropdownMenuLabel>
        {session ? (
          <>
            <div className="px-1.5 py-1">
              <WorkspaceDropdown
                defaultValue={currentWorkspaceId ?? lastActiveWorkspaceId}
                onChange={(workspace) =>
                  dispatchOwnedWorkspaceSwitch({
                    workspaceId: workspace.id,
                    workspaceName: workspace.name,
                  })
                }
                onCreateSuccess={(workspace) =>
                  dispatchOwnedWorkspaceSwitch({
                    workspaceId: workspace.id,
                    workspaceName: workspace.name,
                  })
                }
                options={workspaces}
                slim
              />
            </div>
            <DropdownMenuItem onClick={dispatchOwnedNewScene}>
              <FilePlus2 />
              New scene
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href="/dashboard" />}>
              <PanelsTopLeft />
              Open dashboard
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void signOut(() => {
                  router.refresh();
                })
              }
            >
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem render={<Link href="/login" />}>
            <LogIn />
            Sign in
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={userChosenTheme}
          onValueChange={(value) => setTheme(value as UserChosenTheme)}
        >
          {THEMES.map((theme) => (
            <DropdownMenuRadioItem key={theme.value} value={theme.value}>
              <theme.icon />
              {theme.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel className="flex items-center gap-2">
          <Languages />
          Language
        </DropdownMenuLabel>
        <div className="px-1.5 py-1">
          <LanguageSelector
            value={langCode}
            onValueChange={handleLangCodeChange}
          />
        </div>
      </DropdownMenuGroup>
    </>
  );
}
