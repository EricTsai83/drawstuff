"use client";

import { forwardRef, useCallback, useMemo, useState } from "react";
import { Plus, SearchIcon } from "lucide-react";

import { authClient } from "@/lib/auth/client";
import { cn } from "@/lib/utils";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { InputGroupAddon } from "@/components/ui/input-group";
import { Separator } from "@/components/ui/separator";

export type Workspace = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

// 依優先 ID（selected / lastActive）將目標搬到陣列最前
function getSortedOptions(
  options: Workspace[],
  selectedId?: string,
  lastActiveId?: string,
) {
  if (options.length === 0) return [];
  const prioritizedId = selectedId ?? lastActiveId;
  if (!prioritizedId) return options;
  const idx = options.findIndex((option) => option.id === prioritizedId);
  if (idx <= 0) return options;
  return [options[idx]!, ...options.slice(0, idx), ...options.slice(idx + 1)];
}

type WorkspaceDropdownProps = {
  options?: Workspace[];
  onChange?: (workspace: Workspace) => void;
  value?: string;
  disabled?: boolean;
  slim?: boolean;
  // 顯示固定在清單頂端的完整建立流程入口
  onCreateAction?: () => void;
};

function WorkspaceDropdownComponent(
  {
    options = [],
    onChange,
    value,
    disabled = false,
    slim = false,
    onCreateAction,
  }: WorkspaceDropdownProps,
  ref: React.ForwardedRef<HTMLButtonElement>,
) {
  const { t } = useAppI18n();
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const { data: session } = authClient.useSession();
  const { lastActiveWorkspaceId } = useWorkspaceOptions();
  const sessionDisplayName = (session?.user?.name ?? "").trim();
  const sessionDefaultLabel = sessionDisplayName
    ? `${sessionDisplayName}'s workspace`
    : undefined;

  const normalizedQuery = searchValue.trim();
  const selectedWorkspace = useMemo(
    () => options.find((option) => option.id === value),
    [options, value],
  );
  const sortedOptions = useMemo(
    () =>
      getSortedOptions(
        options,
        selectedWorkspace?.id,
        lastActiveWorkspaceId,
      ).filter((option) => option.name.trim().length > 0),
    [options, selectedWorkspace?.id, lastActiveWorkspaceId],
  );

  const triggerLabel = selectedWorkspace?.name ?? sessionDefaultLabel ?? "";

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setSearchValue("");
  }, []);

  const handleSelect = useCallback(
    (workspace: Workspace | null) => {
      if (!workspace || workspace.id === selectedWorkspace?.id) return;
      onChange?.(workspace);
      handleOpenChange(false);
    },
    [handleOpenChange, onChange, selectedWorkspace?.id],
  );

  return (
    <Combobox
      items={sortedOptions}
      value={selectedWorkspace ?? null}
      open={open}
      onOpenChange={handleOpenChange}
      inputValue={searchValue}
      onInputValueChange={setSearchValue}
      onValueChange={handleSelect}
      itemToStringLabel={(workspace: Workspace) => workspace.name}
      itemToStringValue={(workspace: Workspace) => workspace.id}
      isItemEqualToValue={(workspace, selected) => workspace.id === selected.id}
      filter={(workspace: Workspace, query) => {
        const normalizedSearch = query.trim().toLocaleLowerCase();
        if (!normalizedSearch) return true;

        return [workspace.name, workspace.description ?? ""].some((text) =>
          text.toLocaleLowerCase().includes(normalizedSearch),
        );
      }}
      autoHighlight={false}
    >
      <ComboboxTrigger
        ref={ref}
        className={cn(
          "border-input ring-offset-background placeholder:text-muted-foreground flex h-8 w-full items-center justify-between gap-2 border-b-2 bg-transparent px-3 py-2 text-sm whitespace-nowrap hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 [&>svg:last-child]:size-3 [&>svg:last-child]:transition-transform [&>svg:last-child]:duration-300 data-popup-open:[&>svg:last-child]:rotate-180",
          "focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none",
          slim && "w-20",
        )}
        disabled={disabled}
        aria-label={t("workspace.current", {
          name: triggerLabel || (options[0]?.name ?? "") || t("workspace.none"),
        })}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {triggerLabel}
        </span>
      </ComboboxTrigger>

      <ComboboxContent
        side="bottom"
        className="w-(--anchor-width) min-w-(--anchor-width) p-0"
        data-prevent-outside-click
      >
        <ComboboxInput
          showTrigger={false}
          placeholder={t("workspace.placeholder.search")}
          aria-label={t("workspace.placeholder.search")}
          autoFocus
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          className="focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
        >
          <InputGroupAddon>
            <SearchIcon className="size-4 opacity-50" aria-hidden="true" />
          </InputGroupAddon>
        </ComboboxInput>

        {onCreateAction && normalizedQuery.length === 0 && (
          <>
            <div className="p-1">
              <Button
                type="button"
                variant="ghost"
                className="hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground w-full justify-start"
                onClick={() => {
                  handleOpenChange(false);
                  onCreateAction();
                }}
              >
                <Plus data-icon="inline-start" />
                <span>{t("dashboard.workspace.create")}</span>
              </Button>
            </div>
            <Separator />
          </>
        )}

        <ComboboxList
          className={cn(
            onCreateAction && normalizedQuery.length === 0
              ? "max-h-[160px] sm:max-h-[230px]"
              : "max-h-[200px] sm:max-h-[270px]",
          )}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          <ComboboxEmpty>{t("workspace.empty")}</ComboboxEmpty>
          <ComboboxGroup>
            <ComboboxCollection>
              {(option: Workspace) => {
                const isSelected = option.id === selectedWorkspace?.id;

                return (
                  <ComboboxItem
                    key={option.id}
                    value={option}
                    disabled={isSelected}
                    aria-current={isSelected ? "true" : undefined}
                    className={cn(
                      "min-h-8 items-center",
                      isSelected &&
                        "bg-accent text-accent-foreground data-disabled:opacity-100",
                    )}
                  >
                    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                      <span className="truncate font-medium">
                        {option.name}
                      </span>
                      {option.description && (
                        <span className="text-muted-foreground truncate text-xs">
                          {option.description}
                        </span>
                      )}
                    </div>
                  </ComboboxItem>
                );
              }}
            </ComboboxCollection>
          </ComboboxGroup>
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

WorkspaceDropdownComponent.displayName = "WorkspaceDropdownComponent";

export const WorkspaceDropdown = forwardRef(WorkspaceDropdownComponent);
